"use client"
import { useRef, type RefObject } from "react"
import { useTransformEffect, useTransformInit, type ReactZoomPanPinchState } from "react-zoom-pan-pinch"
import { ATMOS } from "@/lib/map"
import { ATMOS_DIR } from "./Atmosphere"
import type { IntroLink } from "./Intro"

const ASPECT = 512 / 320 // cloud texture width / height

// Where each cloud's centre sits at 1x zoom, as a fraction of the map (ex/ey; <0 or >1 = outside
// the frame). They hug the frame edges and corners, clear of the region names, the title banner,
// the top info panels and the settlement ribbons (checked against the art). size: width as a
// fraction of the map's height. The visible blob is ~80% x 55% of the texture.
const LAYOUT = [
  { ex: -0.1, ey: -0.06, size: 0.45, tex: 1, flip: false }, // top-left corner (outside the panels)
  { ex: -0.09, ey: 0.34, size: 0.42, tex: 3, flip: false }, // left edge, below "Pref"
  { ex: -0.04, ey: 0.57, size: 0.45, tex: 2, flip: false }, // left edge, open sea
  { ex: -0.03, ey: 1.0, size: 0.45, tex: 4, flip: true },   // bottom-left corner, clear of "Calyx"
  { ex: 0.46, ey: 1.06, size: 0.5, tex: 1, flip: false },   // under the compass rose
  { ex: 1.08, ey: 1.03, size: 0.45, tex: 3, flip: true },   // bottom-right corner, clear of "Prazn"
  { ex: 1.07, ey: 0.72, size: 0.45, tex: 2, flip: true },   // right edge, coast below "Osiris"
  { ex: 1.1, ey: 0.4, size: 0.42, tex: 4, flip: false },    // right edge, forest
  { ex: 1.1, ey: -0.06, size: 0.45, tex: 1, flip: true },   // top-right corner (outside the panels)
]
// the plane scales `parallax` x around the map centre, so invert that to get the anchor
const CLOUDS = LAYOUT.map((c) => ({
  ...c,
  fx: 0.5 + (c.ex - 0.5) / ATMOS.parallax,
  fy: 0.5 + (c.ey - 0.5) / ATMOS.parallax,
}))
const AVG_SIZE = CLOUDS.reduce((a, c) => a + c.size, 0) / CLOUDS.length

