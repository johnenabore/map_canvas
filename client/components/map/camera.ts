import type { ReactZoomPanPinchContext } from "react-zoom-pan-pinch"
import { FOCUS, LVL2, LVL3, MAP, SHEET, type POI } from "@/lib/map"
import { clampToBounds } from "./SmoothWheel"

export type Flight = {
  done: Promise<"done" | "cancelled">
  cancel: () => void // stop where it is
  finish: () => void // jump to the end state
}
type Point = { x: number; y: number }
type FlyOptions = {
  focus?: Point            // viewport point (wrapper px) where the target should land; default: the centre
  onFrame?: (e: number) => void // eased progress 0..1, called before each camera write (the intro uses it)
  cancelOnInput?: boolean  // default true: a pointer/touch/wheel on the map cancels the flight
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

let active: Flight | null = null

// Mirrors react-zoom-pan-pinch 4.2.0's private handleCancelAnimation with the instance's public fields:
// stops a library animation that is still running (e.g. the glide after a flick) so it can't fight a flight.
function stopLibraryAnimation(instance: ReactZoomPanPinchContext) {
  if (instance.animationFrame !== null) cancelAnimationFrame(instance.animationFrame)
  instance.animationFrame = null
  instance.animation = null
  instance.isAnimating = false
  instance.velocity = null
  const resolve = instance.animationResolve
  instance.animationResolve = null
  resolve?.()
}

// Shared camera flight: puts the map point (xPct, yPct) at `focus` with `scale`, eased, clamped to the map
// bounds on every frame (same maths as SmoothWheel). The content point under the focus moves linearly and
// the scale geometrically, so zooming feels even; the clamped end state is computed first so the path
// lands exactly on it. Writes go through instance.setState, so useTransformEffect / KeepScale / clouds
// all follow. Only one flight at a time. durationMs 0 = instant jump (reduced motion).
export function flyTo(
  instance: ReactZoomPanPinchContext,
  xPct: number,
  yPct: number,
  scale: number,
  durationMs: number,
  opts: FlyOptions = {},
): Flight {
  active?.cancel()
  let settle: (r: "done" | "cancelled") => void = () => {}
  const done = new Promise<"done" | "cancelled">((res) => (settle = res))
  const wrapper = instance.wrapperComponent
  const content = instance.contentComponent
  if (!wrapper || !content) {
    settle("cancelled")
    return { done, cancel: () => {}, finish: () => {} }
  }
  stopLibraryAnimation(instance)

  const vw = wrapper.clientWidth
  const vh = wrapper.clientHeight
  const w = content.offsetWidth
  const h = content.offsetHeight
  const f = opts.focus ?? { x: vw / 2, y: vh / 2 }
  const s0 = instance.state.scale
  const s1 = Math.min(MAP.maxScale, Math.max(MAP.minScale, scale))
  const end = clampToBounds(instance, s1, f.x - (xPct / 100) * w * s1, f.y - (yPct / 100) * h * s1)
  // unscaled content point under the focus position, now and at the (clamped) end
  const c0 = { x: (f.x - instance.state.positionX) / s0, y: (f.y - instance.state.positionY) / s0 }
  const c1 = { x: (f.x - end.x) / s1, y: (f.y - end.y) / s1 }

  let raf = 0
  let over = false
  const apply = (e: number) => {
    opts.onFrame?.(e)
    if (e >= 1) {
      instance.setState(s1, end.x, end.y)
      return
    }
    const s = s0 * Math.pow(s1 / s0, e)
    const p = clampToBounds(instance, s, f.x - (c0.x + (c1.x - c0.x) * e) * s, f.y - (c0.y + (c1.y - c0.y) * e) * s)
    instance.setState(s, p.x, p.y)
  }

  const inputs = ["pointerdown", "touchstart", "wheel"] as const
  const stop = (result: "done" | "cancelled") => {
    if (over) return
    over = true
    cancelAnimationFrame(raf)
    for (const type of inputs) wrapper.removeEventListener(type, cancel, true)
    if (active === flight) active = null
    settle(result)
  }
  const cancel = () => stop("cancelled")
  const flight: Flight = {
    done,
    cancel,
    finish: () => {
      if (over) return
      apply(1)
      stop("done")
    },
  }
  active = flight

  // any gesture on the map takes over (capture: before the library's handlers and SmoothWheel). Only the
  // map wrapper: taps on the sheet or its prev/next buttons must not cancel the flight they started.
  if (opts.cancelOnInput !== false) {
    for (const type of inputs) wrapper.addEventListener(type, cancel, { capture: true, passive: true })
  }

  if (durationMs <= 0) {
    flight.finish()
    return flight
  }
  const t0 = performance.now()
  const tick = (now: number) => {
    if (over) return
    const t = (now - t0) / durationMs
    if (t >= 1) {
      flight.finish()
      return
    }
    apply(easeInOutCubic(t))
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return flight
}

// scale at which a pin appears (MapContent's data-lvl thresholds)
const LEVEL_SCALE: Record<POI["minLevel"], number> = { 1: MAP.minScale, 2: LVL2, 3: LVL3 }

// target zoom for opening a location: its kind's zoom, never below where its pin shows, never zooming out
export function focusScale(poi: POI, current: number) {
  return Math.min(MAP.maxScale, Math.max(current, FOCUS.zoom[poi.kind], LEVEL_SCALE[poi.minLevel]))
}

// centre of the part of the map the sheet/panel leaves visible: above the half-open sheet on phones,
// left of the side panel on desktop
export function visibleCentre(vw: number, vh: number, desktop: boolean): Point {
  return desktop
    ? { x: Math.max(vw - SHEET.panelPx, vw * 0.4) / 2, y: vh / 2 }
    : { x: vw / 2, y: (vh * (1 - SHEET.half)) / 2 }
}
