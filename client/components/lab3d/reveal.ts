// Shared reveal state and easing helpers for the /lab3d zoom-triggered detail reveal (the 3D counterpart of
// the 2D map's LOD tier reveal, lib/map.ts's LVL2/LVL3 + REVEAL, components/map/MapContent.tsx). These are
// plain mutable objects (not React state), written every frame by CameraRig (Scene.tsx) and read by
// Terrain.tsx and Pins.tsx -- consumers snapshot `focal` on their own edge-detect (a tier flipping on),
// they don't read it live mid-animation, so a reveal in progress doesn't drift if the user keeps panning.

// zoom progress, 0 at the "cover" framing .. 1 fully in; `reach` is the current camera footprint's
// world-space distance from its centre to its farthest ground corner, used to size the ink bloom so it
// grows to just cover what's on screen (CameraRig writes all of this every frame)
export const view = { t: 0, out: 0, reach: 1 }
// which tiers are currently "on" (hysteresis'd -- see CameraRig), read by Terrain and Pins alike
export const tier = { terrain: false, detail: false }
// the camera's look-at point on the ground, in plane UV (0..1, v down from the top edge) -- continuously
// the latest value; always current by construction (MapControls' own pivot), unlike 2D's discrete
// pointer-event capture, so no staleness window is needed here
export const focal = { u: 0.5, v: 0.5 }

export const smoothstep = (a: number, b: number, v: number) => {
  const x = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

// CSS cubic-bezier easing: time fraction -> progress (bisection on the curve's x), ported from
// MapContent.tsx's cubicBezier. Evaluated directly per frame here (no WAAPI keyframe precompute needed).
export function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number]) {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (x: number) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2
      if (at(mid, x1, x2) < x) lo = mid
      else hi = mid
    }
    return at((lo + hi) / 2, y1, y2)
  }
}

// A single animated value: set() starts it from `now` (ms, performance.now()-scale), update() advances it
// and returns whether it's still running. Reused for mix fades and bloom radii alike.
export class Tween {
  private from = 0
  private to = 0
  private startMs = 0
  private durationMs = 0
  private ease: (x: number) => number = (x) => x
  value = 0
  active = false

  set(from: number, to: number, durationMs: number, ease: (x: number) => number, nowMs: number) {
    this.from = from
    this.to = to
    this.startMs = nowMs
    this.durationMs = durationMs
    this.ease = ease
    this.value = from
    this.active = durationMs > 0
    if (durationMs <= 0) this.value = to
  }

  // advances to `nowMs`, returns true while still running (caller should keep invalidating)
  update(nowMs: number): boolean {
    if (!this.active) return false
    const t = Math.min(1, (nowMs - this.startMs) / this.durationMs)
    this.value = this.from + (this.to - this.from) * this.ease(t)
    if (t >= 1) this.active = false
    return this.active
  }
}
