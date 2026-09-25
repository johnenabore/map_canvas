"use client"
import { useEffect, useRef, useState, type RefObject } from "react"
import { useTransformEffect } from "react-zoom-pan-pinch"
import { MAP, MAP_BLUR, LVL2, LVL3, POIS, type POI } from "@/lib/map"
import PoiPin from "./PoiPin"
import { MapSpaceAtmos } from "./Atmosphere"
import Birds from "./Birds"
import type { IntroLink } from "./Intro"

export default function MapContent({
  onPinTap,
  selectedId,
  atmos,
  onReady,
  introRef,
}: {
  onPinTap: (p: POI, at: { x: number; y: number }) => void
  selectedId: string | null // focus mode: data-focus on .map dims the other pins
  atmos: boolean
  onReady?: () => void
  introRef: RefObject<IntroLink>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef({ z: 0, lvl: "1" })
  const idle = useRef<number | undefined>(undefined)
  const moving = useRef(false)
  // MapShell's root (.map-shell): .moving goes there so it reaches the screen-space flicker too
  const shell = useRef<HTMLElement | null>(null)
  // layers that fade in with zoom; --z is written only on these, never on .map
  // (a var on .map invalidates style for the whole subtree every zoom frame)
  const fades = useRef<HTMLElement[] | null>(null)
  const img = useRef<HTMLImageElement>(null)
  const [ready, setReady] = useState(false)

  // Warm up before the first gesture: decode the SVG and promote the GPU layer now,
  // so the first zooms don't pay for decode + layer creation + texture upload mid-gesture.
  // The blur placeholder shows until then. One state change on load, not per frame.
  useEffect(() => {
    let alive = true
    const base = img.current
    if (!base) return
    base
      .decode()
      .catch(() => {}) // broken/unsupported decode: still reveal the img
      .then(() => {
        if (!alive) return
        // TransformComponent renders wrapper > content (transformed) > children, so .map's parent is the content element.
        // Cleared again by the debounced reset in useTransformEffect after the first gesture.
        const content = ref.current?.parentElement
        if (content) content.style.willChange = "transform"
        setReady(true)
        onReady?.() // the intro waits for this (plus the 300ms fade) before it starts
      })
    return () => {
      alive = false
    }
    // run once on mount; onReady is read when the decode settles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useTransformEffect(({ state, instance }) => {
    // --- smooth movement: GPU layer while moving ---
    const content = instance.contentComponent
    if (content) {
      if (content.style.willChange !== "transform") content.style.willChange = "transform"
      // .moving pauses all ambient animation (shadows, smoke, birds, flicker): 2 class writes per
      // gesture, not per frame
      shell.current ??= ref.current?.closest<HTMLElement>(".map-shell") ?? null
      const root = shell.current
      if (!moving.current) {
        moving.current = true
        root?.classList.add("moving")
      }
      clearTimeout(idle.current)
      idle.current = window.setTimeout(() => {
        content.style.willChange = "auto" // re-sharpen when stopped
        moving.current = false
        root?.classList.remove("moving")
      }, 400)
    }

    // --- zoom-level logic: write only when the value changed ---
    const el = ref.current
    if (!el) return
    const z = Math.round(state.scale * 100) / 100
    fades.current ??= Array.from(el.querySelectorAll<HTMLElement>(".fade"))
    if (fades.current.length > 0 && z !== last.current.z) {
      for (const f of fades.current) f.style.setProperty("--z", String(z))
      last.current.z = z
    }
    const lvl = z >= LVL3 ? "3" : z >= LVL2 ? "2" : "1"
    if (lvl !== last.current.lvl) {
      el.dataset.lvl = lvl
      last.current.lvl = lvl
    }
  })

  return (
    <div
      ref={ref}
      data-lvl="1"
      data-focus={selectedId ?? undefined}
      className="map relative"
      style={{
        height: "100dvh",
        aspectRatio: `${MAP.w} / ${MAP.h}`,
        backgroundImage: `url(${MAP_BLUR})`,
        backgroundSize: "100% 100%",
      }}
    >
      <img ref={img} src="/maps/protheka.min.svg" alt="" draggable={false}
        className={`layer transition-opacity duration-300 motion-reduce:transition-none ${ready ? "opacity-100" : "opacity-0"}`}
        fetchPriority="high" decoding="async" />
      {/* terrain/detail art not delivered yet
      <img src="/maps/terrain.svg" alt="" draggable={false} className="layer fade"
        style={{ opacity: "clamp(0, calc((var(--z, 1) - 1.5) * 2), 1)" }} />
      <img src="/maps/detail.svg" alt="" draggable={false} className="layer fade"
        style={{ opacity: "clamp(0, calc((var(--z, 1) - 3) * 2), 1)" }} />
      */}
      {/* after the base map, before the pins (see Atmosphere.tsx for why the order matters) */}
      {atmos && <MapSpaceAtmos />}
      {atmos && <Birds introRef={introRef} />}

      {POIS.map((p) => (
        <PoiPin key={p.id} poi={p} selected={p.id === selectedId} onTap={onPinTap} />
      ))}
    </div>
  )
}
