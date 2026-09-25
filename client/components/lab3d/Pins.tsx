"use client"
import { useMemo, useRef, useState } from "react"
import { Html } from "@react-three/drei"
import { useFrame } from "@react-three/fiber"
import type * as THREE from "three"
import { MAP, POIS, REVEAL } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import { tier, focal } from "./reveal"

const W = MAP.w / 100
const H = MAP.h / 100

// height (0..1) at a map point, read from the same heightmap the terrain is displaced with (bilinear)
function sampler(image: CanvasImageSource & { width: number; height: number }) {
  const c = document.createElement("canvas")
  c.width = image.width
  c.height = image.height
  const ctx = c.getContext("2d", { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
  // 16-bit height: R = high byte, G = low byte
  const px = (x: number, y: number) => {
    const i = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4
    return (data[i] * 256 + data[i + 1]) / 65535
  }
  return (u: number, v: number) => {
    const x = u * (width - 1)
    const y = v * (height - 1)
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const top = px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx
    const bottom = px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx
    return top * (1 - fy) + bottom * fy
  }
}

// standing wax seal (the tip is the bottom-centre), 1.5x the viewBox, with a soft drop shadow so it lifts off the art
function Seal() {
  return (
    <svg viewBox="0 0 24 34" width={36} height={51} aria-hidden style={{ display: "block", filter: "drop-shadow(0 3px 3px rgba(20,8,2,.55))" }}>
      <path d="M7 17 L12 33 L17 17 Z" fill="#3f1d0e" />
      <circle cx="12" cy="11.5" r="10" fill="#3f1d0e" stroke="#9b8066" strokeWidth="0.8" />
      <circle cx="12" cy="11.5" r="6.8" fill="none" stroke="#9b8066" strokeWidth="1" />
      <path d="M12 6 L13.2 10.3 L17.5 11.5 L13.2 12.7 L12 17 L10.8 12.7 L6.5 11.5 L10.8 10.3 Z" fill="#e5d2b3" />
    </svg>
  )
}

// (re)start the stamp-in on an element: transform + opacity, delayed by its place in the queue. Ported
// from MapContent.tsx's stamp() -- reuses the same global CSS (@keyframes poi-stamp, .poi-pin.stamp,
// app/globals.css), unscoped there, so it works on any DOM node, including a drei <Html> pin here.
function stamp(el: HTMLElement, delayMs: number, durationMs: number) {
  el.classList.remove("stamp")
  el.style.animationDuration = `${durationMs}ms`
  el.style.animationDelay = `${delayMs}ms`
  void el.offsetWidth // restart cleanly if it was still stamping
  el.classList.add("stamp")
  el.addEventListener("animationend", () => el.classList.remove("stamp"), { once: true })
}

const worldX = (p: { x: number }) => (p.x / 100 - 0.5) * W
const worldZ = (p: { y: number }) => (p.y / 100 - 0.5) * H

// The three locations as screen-space seals standing on the displaced terrain; a tap shows the name. Pins
// past minLevel 1 stay hidden until their tier (terrain/detail) is "on" (lib/map.ts's tier reveal, ported
// via ./reveal), then stamp in nearest the camera's look-at point first -- the 3D counterpart of 2D's
// stampPins. scale = the terrain's displacementScale
export default function Pins({ heightMap, scale }: { heightMap: THREE.Texture; scale: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const heightAt = useMemo(() => sampler(heightMap.image as HTMLImageElement), [heightMap])
  const refs = useRef(new Map<string, HTMLButtonElement>())
  const prevTier = useRef({ terrain: false, detail: false })
  const reducedMotion = useReducedMotion()

  // `tier` is plain mutable state (reveal.ts), not React state, so nothing re-renders when it flips --
  // this drives visibility and the stamp-in imperatively, edge-detected each frame
  useFrame(() => {
    for (const [key, minLevel] of [["terrain", 2], ["detail", 3]] as const) {
      const on = tier[key]
      if (on === prevTier.current[key]) continue
      prevTier.current[key] = on
      const pois = POIS.filter((p) => p.minLevel === minLevel)
      if (on) {
        // nearest the focal point first, matching 2D's byDistance; the focal point is read once here (at
        // the transition), not re-read per pin while stamps stagger in
        const fx = (focal.u - 0.5) * W
        const fz = (focal.v - 0.5) * H
        const ordered = pois
          .map((p) => ({ p, d: Math.hypot(worldX(p) - fx, worldZ(p) - fz) }))
          .sort((a, b) => a.d - b.d)
        ordered.forEach(({ p }, i) => {
          const el = refs.current.get(p.id)
          if (!el) return
          el.style.visibility = "visible"
          el.style.pointerEvents = "auto"
          if (!reducedMotion) stamp(el, i * REVEAL.pinStaggerMs, REVEAL.pinStampMs)
        })
      } else {
        for (const p of pois) {
          const el = refs.current.get(p.id)
          if (!el) continue
          el.style.visibility = "hidden"
          el.style.pointerEvents = "none"
        }
      }
    }
  })

  // one stable ref-callback per pin (POIS is static): fires once per actual DOM mount, not per re-render,
  // so opening a pin's label (which re-renders this component) can't reset visibility set imperatively above
  const setRef = useMemo(() => {
    const fns = new Map<string, (el: HTMLButtonElement | null) => void>()
    for (const p of POIS) {
      fns.set(p.id, (el) => {
        if (!el) {
          refs.current.delete(p.id)
          return
        }
        refs.current.set(p.id, el)
        const show = p.minLevel === 1 || (p.minLevel === 2 && tier.terrain) || (p.minLevel === 3 && tier.detail)
        el.style.visibility = show ? "visible" : "hidden"
        el.style.pointerEvents = show ? "auto" : "none"
      })
    }
    return fns
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return POIS.map((p) => {
    const y = heightAt(p.x / 100, p.y / 100) * scale
    return (
      <Html key={p.id} position={[worldX(p), y, worldZ(p)]} zIndexRange={[20, 10]}>
        <div style={{ transform: "translate(-50%, -100%)" }} className="relative">
          <button
            ref={setRef.get(p.id)}
            type="button"
            aria-label={p.name}
            aria-expanded={open === p.id}
            onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
            className="poi-pin grid h-14 w-14 cursor-pointer place-items-end justify-items-center"
          >
            <Seal />
          </button>
          {open === p.id && (
            <span className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap rounded border border-[#9b8066] bg-[#f4efcf] px-2 py-0.5 text-[13px] font-semibold text-[#3f1d0e] shadow">
              {p.name}
            </span>
          )}
        </div>
      </Html>
    )
  })
}
