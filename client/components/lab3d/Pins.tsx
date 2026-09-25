"use client"
import { useMemo, useState } from "react"
import { Html } from "@react-three/drei"
import type * as THREE from "three"
import { MAP, POIS } from "@/lib/map"

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
  const px = (x: number, y: number) => data[(Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4] / 255
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

// small standing wax seal (the tip is the bottom-centre)
function Seal() {
  return (
    <svg viewBox="0 0 24 34" width={24} height={34} aria-hidden style={{ display: "block", filter: "drop-shadow(0 2px 2px rgba(20,8,2,.45))" }}>
      <path d="M7 17 L12 33 L17 17 Z" fill="#3f1d0e" />
      <circle cx="12" cy="11.5" r="10" fill="#3f1d0e" stroke="#9b8066" strokeWidth="0.8" />
      <circle cx="12" cy="11.5" r="6.8" fill="none" stroke="#9b8066" strokeWidth="1" />
      <path d="M12 6 L13.2 10.3 L17.5 11.5 L13.2 12.7 L12 17 L10.8 12.7 L6.5 11.5 L10.8 10.3 Z" fill="#e5d2b3" />
    </svg>
  )
}

// The three locations as screen-space seals standing on the displaced terrain; a tap shows the name.
// scale = the terrain's displacementScale
export default function Pins({ heightMap, scale }: { heightMap: THREE.Texture; scale: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const heightAt = useMemo(() => sampler(heightMap.image as HTMLImageElement), [heightMap])
  return POIS.map((p) => {
    const y = heightAt(p.x / 100, p.y / 100) * scale
    return (
      <Html key={p.id} position={[(p.x / 100 - 0.5) * W, y, (p.y / 100 - 0.5) * H]} zIndexRange={[20, 10]}>
        <div style={{ transform: "translate(-50%, -100%)" }} className="relative">
          <button
            type="button"
            aria-label={p.name}
            aria-expanded={open === p.id}
            onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
            className="grid h-11 w-11 cursor-pointer place-items-end justify-items-center"
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