// intro cover state: clouds gathered toward the viewport centre (outermost at these fractions of the
// viewport) and grown until they overlap into a dense layer. Growth is capped: every cloud is its
// own GPU layer and a portrait phone would otherwise need ~4x (tens of MB of texture per cloud).
const COVER_SPREAD_X = 0.22
const COVER_SPREAD_Y = 0.3
const COVER_MAX_GROW = 2.8

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// Screen-space cloud layer that parts as you zoom in ("descending through the clouds").
// Lives outside TransformComponent; every cloud is its own compositor layer and only its
// transform / the container's opacity are written — directly, only when changed, no React state.
// The intro adds a cover value (introRef.current.cover, 1 -> 0) on top of the zoom-driven state.
export default function Clouds({ introRef }: { introRef: RefObject<IntroLink> }) {
  const box = useRef<HTMLDivElement>(null)
  const els = useRef<HTMLDivElement[]>([])
  // viewport + unscaled map size and the intro cover geometry, cached (re-measured on resize)
  const dims = useRef({ vw: 0, vh: 0, w: 0, h: 0, gx: 1, gy: 1, grow: 1 })
  const last = useRef({ visible: false, opacity: "", transforms: [] as string[] })

  const update = ({ scale: s, positionX: x, positionY: y }: ReactZoomPanPinchState) => {
    const root = box.current
    const { vw, vh, w, h, gx, gy, grow: coverGrow } = dims.current
    if (!root || !w) return
    const L = last.current
    const c = introRef.current.cover
    const k = clamp01((s - ATMOS.cloudFadeStart) / (ATMOS.cloudFadeEnd - ATMOS.cloudFadeStart))
    // fully faded: hide once, then this is one comparison per frame. visibility (not display:none)
    // keeps the layers, so zooming back out doesn't recreate + raster them mid-gesture.
    if (k >= 1 && c <= 0) {
      if (L.visible) {
        root.style.visibility = "hidden"
        L.visible = false
      }
      return
    }
    if (!L.visible) {
      root.style.visibility = "visible"
      L.visible = true
    }
    // intro and zoom combined by taking the max: dense (1) while covering, zoom-driven otherwise
    const opacity = Math.max(ATMOS.cloudOpacity * (1 - k * k * (3 - 2 * k)), c).toFixed(2)
    if (opacity !== L.opacity) {
      root.style.opacity = opacity
      L.opacity = opacity
    }
    // map point (unscaled px) under the viewport centre; clouds sit on a plane that scales
    // parallax x faster than the map, so panning moves them 1.15x and zooming spreads them outward
    const ux = (vw / 2 - x) / s
    const uy = (vh / 2 - y) / s
    const grow = 1 + ATMOS.cloudPush * k
    const m = s * ATMOS.parallax * grow
    // cover pulls every cloud toward the centre and grows it; as it falls to 0 they rush outward
    // to exactly their zoom-driven place, so the intro hands over without a jump
    const pullX = 1 + (gx - 1) * c
    const pullY = 1 + (gy - 1) * c
    const g = s * grow * (1 + (coverGrow - 1) * c)
    CLOUDS.forEach((cl, i) => {
      const el = els.current[i]
      if (!el) return
      const cw = cl.size * h
      const X = vw / 2 + (cl.fx * w - ux) * m * pullX - cw / 2
      const Y = vh / 2 + (cl.fy * h - uy) * m * pullY - cw / ASPECT / 2
      const t = `translate3d(${X.toFixed(1)}px,${Y.toFixed(1)}px,0) scale(${(cl.flip ? -g : g).toFixed(3)},${g.toFixed(3)})`
      if (t !== L.transforms[i]) {
        el.style.transform = t
        L.transforms[i] = t
      }
    })
  }

  // first layout (useTransformEffect only fires on change) + re-measure on resize/rotation
  useTransformInit(({ instance }) => {
    const measure = () => {
      const wrapper = instance.wrapperComponent
      const content = instance.contentComponent
      const root = box.current
      if (!wrapper || !content || !root) return
      const vw = wrapper.clientWidth
      const vh = wrapper.clientHeight
      const w = content.offsetWidth
      const h = content.offsetHeight
      // intro cover: pull factors so the outermost cloud (at 1x) lands at COVER_SPREAD of the
      // viewport, and a growth that makes the gathered blobs overlap edge to edge
      const restDx = Math.max(...CLOUDS.map((c) => Math.abs((c.fx - 0.5) * w * ATMOS.parallax)))
      const restDy = Math.max(...CLOUDS.map((c) => Math.abs((c.fy - 0.5) * h * ATMOS.parallax)))
      const gx = Math.min(1, (COVER_SPREAD_X * vw) / restDx)
      const gy = Math.min(1, (COVER_SPREAD_Y * vh) / restDy)
      const grow = Math.min(COVER_MAX_GROW, Math.max(1, Math.max(0.7 * vw, 1.2 * vh) / (AVG_SIZE * h)))
      dims.current = { vw, vh, w, h, gx, gy, grow }
      els.current = Array.from(root.children) as HTMLDivElement[]
      CLOUDS.forEach((c, i) => {
        const el = els.current[i]
        if (!el) return
        el.style.width = `${c.size * h}px`
        el.style.height = `${(c.size * h) / ASPECT}px`
      })
      last.current.transforms = [] // sizes changed: rewrite every transform
      update(instance.state)
    }
    measure()
    // the intro drives `cover` from its own loop and asks for a relayout when it jumps
    introRef.current.redraw = () => update(instance.state)
    window.addEventListener("resize", measure)
    return () => {
      introRef.current.redraw = () => {}
      window.removeEventListener("resize", measure)
    }
  })

  useTransformEffect(({ state }) => update(state))

  // starts hidden (CSS) until the first layout, so the server-rendered clouds never flash at the top-left
  return (
    <div ref={box} aria-hidden className="atmos-clouds">
      {CLOUDS.map((c, i) => (
        <div key={i} className="atmos-cloud" style={{ backgroundImage: `url(${ATMOS_DIR}/cloud-${c.tex}.webp)` }} />
      ))}
    </div>
  )
}
