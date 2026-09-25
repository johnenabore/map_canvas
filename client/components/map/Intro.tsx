"use client"
import { useRef, type RefObject } from "react"
import { useTransformInit } from "react-zoom-pan-pinch"
import { INTRO, POIS } from "@/lib/map"
import { clampToBounds } from "./SmoothWheel"

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

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

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
// clouds rush outward, the veil lifts and the camera settles on INTRO.targetPoi. One rAF loop writes
// the camera (instance.setState, clamped every frame), the veil opacity and the clouds' cover value;
// it stops when done. Any pointerdown/wheel/keydown jumps straight to the end state.
// Render only when atmosphere is on and there's no ?poi= deep link (MapShell decides).
export default function Intro({ introRef }: { introRef: RefObject<IntroLink> }) {
  const veilRef = useRef<HTMLDivElement>(null)

  useTransformInit(({ instance }) => {
    const link = introRef.current
    const veil = veilRef.current
    const wrapper = instance.wrapperComponent
    const content = instance.contentComponent
    if (!veil || !wrapper || !content || !shouldPlay()) return

    const poi = POIS.find((p) => p.id === INTRO.targetPoi) ?? POIS[0]
    // targetScale with the POI at the viewport centre, clamped exactly like SmoothWheel/the library bounds
    const endState = () => {
      const s = INTRO.targetScale
      const x = wrapper.clientWidth / 2 - (poi.x / 100) * content.offsetWidth * s
      const y = wrapper.clientHeight / 2 - (poi.y / 100) * content.offsetHeight * s
      return { s, ...clampToBounds(instance, s, x, y) }
    }

    let raf = 0
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
      cancelAnimationFrame(raf)
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
    // input during the intro: jump to the end state and hand over. Capture phase on window runs
    // before the library's mousedown/touchstart and SmoothWheel's wheel handler, so their gestures
    // start from the final transform and nothing is left animating against them.
    function skip() {
      if (done) return
      const end = endState()
      link.cover = 0
      instance.setState(end.s, end.x, end.y)
      finish()
    }

    const run = () => {
      const from = { s: instance.state.scale, x: instance.state.positionX, y: instance.state.positionY }
      const to = endState()
      const t0 = performance.now()
      const tick = (now: number) => {
        if (done) return
        const t = Math.min(1, (now - t0) / INTRO.durationMs)
        const e = easeInOutCubic(t)
        const s = from.s + (to.s - from.s) * e
        const p = clampToBounds(instance, s, from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e)
        link.cover = 1 - e // Clouds picks this up in the onChange fired by setState below
        const v = (1 - e).toFixed(3)
        if (v !== lastVeil) {
          veil.style.opacity = v
          lastVeil = v
        }
        instance.setState(s, p.x, p.y)
        if (t < 1) raf = requestAnimationFrame(tick)
        else finish()
      }
      raf = requestAnimationFrame(tick)
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
