"use client"
import type { CSSProperties } from "react"
import { AMBIENT, ATMOS, MAP } from "@/lib/map"

export const ATMOS_DIR = "/maps/atmos"

// burnt edge colour = the page background (#412511), so the map melts into it instead of ending in a hard rectangle
const burn = (a: number) => `rgba(65,37,17,${a})`

function edgeGradient(dir: string, size: number) {
  return `linear-gradient(${dir}, ${burn(ATMOS.edgeBurn)} 0%, ${burn(ATMOS.edgeBurn * 0.35)} ${size * 0.45}%, ${burn(0)} ${size}%)`
}
// top/bottom sizes are scaled by the aspect ratio so all four edges are equally wide on screen
const edgeX = ATMOS.edgeSize
const edgeY = (ATMOS.edgeSize * MAP.w) / MAP.h
const EDGES = [
  edgeGradient("to right", edgeX),
  edgeGradient("to left", edgeX),
  edgeGradient("to bottom", edgeY),
  edgeGradient("to top", edgeY),
].join(",")

// left/top/width in % of the map; drift direction comes from the atmos-drift-N class
const SHADOWS = [
  { left: 12, top: 18, width: 30 },
  { left: 55, top: 42, width: 34 },
  { left: 28, top: 58, width: 26 },
]

// volcano smoke: durations spread across durationS, phases staggered evenly, so the wisps never sync up
const { volcano: VOLCANO, smoke: SMOKE } = AMBIENT
const WISP_TEXTURES = 6 // wisp-1..6.webp from scripts/gen-atmosphere.mjs
const WISPS = Array.from({ length: SMOKE.count }, (_, i) => {
  const [min, max] = SMOKE.durationS
  const seconds = SMOKE.count > 1 ? min + ((max - min) * i) / (SMOKE.count - 1) : min
  return { seconds, delay: -(i / SMOKE.count) * seconds, tex: (i % WISP_TEXTURES) + 1, variant: (i % 2) + 1 }
})

// Paper grain, multiplied over the base map tier. Not promoted and painted right after the base, below
// every promoted layer, so the multiply happens inside the content layer's raster and costs nothing per
// frame. (Above the promoted terrain/detail tiers it would have to blend across composited layers, an
// extra full-screen pass every frame during gestures, so those tiers sit above the paper instead.)
export function MapPaper() {
  return (
    <div
      aria-hidden
      className="layer atmos-paper"
      style={{
        backgroundImage: `url(${ATMOS_DIR}/paper.webp)`,
        backgroundSize: `${ATMOS.paperTile}px`,
        opacity: ATMOS.paperOpacity,
      }}
    />
  )
}

// Map-space atmosphere above the map tiers: lives inside .map, moves with it. The burnt edges sit above
// the promoted terrain/detail tiers, so they're pre-promoted too (a static layer, rasterized once).
export function MapSpaceAtmos() {
  return (
    <>
      <div aria-hidden className="layer atmos-edges" style={{ backgroundImage: EDGES }} />
      <div aria-hidden className="layer atmos-shadows">
        {SHADOWS.map((s, i) => (
          <div
            key={i}
            className={`atmos-shadow atmos-drift-${i + 1}`}
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: `${s.width}%`,
              backgroundImage: `url(${ATMOS_DIR}/shadow-${i + 1}.webp)`,
              opacity: ATMOS.shadowOpacity,
              // alternate: one full back-and-forth loop = driftSeconds. Only the duration is inline;
              // name/play-state stay in CSS so the .moving pause and reduced-motion rules can win.
              animationDuration: `${ATMOS.driftSeconds[i] / 2}s`,
            }}
          />
        ))}
      </div>
      {/* bottom-centre of the box sits on the volcano; each wisp rises, drifts right, grows and fades
          on its own layer (transform + opacity only). Peak opacity is the group's static opacity. */}
      <div
        aria-hidden
        className="atmos-smoke"
        style={{ left: `${VOLCANO.x}%`, top: `${VOLCANO.y}%`, width: `${SMOKE.width}%`, opacity: SMOKE.opacity }}
      >
        {WISPS.map((w, i) => (
          <div
            key={i}
            className={`atmos-wisp atmos-wisp-${w.variant}`}
            style={{
              backgroundImage: `url(${ATMOS_DIR}/wisp-${w.tex}.webp)`,
              animationDuration: `${w.seconds}s`,
              animationDelay: `${w.delay.toFixed(2)}s`,
            }}
          />
        ))}
      </div>
    </>
  )
}

// warm candle tone for the top-left glow (amber, so it reads against the cream map)
const CANDLE = "255,208,150"

// Screen-space candlelight: a vignette whose shadows flicker, under a static warm glow at the top-left
// (the candle). Plain rgba gradients (no mix-blend-mode) so they never force the moving map to repaint;
// both are pre-promoted and rasterized once. The flicker drives the vignette, not the glow: on the cream
// map a dimming cream/amber glow is nearly invisible (a few levels), while the dark vignette easing back
// and returning reads clearly as the light's reach changing. The vignette sits in four nested wrappers
// whose opacity loops multiply: three slow, unrelated "breathing" loops (3.7s / 5.3s / 2.3s) plus a fast
// irregular one (0.9s) for the flame catching; together the shadows ease back by up to AMBIENT.flicker.
// Opacity only, so it runs on the compositor.
export function ScreenAtmos() {
  return (
    <>
      <div aria-hidden className="atmos-flicker atmos-flicker-a" style={{ "--flicker": String(AMBIENT.flicker) } as CSSProperties}>
        <div className="atmos-flicker atmos-flicker-b">
          <div className="atmos-flicker atmos-flicker-d">
            <div
              className="atmos-flicker atmos-flicker-c"
              style={{ backgroundImage: `radial-gradient(ellipse at center, rgba(20,8,2,0) 55%, rgba(20,8,2,${ATMOS.vignette}) 100%)` }}
            />
          </div>
        </div>
      </div>
      {/* depth-tilt wrapper (Tilt.tsx), oversized so the shifted glow never shows its edge; the vignette doesn't tilt */}
      <div aria-hidden data-tilt="light" className="atmos-tilt atmos-tilt-pad">
        <div
          className="atmos-screen"
          style={{ backgroundImage: `radial-gradient(ellipse at 0% 0%, rgba(${CANDLE},${ATMOS.light}) 0%, rgba(${CANDLE},0) 65%)` }}
        />
      </div>
    </>
  )
}
