"use client"
import { useControls } from "react-zoom-pan-pinch"
import { SHEET } from "@/lib/map"

// panelOpen: the desktop side panel covers the right edge, so the buttons slide left of it
export default function Controls({ panelOpen = false }: { panelOpen?: boolean }) {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const btn = "h-11 w-11 rounded border-2 border-[#3f1d0e] bg-[#e5d2b3] text-lg font-bold text-[#3f1d0e]"
  return (
    <div
      className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-3 flex flex-col gap-1 transition-transform duration-300 motion-reduce:transition-none"
      style={{ transform: panelOpen ? `translateX(-${SHEET.panelPx}px)` : undefined }}
    >
      <button className={btn} aria-label="Zoom in" onClick={() => zoomIn()}>+</button>
      <button className={btn} aria-label="Zoom out" onClick={() => zoomOut()}>−</button>
      <button className={btn} aria-label="Reset view" onClick={() => resetTransform()}>⟲</button>
    </div>
  )
}
