"use client"
import { useEffect, type RefObject } from "react"
import { TILT } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import {
  getTiltPermission,
  needsMotionPermission,
  setTiltPermission,
  storedMotionChoice,
  tiltPermissionError,
} from "./tiltPermission"

type Vec = { x: number; y: number }
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v))
const RAD = Math.PI / 180

// Screen rotation relative to the device's natural (portrait) orientation, in degrees clockwise:
// screen.orientation.angle, or window.orientation on older iOS (90 = device top to the left,
// -90 = device top to the right; normalised to 0/90/180/270).
function screenAngle(): { angle: number; source: string } {
  const a = screen.orientation?.angle
  if (typeof a === "number") return { angle: ((a % 360) + 360) % 360, source: "screen.orientation" }
  const legacy = (window as unknown as { orientation?: number }).orientation
  if (typeof legacy === "number") return { angle: ((legacy % 360) + 360) % 360, source: "window.orientation" }
  return { angle: 0, source: "none" }
}

// Device tilt -> screen-space tilt in degrees (x: right edge down = +, y: top edge toward you = +).
// Uses the physical "up" direction in device coordinates, derived from beta/gamma, instead of the Euler
// angles themselves: those flip near vertical (gamma jumps -90 -> +90 and beta by 180 when a phone held
// upright in landscape rocks past vertical), the up vector doesn't. For small tilts this equals the plain
// mapping: portrait x = gamma, y = beta; landscape 90 x = beta, y = -gamma; 270 x = -beta, y = gamma.
function screenTilt(beta: number, gamma: number, angle: number): Vec {
  const b = beta * RAD
  const g = gamma * RAD
  // up = R^T * (0, 0, 1) with R = Rz(alpha) Rx(beta) Ry(gamma) (W3C DeviceOrientation)
  const ux = -Math.sin(g) * Math.cos(b)
  const uy = Math.sin(b)
  const uz = Math.cos(g) * Math.cos(b)
  // device x/y axes -> screen X (right) / Y (up) for the current screen rotation
  const [sx, sy] =
    angle === 90 ? [-uy, ux] : angle === 180 ? [-ux, -uy] : angle === 270 ? [uy, -ux] : [ux, uy]
  return {
    x: Math.atan2(-sx, Math.hypot(sy, uz)) / RAD,
    y: Math.atan2(sy, uz) / RAD,
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
//
// iOS 13+ only delivers orientation events after DeviceOrientationEvent.requestPermission() was called
// from a user gesture. That happens from the "Enable motion" button in Controls (see tiltPermission.ts);
// here we listen from the start, so if events already flow (granted earlier) no button is shown.
// ?debug=tilt shows a small overlay with the permission state, raw angles and the current offsets.
export default function Tilt({ shellRef }: { shellRef: RefObject<HTMLDivElement | null> }) {
  const reduced = useReducedMotion()

  useEffect(() => {
    const root = shellRef.current
    if (!root) return
    const cleanups: (() => void)[] = []

    // ---- debug overlay (?debug=tilt): plain DOM, refreshed a few times a second, only when asked for
    const dbg = {
      mode: "starting",
      events: 0,
      lastEvent: 0,
      beta: NaN,
      gamma: NaN,
      angle: 0,
      angleSource: "",
      tilt: { x: NaN, y: NaN } as Vec,
      base: null as Vec | null,
      offsets: "",
    }
    if (new URLSearchParams(window.location.search).get("debug") === "tilt") {
      const el = document.createElement("pre")
      el.className = "tilt-debug"
      root.appendChild(el)
      const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1).padStart(6) : "     -")
      const render = () => {
        const age = dbg.lastEvent ? ((performance.now() - dbg.lastEvent) / 1000).toFixed(2) + "s ago" : "never"
        el.textContent = [
          `tilt debug`,
          `mode      ${dbg.mode}`,
          `permission ${getTiltPermission()}  api ${needsMotionPermission() ? "yes (iOS)" : "no"}  stored ${storedMotionChoice() || "-"}`,
          `error     ${tiltPermissionError() || "-"}`,
          `events    ${dbg.events}  last ${age}`,
          `beta/gamma ${f(dbg.beta)} ${f(dbg.gamma)}`,
          `angle     ${dbg.angle} (${dbg.angleSource || "-"})`,
          `tilt x/y  ${f(dbg.tilt.x)} ${f(dbg.tilt.y)}   base ${dbg.base ? f(dbg.base.x) + " " + f(dbg.base.y) : "calibrating"}`,
          `offsets   ${dbg.offsets || "-"}`,
          `paused    ${document.hidden ? "tab hidden" : root.classList.contains("moving") ? "map moving" : "no"}`,
        ].join("\n")
      }
      render()
      const timer = window.setInterval(render, 150)
      cleanups.push(() => {
        clearInterval(timer)
        el.remove()
      })
    }
    const cleanup = () => cleanups.forEach((c) => c())

    if (reduced) {
      dbg.mode = "off (prefers-reduced-motion)"
      return cleanup
    }
    const layers = Array.from(root.querySelectorAll<HTMLElement>("[data-tilt]")).map((el) => ({
      el,
      name: el.dataset.tilt ?? "",
      range: el.dataset.tilt === "clouds" ? TILT.cloudRange : el.dataset.tilt === "light" ? -TILT.lightRange : 0,
      last: "",
    }))
    if (layers.length === 0) {
      dbg.mode = "off (no tilt layers)"
      return cleanup
    }
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
      dbg.offsets = layers.map((l) => `${l.name} ${(cur.x * l.range).toFixed(1)},${(cur.y * l.range).toFixed(1)}px`).join("  ")
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
      dbg.mode = "mouse"
      setTiltPermission("not-needed")
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
      dbg.mode = "orientation"
      const iosPermission = needsMotionPermission()
      const calib: Vec[] = []
      let base: Vec | null = null
      let angle = NaN
      let lastT = 0
      const onOrient = (e: DeviceOrientationEvent) => {
        if (e.beta == null || e.gamma == null) return // no sensor (some desktops fire one empty event)
        dbg.events++
        dbg.lastEvent = performance.now()
        dbg.beta = e.beta
        dbg.gamma = e.gamma
        // events flowing = motion access granted (possibly earlier this session): no button needed
        if (iosPermission && getTiltPermission() !== "granted") setTiltPermission("granted")
        const { angle: a, source } = screenAngle()
        dbg.angle = a
        dbg.angleSource = source
        if (a !== angle) {
          // first reading, or the screen rotated: calibrate a fresh neutral
          angle = a
          base = null
          calib.length = 0
        }
        // while moving/hidden: ignore, and leave lastT stale so the first reading after re-centres
        // fully on the current pose (no jump from wherever the phone went meanwhile)
        if (paused()) return
        const s = screenTilt(e.beta, e.gamma, a)
        dbg.tilt = s
        if (!base) {
          calib.push(s)
          if (calib.length >= 8) {
            base = {
              x: calib.reduce((t, v) => t + v.x, 0) / calib.length,
              y: calib.reduce((t, v) => t + v.y, 0) / calib.length,
            }
          }
          dbg.base = base
          lastT = e.timeStamp
          return
        }
        const dt = lastT ? e.timeStamp - lastT : 16
        lastT = e.timeStamp
        // slowly re-centre on how the phone is being held, so a sustained tilt drifts back to neutral
        const r = 1 - Math.exp(-dt / (TILT.recenterSpeed * 1000))
        base.x += (s.x - base.x) * r
        base.y += (s.y - base.y) * r
        dbg.base = base
        // tilting right = eye moves left relative to the scene, so the near layers shift right
        aim((s.x - base.x) / TILT.maxTiltDeg, (s.y - base.y) / TILT.maxTiltDeg)
      }
      // Listen right away. On iOS nothing arrives until motion access is granted, so this doubles as a
      // probe: if events do arrive (granted earlier), there's nothing to ask; otherwise the "Enable
      // motion" button is offered (unless the user already declined it once).
      listen("deviceorientation", onOrient)
      if (iosPermission) {
        const probe = window.setTimeout(() => {
          if (dbg.events === 0) setTiltPermission(storedMotionChoice() === "denied" ? "denied" : "prompt")
        }, 1000)
        cleanups.push(() => clearTimeout(probe))
      } else {
        setTiltPermission("not-needed")
      }
    } else {
      dbg.mode = "off (no orientation API)"
      setTiltPermission("not-needed")
    }

    return () => {
      cancelAnimationFrame(raf)
      cleanup()
      for (const l of layers) l.el.style.transform = ""
      setTiltPermission("unknown") // tilt off: the button goes away too
    }
  }, [reduced, shellRef])

  return null
}
