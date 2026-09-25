"use client"
import { useEffect, type RefObject } from "react"
import { TILT } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"

type Vec = { x: number; y: number }
// iOS 13+ adds a static requestPermission() that isn't in the DOM typings
type OrientationEventCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> }

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v))

// device angles (beta = front/back, gamma = left/right, degrees) -> screen x/y for the current rotation
function toScreen(beta: number, gamma: number, angle: number): Vec {
  switch (((angle % 360) + 360) % 360) {
    case 90:
      return { x: beta, y: -gamma }
    case 180:
      return { x: -gamma, y: -beta }
    case 270:
      return { x: -beta, y: gamma }
    default:
      return { x: gamma, y: beta }
  }
}

// Depth tilt ("diorama"): shifts the screen-space layers marked [data-tilt] against the map. Clouds
// ("clouds", closest to the camera) shift the most; the candle glow ("light") shifts the other way so
// the light source seems to stay put. The map, pins and map-space layers never move with it (that
// would fight panning), and the wrappers are separate elements, so this never touches the transforms
// Clouds/Intro write. Input: device orientation on phones (calibrated to how the phone is held, slowly
// re-centred), pointer position on desktop. One rAF loop low-pass filters toward the target and stops
// once settled; transforms are written straight to the DOM (translate3d only), never React state.
// Input is ignored while the map is moving (.moving) or the tab is hidden.
export default function Tilt({ shellRef }: { shellRef: RefObject<HTMLDivElement | null> }) {
  const reduced = useReducedMotion()

  useEffect(() => {
    const root = shellRef.current
    if (reduced || !root) return
    const layers = Array.from(root.querySelectorAll<HTMLElement>("[data-tilt]")).map((el) => ({
      el,
      range: el.dataset.tilt === "clouds" ? TILT.cloudRange : el.dataset.tilt === "light" ? -TILT.lightRange : 0,
      last: "",
    }))
    if (layers.length === 0) return
    const maxRange = Math.max(1, ...layers.map((l) => Math.abs(l.range)))

    const cur: Vec = { x: 0, y: 0 }
    const target: Vec = { x: 0, y: 0 }
    let raf = 0
    let lastFrame = 0

    const write = () => {
      for (const l of layers) {
        const t = `translate3d(${(cur.x * l.range).toFixed(1)}px,${(cur.y * l.range).toFixed(1)}px,0)`
        if (t !== l.last) {
          l.el.style.transform = t
          l.last = t
        }
      }
    }
    // exponential low-pass toward the target; stops when within 0.05px so the loop is idle at rest
    const tick = (now: number) => {
      const dt = lastFrame ? Math.min(now - lastFrame, 100) : 16
      lastFrame = now
      const k = 1 - Math.exp(-dt / TILT.smoothing)
      cur.x += (target.x - cur.x) * k
      cur.y += (target.y - cur.y) * k
      const settled = Math.abs(target.x - cur.x) * maxRange < 0.05 && Math.abs(target.y - cur.y) * maxRange < 0.05
      if (settled) {
        cur.x = target.x
        cur.y = target.y
      }
      write()
      if (settled) {
        raf = 0
        lastFrame = 0
      } else {
        raf = requestAnimationFrame(tick)
      }
    }
    // new target in [-1, 1]; changes under 0.25px (sensor noise) are dropped so the loop can rest
    const aim = (x: number, y: number) => {
      x = clamp1(x)
      y = clamp1(y)
      if (Math.abs(x - target.x) * maxRange < 0.25 && Math.abs(y - target.y) * maxRange < 0.25) return
      target.x = x
      target.y = y
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const paused = () => document.hidden || root.classList.contains("moving")

    const cleanups: (() => void)[] = []
    const listen = <K extends keyof WindowEventMap>(
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      window.addEventListener(type, fn, opts)
      cleanups.push(() => window.removeEventListener(type, fn, opts))
    }

    if (window.matchMedia("(pointer: fine)").matches) {
      // desktop: pointer offset from the viewport centre. Cursor right = eye moves right, so the
      // near layers shift left. Ignored while a button is held (dragging the map).
      listen(
        "pointermove",
        (e) => {
          if (e.pointerType !== "mouse" || e.buttons !== 0 || paused()) return
          aim(-((e.clientX / window.innerWidth) * 2 - 1), -((e.clientY / window.innerHeight) * 2 - 1))
        },
        { passive: true },
      )
      const leave = () => aim(0, 0) // cursor left the window: ease back to neutral
      document.documentElement.addEventListener("mouseleave", leave)
      cleanups.push(() => document.documentElement.removeEventListener("mouseleave", leave))
    } else if ("DeviceOrientationEvent" in window) {
      const calib: Vec[] = []
      let base: Vec | null = null
      let angle = NaN
      let lastT = 0
      const onOrient = (e: DeviceOrientationEvent) => {
        if (e.beta == null || e.gamma == null) return // no sensor (some desktops fire one empty event)
        const a = screen.orientation?.angle ?? 0
        if (a !== angle) {
          // first reading, or the screen rotated: calibrate a fresh neutral
          angle = a
          base = null
          calib.length = 0
        }
        // while moving/hidden: ignore, and leave lastT stale so the first reading after re-centres
        // fully on the current pose (no jump from wherever the phone went meanwhile)
        if (paused()) return
        const s = toScreen(e.beta, e.gamma, a)
        if (!base) {
          calib.push(s)
          if (calib.length >= 8) {
            base = {
              x: calib.reduce((t, v) => t + v.x, 0) / calib.length,
              y: calib.reduce((t, v) => t + v.y, 0) / calib.length,
            }
          }
          lastT = e.timeStamp
          return
        }
        const dt = lastT ? e.timeStamp - lastT : 16
        lastT = e.timeStamp
        // slowly re-centre on how the phone is being held, so a sustained tilt drifts back to neutral
        const r = 1 - Math.exp(-dt / (TILT.recenterSpeed * 1000))
        base.x += (s.x - base.x) * r
        base.y += (s.y - base.y) * r
        // tilting right = eye moves left relative to the scene, so the near layers shift right
        aim((s.x - base.x) / TILT.maxTiltDeg, (s.y - base.y) / TILT.maxTiltDeg)
      }
      const start = () => listen("deviceorientation", onOrient)

      const Ctor = window.DeviceOrientationEvent as OrientationEventCtor
      if (typeof Ctor.requestPermission === "function") {
        // iOS 13+: permission must be requested inside a user gesture. touchend/click count as one
        // (pointerdown doesn't for touch), so the first tap on the map (e.g. the intro-skip tap) asks.
        // Denied or failed: do nothing.
        let asked = false
        const ask = () => {
          if (asked) return
          asked = true
          Ctor.requestPermission!()
            .then((state) => {
              if (state === "granted") start()
            })
            .catch(() => {})
        }
        listen("touchend", ask, { capture: true, passive: true })
        listen("click", ask, { capture: true })
      } else {
        start()
      }
    }

    return () => {
      cancelAnimationFrame(raf)
      cleanups.forEach((c) => c())
      for (const l of layers) l.el.style.transform = ""
    }
  }, [reduced, shellRef])

  return null
}
