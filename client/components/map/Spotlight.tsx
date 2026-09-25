"use client"
import { useEffect, useRef } from "react"
import {
  useTransformEffect,
  useTransformInit,
  type ReactZoomPanPinchContext,
  type ReactZoomPanPinchState,
} from "react-zoom-pan-pinch"
import { FOCUS, type POI } from "@/lib/map"

// Focus-mode spotlight: darkens the map around the open location. One promoted screen-space element,
// ~3x the viewport diagonal, with a static radial gradient (clear around the centre, FOCUS.spotlight dark
// beyond). It follows the pin through pans/zooms by rewriting only its translate3d from
// useTransformEffect, and only when the rounded value changes, so the map layer never repaints.
// Fades in/out with an opacity transition (CSS). Writes nothing while nothing is focused.
export default function Spotlight({ poi }: { poi: POI | null }) {
  const el = useRef<HTMLDivElement>(null)
  const inst = useRef<ReactZoomPanPinchContext | null>(null)
  const target = useRef<POI | null>(null) // kept through the fade-out so it doesn't jump
  const on = useRef(false)
  const geo = useRef({ vw: 0, vh: 0, w: 0, h: 0, size: 0, last: "" })

  const place = (s: ReactZoomPanPinchState) => {
    const node = el.current
    const p = target.current
    const g = geo.current
    if (!node || !p || !g.w) return
    // the pin's screen point, clamped so the oversized element always covers the whole viewport
    const half = g.size / 2
    const x = Math.min(half, Math.max(g.vw - half, s.positionX + (p.x / 100) * g.w * s.scale))
    const y = Math.min(half, Math.max(g.vh - half, s.positionY + (p.y / 100) * g.h * s.scale))
    const t = `translate3d(${(x - half).toFixed(1)}px,${(y - half).toFixed(1)}px,0)`
    if (t !== g.last) {
      node.style.transform = t
      g.last = t
    }
  }

  useTransformInit(({ instance }) => {
    inst.current = instance
    const measure = () => {
      const wrapper = instance.wrapperComponent
      const content = instance.contentComponent
      const node = el.current
      if (!wrapper || !content || !node) return
      const vw = wrapper.clientWidth
      const vh = wrapper.clientHeight
      const size = Math.ceil(3 * Math.hypot(vw, vh))
      const r = FOCUS.spotlightRadius * Math.min(vw, vh)
      geo.current = { vw, vh, w: content.offsetWidth, h: content.offsetHeight, size, last: "" }
      node.style.width = node.style.height = `${size}px`
      node.style.backgroundImage = `radial-gradient(circle at center, rgba(20,8,2,0) 0px, rgba(20,8,2,0) ${r.toFixed(0)}px, rgba(20,8,2,${FOCUS.spotlight}) ${(r * 2.6).toFixed(0)}px)`
      if (target.current) place(instance.state)
    }
    measure()
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  })

  // selection changed: aim at the new location (the old one stays as the target while fading out)
  useEffect(() => {
    on.current = poi !== null
    if (poi) target.current = poi
    if (poi && inst.current) place(inst.current.state)
  })

  useTransformEffect(({ state }) => {
    if (on.current) place(state)
  })

  return <div ref={el} aria-hidden data-on={poi ? "" : undefined} className="focus-spotlight" />
}
