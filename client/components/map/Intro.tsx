"use client"
import { useRef, type RefObject } from "react"
import { useTransformInit } from "react-zoom-pan-pinch"
import { INTRO, POIS } from "@/lib/map"
import { flyTo, type Flight } from "./camera"

const SEEN_KEY = "protheka-intro-seen"
const MAP_FADE_MS = 300 // MapContent's base-map fade-in (duration-300) — wait for it before the hold

// Mutable bag shared by MapShell's children (held in a ref: nothing here is React state).
export type IntroLink = {
  cover: number        // 1 = dense intro clouds, 0 = normal; Clouds reads it on every update
  redraw: () => void   // registered by Clouds: re-run its layout for the current transform
  ready: boolean       // map warm-up (decode + fade-in start) finished — set via MapContent onReady
  onReady: () => void  // registered by Intro while it waits for the warm-up
  playing: boolean     // true from the intro's start state until it finishes or is skipped (birds wait)
}
export const createIntroLink = (): IntroLink => ({
  cover: 0,
  redraw: () => {},
  ready: false,
  onReady: () => {},
  playing: false,
})

function shouldPlay() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false
  try {
    if (sessionStorage.getItem(SEEN_KEY)) return false
    sessionStorage.setItem(SEEN_KEY, "1") // committed: a reload mid-intro won't replay it
  } catch {
    // storage blocked (private mode etc.): play, we just can't remember it
  }
  return true
}

// "Arrive through the clouds": dense clouds + dark veil over the warmed-up map, a short hold, then
// clouds rush outward, the veil lifts and the camera settles on INTRO.targetPoi. The camera is the
// shared flyTo (clamped every frame); its onFrame drives the veil opacity and the clouds' cover value.
// Any pointerdown/wheel/keydown jumps straight to the end state.
// Render only when atmosphere is on and there's no ?poi= deep link (MapShell decides).
export default function Intro({ introRef }: { introRef: RefObject<IntroLink> }) {
  const veilRef = useRef<HTMLDivElement>(null)

  useTransformInit(({ instance }) => {
    const link = introRef.current
    const veil = veilRef.current
    if (!veil || !instance.wrapperComponent || !instance.contentComponent || !shouldPlay()) return

    const poi = POIS.find((p) => p.id === INTRO.targetPoi) ?? POIS[0]
    let flight: Flight | null = null
    let timer = 0
    let done = false
    let lastVeil = ""

    // start state: dense clouds over a dimmed map
    link.playing = true
    link.cover = 1
    link.redraw()
    veil.style.visibility = "visible"

    const stop = () => {
      done = true
      link.playing = false
      flight?.cancel()
      clearTimeout(timer)
      link.onReady = () => {}
      window.removeEventListener("pointerdown", skip, true)
      window.removeEventListener("wheel", skip, true)
      window.removeEventListener("keydown", skip, true)
    }
    const finish = () => {
      stop()
      link.cover = 0
      link.redraw()
      veil.style.display = "none" // never shown again: drop its layer
    }
    // the flight's per-frame hook: runs before each camera write, so Clouds picks up the new cover in
    // the onChange that setState fires
    const onFrame = (e: number) => {
      link.cover = 1 - e
      const v = (1 - e).toFixed(3)
      if (v !== lastVeil) {
        veil.style.opacity = v
        lastVeil = v
      }
    }
    // the intro flight doesn't cancel on input: the skip below finishes it instead
    const fly = (ms: number) =>
      flyTo(instance, poi.x, poi.y, INTRO.targetScale, ms, { onFrame, cancelOnInput: false })

    // input during the intro: jump to the end state and hand over. Capture phase on window runs
    // before the library's mousedown/touchstart and SmoothWheel's wheel handler, so their gestures
    // start from the final transform and nothing is left animating against them.
    function skip() {
      if (done) return
      if (flight) flight.finish()
      else fly(0) // not started yet: jump to the end state
      finish()
    }

    const run = () => {
      flight = fly(INTRO.durationMs)
      flight.done.then((result) => {
        if (result === "done") finish()
      })
    }

    const begin = () => {
      timer = window.setTimeout(run, MAP_FADE_MS + INTRO.holdMs)
    }
    if (link.ready) begin()
    else link.onReady = begin

    window.addEventListener("pointerdown", skip, { capture: true, passive: true })
    window.addEventListener("wheel", skip, { capture: true, passive: true })
    window.addEventListener("keydown", skip, { capture: true, passive: true })
    return stop
  })

  // screen-space veil between the map and the clouds; hidden (CSS) unless the intro plays
  return (
    <div
      ref={veilRef}
      aria-hidden
      className="atmos-intro-veil"
      style={{ backgroundColor: `rgba(20,8,2,${INTRO.dim})` }}
    />
  )
}
