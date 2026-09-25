"use client"
import { useControls } from "react-zoom-pan-pinch"
import { SHEET } from "@/lib/map"
import { requestMotionPermission, useTiltPermission } from "./tiltPermission"

// a phone tilting between two curved arrows
function TiltIcon() {
  return (
    <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="8.5" y="4" width="7" height="12" rx="1.5" transform="rotate(-15 12 10)" />
      <path d="M4.5 15.5a8.5 8.5 0 0 0 4 4.8" />
      <path d="M7 20.8l1.5-.5-.4-1.6" />
      <path d="M19.5 15.5a8.5 8.5 0 0 1-4 4.8" />
      <path d="M17 20.8l-1.5-.5.4-1.6" />
    </svg>
  )
}

// panelOpen: the desktop side panel covers the right edge, so the buttons slide left of it
export default function Controls({ panelOpen = false }: { panelOpen?: boolean }) {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  // "Enable motion" only while iOS still needs the permission (never on Android/desktop, with reduced
  // motion, ?atmos=0, or after the user declined once)
  const motion = useTiltPermission()
  const btn = "h-11 w-11 rounded border-2 border-[#3f1d0e] bg-[#e5d2b3] text-lg font-bold text-[#3f1d0e]"
  return (
    <div
      className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] right-3 flex flex-col gap-1 transition-transform duration-300 motion-reduce:transition-none"
      style={{ transform: panelOpen ? `translateX(-${SHEET.panelPx}px)` : undefined }}
    >
      {motion === "prompt" && (
        <button
          className={`${btn} mb-2 grid place-items-center`}
          aria-label="Enable motion (tilt the phone to move the clouds)"
          title="Enable motion"
          onClick={requestMotionPermission} // requestPermission() runs first, inside this tap
        >
          <TiltIcon />
        </button>
      )}
      <button className={btn} aria-label="Zoom in" onClick={() => zoomIn()}>+</button>
      <button className={btn} aria-label="Zoom out" onClick={() => zoomOut()}>−</button>
      <button className={btn} aria-label="Reset view" onClick={() => resetTransform()}>⟲</button>
    </div>
  )
}
