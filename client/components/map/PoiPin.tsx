"use client"
import { useRef } from "react"
import { KeepScale } from "react-zoom-pan-pinch"
import type { POI } from "@/lib/map"

// wax-seal rim: a circle with 14 soft scallops, built once at module load (viewBox units)
const SEAL_RIM = (() => {
  const cx = 16
  const cy = 15
  const pts: string[] = []
  for (let i = 0; i <= 84; i++) {
    const a = (i / 84) * Math.PI * 2
    const r = 12.4 + 0.9 * Math.cos(a * 14)
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`)
  }
  return `M${pts.join("L")}Z`
})()

// Ink/wax seal marker in the map palette. The tail's tip (16,44) is the bottom-centre of the
// 32x44 box, which sits on the POI point via the button's -translate-x-1/2 -translate-y-full.
function SealMarker() {
  return (
    <svg viewBox="0 0 32 44" width={32} height={44} aria-hidden className="block overflow-visible">
      {/* soft ink shadow where the tip meets the map */}
      <ellipse cx="16" cy="43.2" rx="5" ry="1.6" fill="#3f1d0e" opacity="0.35" />
      {/* tail */}
      <path d="M9.5 23 L16 44 L22.5 23 Z" fill="#3f1d0e" />
      {/* wax body + rim */}
      <path d={SEAL_RIM} fill="#3f1d0e" stroke="#9b8066" strokeWidth="0.8" />
      <circle cx="16" cy="15" r="8.6" fill="none" stroke="#9b8066" strokeWidth="1.2" />
      {/* pressed emblem: compass star, echoing the map's rose */}
      <path d="M16 8.2 L17.5 13.5 L22.8 15 L17.5 16.5 L16 21.8 L14.5 16.5 L9.2 15 L14.5 13.5 Z" fill="#e5d2b3" />
      <circle cx="16" cy="15" r="1.3" fill="#3f1d0e" />
      {/* wax sheen */}
      <path d="M8.4 10.6 A9.6 9.6 0 0 1 14 5.6" fill="none" stroke="#f4efcf" strokeWidth="1.3" strokeLinecap="round" opacity="0.45" />
    </svg>
  )
}

// A location pin. Taps are reported to MapShell (which flies the camera and opens the sheet) with the
// pin's screen point for the ink ripple. Focus mode: data-selected scales the seal up from its tip and
// fades in a warm glow behind it; the other pins dim (CSS, see globals.css).
export default function PoiPin({
  poi,
  selected,
  onTap,
}: {
  poi: POI
  selected: boolean
  onTap: (p: POI, at: { x: number; y: number }) => void
}) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const el = useRef<HTMLDivElement>(null)

  return (
    <div
      ref={el}
      id={`poi-${poi.id}`}
      data-min={poi.minLevel}
      data-selected={selected || undefined}
      className="poi absolute h-0 w-0"
      style={{ left: `${poi.x}%`, top: `${poi.y}%` }}
    >
      <KeepScale>
        <button
          aria-label={poi.name}
          aria-haspopup="dialog"
          aria-expanded={selected}
          onPointerDown={(e) => (start.current = { x: e.clientX, y: e.clientY })}
          onClick={(e) => {
            const s = start.current
            start.current = null
            // finger moved = it was a drag, not a tap (keyboard clicks have detail 0 and no pointer)
            if (e.detail !== 0 && s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 8) return
            navigator.vibrate?.(10)
            // the .poi anchor is a 0x0 box on the map point, i.e. the tip of the seal
            const r = el.current?.getBoundingClientRect()
            onTap(poi, r ? { x: r.left, y: r.top } : { x: e.clientX, y: e.clientY })
          }}
          // 44px tap target; press = slight squash toward the tip + brighter wax (no squash under reduced motion)
          className="poi-pin absolute left-0 top-0 grid h-11 w-11 -translate-x-1/2 -translate-y-full origin-bottom place-items-end justify-items-center transition-[scale,filter] duration-100 ease-out active:scale-90 active:brightness-125 motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <span className="poi-glow" aria-hidden />
          <span className="poi-seal">
            <SealMarker />
          </span>
          {/* desktop hover tooltip (CSS: fine pointers only) */}
          <span className="poi-tip" aria-hidden>
            {poi.name}
          </span>
        </button>
      </KeepScale>
    </div>
  )
}
