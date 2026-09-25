import * as THREE from "three"
import { MAP } from "@/lib/map"

// ---- every tunable of the spike (world units: the map is MAP.w/100 x MAP.h/100 = 9.03 x 6.73) ----
export const LAB3D = {
  map: { w: MAP.w / 100, h: MAP.h / 100 },
  segments: [512, 382] as const,
  displacementScale: 0.12,   // world units at height 1.0; subtle, so lettering on the land doesn't warp
  reliefExaggeration: 3.5,   // shading slopes x this (normals come from the heightmap in the shader; the
                             // geometry keeps displacementScale). gen-3d's preview mirrors it.
  detailDisplacementScale: 0.014, // height-detail.png: fine bumps, ~1/8 of the base displacementScale
  world: 3,                  // world sea plane: square, this x the map width
  seaTilesAcrossMap: 8,      // sea-tile.webp repeats: must match gen-3d (4096px map / 512px tile)
  worldFade: [0.62, 0.98],   // world plane: opaque out to this fraction of its half-size, gone at the second (radial)
  fov: 40,
  // framing: the start "covers" the screen with the land's bounding box (public/maps/3d/land-bounds.json);
  // zooming out goes on to "contain": the whole box plus a sea margin in view, slightly tilted so the far sea
  // recedes into the fog (the world floating in the sea). Panning keeps the view inside the land box at cover
  // and closer, and the land inside the view at contain.
  minDistance: 1.1,          // max zoom-in
  pitch: [0.05, 0.85] as const, // rad from straight down: at cover -> fully zoomed in
  containPitch: 0.25,        // rad from straight down at contain (max zoom-out), easing into pitch[0] by cover
  containMargin: 0.12,       // sea around the land box at contain, x the box's width
  fog: [1.6, 3.2] as const,  // fog near/far, x the camera distance (tilted views fade into the background)
  containFog: [1.05, 1.15] as const, // the same at contain, easing into fog by cover: the far sea hazes over
  background: "#412511",
  // together they light flat ground at about the texture's own colour (slightly warm); the sun is high (58 deg
  // up), so slopes turned away shade gently instead of falling into long dark bands. gen-3d's preview mirrors it.
  sun: { color: "#fff0de", intensity: 1.8, position: [-7, 13.8, -5] as const }, // top-left of the map, high
  ambient: { color: "#f7f9ff", intensity: 1.61 },
  // screen-space light over the canvas, ported from the 2D map's ScreenAtmos (components/map/Atmosphere.tsx):
  // a dark vignette and a warm candle glow from the top-left, plain rgba gradients (static here, no flicker)
  vignette: 0.5,
  glow: { color: "255,208,150", opacity: 0.16 },
  cloudOpacity: 0.8,
  cloudFade: [0.3, 0.5] as const, // zoom progress: clouds fade from the first value, gone by the midpoint
  // x/y: fractions of the map (outside 0..1 = over the open sea), y height above the sea, size = width
  clouds: [
    { tex: 1, x: 0.03, y: 0.2, height: 0.45, size: 3.4, rot: 0.2 },
    { tex: 2, x: 0.97, y: 0.16, height: 0.6, size: 3.0, rot: -0.3 },
    { tex: 3, x: 0.06, y: 0.93, height: 0.35, size: 3.2, rot: 0.5 },
    { tex: 4, x: 0.95, y: 0.9, height: 0.5, size: 3.6, rot: -0.1 },
    { tex: 1, x: 0.52, y: 0.06, height: 0.3, size: 2.8, rot: 3.0 },
  ],
  // Zoom-triggered detail reveal (Terrain.tsx, Pins.tsx), the 3D counterpart of the 2D map's LVL2/LVL3 tiers
  // (lib/map.ts). terrainInT/detailInT are 2D's LVL2=1.8/LVL3=3.2 converted to this scene's zoom-progress
  // `t` (0 at the "cover" framing, 1 fully in at minDistance) by matching log-fraction of the 2D scale range
  // (MAP.minScale=1..maxScale=6): log(1.8)/log(6) ~= 0.33, log(3.2)/log(6) ~= 0.65.
  terrainInT: 0.33,
  detailInT: 0.65,
  tierHysteresis: 0.035, // shown at t >= level only hides again below (level - this), so it doesn't flicker
} as const

export const { w: W, h: H } = LAB3D.map
export const SEA = LAB3D.world * W

// colour textures in sRGB; heightmaps stay linear
export function srgb(tex: THREE.Texture | THREE.Texture[]) {
  for (const t of Array.isArray(tex) ? tex : [tex]) {
    if (t.colorSpace === THREE.SRGBColorSpace) continue
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    t.needsUpdate = true
  }
}
