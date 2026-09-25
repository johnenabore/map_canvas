"use client"
import { Suspense, useLayoutEffect, useMemo, useRef, type ComponentRef } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { MapControls, useTexture } from "@react-three/drei"
import * as THREE from "three"
import { MAP } from "@/lib/map"
import LAND from "@/public/maps/3d/land-bounds.json" // npm run gen3d
import Pins from "./Pins"

// ---- every tunable of the spike (world units: the map is MAP.w/100 x MAP.h/100 = 9.03 x 6.73) ----
export const LAB3D = {
  map: { w: MAP.w / 100, h: MAP.h / 100 },
  segments: [512, 382] as const,
  displacementScale: 0.12,   // world units at height 1.0; subtle, so lettering on the land doesn't warp
  reliefExaggeration: 3.5,   // shading slopes x this (normals come from the heightmap in the shader; the
                             // geometry keeps displacementScale). gen-3d's preview mirrors it.
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
}

const { w: W, h: H } = LAB3D.map
const SEA = LAB3D.world * W
// zoom progress, 0 fully out .. 1 fully in; written by CameraRig every frame, read by the clouds (not React state)
const view = { t: 0 }
const smoothstep = (a: number, b: number, v: number) => {
  const x = Math.min(1, Math.max(0, (v - a) / (b - a)))
  return x * x * (3 - 2 * x)
}

// colour textures in sRGB; the heightmap stays linear
const srgb = (tex: THREE.Texture | THREE.Texture[]) => {
  for (const t of Array.isArray(tex) ? tex : [tex]) {
    if (t.colorSpace === THREE.SRGBColorSpace) continue
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    t.needsUpdate = true
  }
}

// Normals from the heightmap in the fragment shader, so there's no normal map: central differences of the
// 16-bit height (R = high byte, G = low byte), a texel apart (a screen pixel apart when zoomed out, via
// fwidth), as the normal of the flat-lying plane (u = +x, v = north = -z), then into view space.
function reliefNormals(heightMap: THREE.Texture) {
  const img = heightMap.image as { width: number; height: number }
  const slope = (LAB3D.displacementScale / (2 * (W / img.width))) * LAB3D.reliefExaggeration
  return (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.reliefMap = { value: heightMap }
    shader.uniforms.reliefTexel = { value: new THREE.Vector2(1 / img.width, 1 / img.height) }
    shader.uniforms.reliefSlope = { value: slope }
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D reliefMap;
uniform vec2 reliefTexel;
uniform float reliefSlope;
float reliefAt(vec2 uv) { vec4 t = texture2D(reliefMap, uv); return t.r * 0.996109 + t.g * 0.003891; }`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `vec2 reliefStep = max(reliefTexel, fwidth(vMapUv));
vec2 reliefK = reliefSlope * reliefTexel / reliefStep;
float reliefL = reliefAt(vMapUv - vec2(reliefStep.x, 0.0));
float reliefR = reliefAt(vMapUv + vec2(reliefStep.x, 0.0));
float reliefD = reliefAt(vMapUv - vec2(0.0, reliefStep.y));
float reliefU = reliefAt(vMapUv + vec2(0.0, reliefStep.y));
vec3 reliefN = normalize(vec3((reliefL - reliefR) * reliefK.x, 1.0, (reliefU - reliefD) * reliefK.y));
normal = normalize((viewMatrix * vec4(reliefN, 0.0)).xyz);`,
      )
  }
}

function Terrain() {
  const color = useTexture("/maps/3d/color.webp", srgb)
  const height = useTexture("/maps/3d/height.png")
  const onBeforeCompile = useMemo(() => reliefNormals(height), [height])
  return (
    <>
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[W, H, ...LAB3D.segments]} />
        <meshStandardMaterial
          map={color}
          displacementMap={height}
          displacementScale={LAB3D.displacementScale}
          onBeforeCompile={onBeforeCompile}
          roughness={1}
          metalness={0}
        />
      </mesh>
      <Pins heightMap={height} scale={LAB3D.displacementScale} />
    </>
  )
}

// The sea around the map: the same tile gen-3d paints into the map's sea margin, on the same grid (a tile
// boundary on the map's top-left corner), so map and sea meet without a seam. Drawn behind the map
// (polygon offset), fading out radially towards its edge so no rectangle ever shows.
function WorldSea() {
  const tile = useTexture("/maps/3d/sea-tile.webp", srgb)
  const repeat = (SEA / W) * LAB3D.seaTilesAcrossMap
  useLayoutEffect(() => {
    const a = (repeat * (SEA / 2 - W / 2)) / SEA // u at the map's left edge, in tiles
    const b = (repeat * (SEA / 2 + H / 2)) / SEA // v at the map's top edge, in tiles
    tile.wrapS = tile.wrapT = THREE.RepeatWrapping
    tile.repeat.set(repeat, repeat)
    tile.offset.set(Math.ceil(a) - a, Math.ceil(b) - b)
    tile.needsUpdate = true
  }, [tile, repeat])
  const alpha = useMemo(() => {
    const c = document.createElement("canvas")
    c.width = c.height = 256
    const ctx = c.getContext("2d")!
    const g = ctx.createRadialGradient(128, 128, 128 * LAB3D.worldFade[0], 128, 128, 128 * LAB3D.worldFade[1])
    g.addColorStop(0, "#fff")
    g.addColorStop(1, "#000")
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 256, 256)
    return new THREE.CanvasTexture(c)
  }, [])
  return (
    <mesh rotation-x={-Math.PI / 2}>
      <planeGeometry args={[SEA, SEA]} />
      <meshStandardMaterial map={tile} alphaMap={alpha} transparent depthWrite={false}
        polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={4} roughness={1} metalness={0} />
    </mesh>
  )
}

function Clouds() {
  const textures = useTexture([1, 2, 3, 4].map((i) => `/maps/atmos/cloud-${i}.webp`), srgb)
  const group = useRef<THREE.Group>(null)
  const materials = useRef<THREE.MeshBasicMaterial[]>([])
  useFrame(() => {
    const o = LAB3D.cloudOpacity * (1 - smoothstep(LAB3D.cloudFade[0], LAB3D.cloudFade[1], view.t))
    if (group.current) group.current.visible = o > 0.001
    for (const m of materials.current) if (m) m.opacity = o
  })
  return (
    <group ref={group}>
      {LAB3D.clouds.map((c, i) => {
        const tex = textures[c.tex - 1]
        const img = tex.image as { width: number; height: number }
        return (
          <mesh key={i} position={[(c.x - 0.5) * W, c.height, (c.y - 0.5) * H]} rotation={[-Math.PI / 2, 0, c.rot]} renderOrder={1}>
            <planeGeometry args={[c.size, (c.size * img.height) / img.width]} />
            <meshBasicMaterial ref={(m) => { if (m) materials.current[i] = m }} map={tex} transparent depthWrite={false}
              opacity={LAB3D.cloudOpacity} />
          </mesh>
        )
      })}
    </group>
  )
}

// Ground footprint of the view at distance d and pitch (rad from straight down), relative to the target: z of
// its far (top of the screen) and near (bottom) edges, and its half-width along the near edge, the narrowest.
// Only for pitch + half the fov < 90 deg (the far edge short of the horizon).
function footprint(pitch: number, d: number, tan: number, aspect: number) {
  const a = Math.atan(tan)
  const c = Math.cos(pitch)
  const s = Math.sin(pitch)
  return {
    far: d * (s - c * Math.tan(pitch + a)),
    near: d * (s - c * Math.tan(pitch - a)),
    halfWidth: (d * c * Math.cos(a) * tan * aspect) / Math.cos(pitch - a),
  }
}

// MapControls without rotation. The zoom runs from contain (max zoom-out: the land box plus a sea margin
// inside the tilted view) through cover (the start: the land box covers the top-down view, the tighter axis
// fits and the other overflows and pans) to minDistance, recomputed on resize/rotation. The pitch follows the
// zoom (slightly tilted at contain, straight down at cover, tilted when in), and so does the fog. Panning at
// cover and closer stops where the top-down view would leave the land box (tilted views may still see sea
// towards the horizon); at contain it stops where the land would leave the view; the limits blend between.
function CameraRig() {
  const controls = useRef<ComponentRef<typeof MapControls>>(null)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  const placed = useRef(false)
  const lim = useMemo(() => {
    const tan = Math.tan(((LAB3D.fov / 2) * Math.PI) / 180)
    const aspect = size.width / Math.max(1, size.height)
    const { x0, x1, z0, z1 } = LAND.world
    // cover: the view (top-down, 2 d tan x 2 d tan aspect) fits inside the land box on both axes
    const dCover = Math.max(LAB3D.minDistance * 1.5, Math.min((z1 - z0) / (2 * tan), (x1 - x0) / (2 * tan * aspect)))
    // contain: the land box plus the margin fits inside the view at containPitch on both axes
    const m = LAB3D.containMargin * (x1 - x0)
    const f = footprint(LAB3D.containPitch, 1, tan, aspect)
    const dContain = Math.max(dCover * 1.05, (z1 - z0 + 2 * m) / (f.near - f.far), (x1 - x0 + 2 * m) / (2 * f.halfWidth))
    // zoom state at camera distance d: t = 0 at cover .. 1 fully in (the clouds read it), out = 0 at cover ..
    // 1 at contain. The pitch and the fog ease from their contain values into their cover values (flat there),
    // then the pitch follows the in-curve.
    const zoom = (d: number) => {
      const t = Math.min(1, Math.max(0, Math.log(dCover / d) / Math.log(dCover / LAB3D.minDistance)))
      const out = Math.min(1, Math.max(0, Math.log(d / dCover) / Math.log(dContain / dCover)))
      const e = smoothstep(0, 1, out)
      const pitch = LAB3D.pitch[0] + (LAB3D.pitch[1] - LAB3D.pitch[0]) * t + (LAB3D.containPitch - LAB3D.pitch[0]) * e
      const fog = LAB3D.fog.map((v, i) => v + (LAB3D.containFog[i] - v) * e)
      return { t, out, pitch, fog }
    }
    return { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, tan, aspect, dCover, dContain, zoom }
  }, [size.width, size.height])

  useLayoutEffect(() => {
    const ctl = controls.current
    if (!ctl) return
    if (placed.current) {
      // resized / rotated: maxDistance has the new contain distance; update() pulls the camera in if needed
      ctl.update()
      invalidate()
      return
    }
    placed.current = true
    // start at cover, centred on the land (?zoom=-1..1 and ?at=x,y in map % pick another start: -1 = contain,
    // 0 = cover, 1 = fully in)
    const q = new URLSearchParams(window.location.search)
    const z = Math.min(1, Math.max(-1, Number(q.get("zoom") ?? 0) || 0))
    const at = q.get("at")?.split(",").map(Number)
    const d = lim.dCover * Math.pow(z < 0 ? lim.dContain / lim.dCover : LAB3D.minDistance / lim.dCover, Math.abs(z))
    const { pitch } = lim.zoom(d)
    const tx = at && at.length === 2 ? (at[0] / 100 - 0.5) * W : lim.cx
    const tz = at && at.length === 2 ? (at[1] / 100 - 0.5) * H : lim.cz
    ctl.target.set(tx, 0, tz)
    camera.position.set(tx, d * Math.cos(pitch), tz + d * Math.sin(pitch))
    ctl.minPolarAngle = ctl.maxPolarAngle = pitch
    ctl.update()
    invalidate()
  }, [lim, camera, invalidate])

  useFrame(() => {
    const ctl = controls.current
    if (!ctl) return
    const d = camera.position.distanceTo(ctl.target)
    const { t, out, pitch, fog } = lim.zoom(d)
    view.t = t
    if (Math.abs(ctl.minPolarAngle - pitch) > 1e-4) {
      ctl.minPolarAngle = ctl.maxPolarAngle = pitch
      ctl.update()
    }
    // pan limit: the target's range on each axis (a range that doesn't fit collapses to its middle). At cover
    // and closer the top-down view at this distance (half extents d tan, d tan aspect) stays inside the land box...
    const range = (lo: number, hi: number) => (lo > hi ? [(lo + hi) / 2, (lo + hi) / 2] : [lo, hi])
    const hz = d * lim.tan
    const hx = hz * lim.aspect
    let rx = range(lim.x0 + hx, lim.x1 - hx)
    let rz = range(lim.z0 + hz, lim.z1 - hz)
    if (out > 0) {
      // ...at contain the land box stays inside the tilted view, with the view's centre over the land
      const f = footprint(pitch, d, lim.tan, lim.aspect)
      const cx = range(Math.max(lim.x0, lim.x1 - f.halfWidth), Math.min(lim.x1, lim.x0 + f.halfWidth))
      const cz = range(Math.max(lim.z0, lim.z1 - f.near), Math.min(lim.z1, lim.z0 - f.far))
      rx = rx.map((v, i) => v + (cx[i] - v) * out)
      rz = rz.map((v, i) => v + (cz[i] - v) * out)
    }
    const tx = Math.min(rx[1], Math.max(rx[0], ctl.target.x))
    const tz = Math.min(rz[1], Math.max(rz[0], ctl.target.z))
    if (tx !== ctl.target.x || tz !== ctl.target.z) {
      const dx = tx - ctl.target.x
      const dz = tz - ctl.target.z
      ctl.target.x = tx
      ctl.target.z = tz
      camera.position.x += dx
      camera.position.z += dz
    }
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = d * fog[0]
      scene.fog.far = d * fog[1]
    }
  })

  return (
    <MapControls
      ref={controls}
      makeDefault
      enableRotate={false}
      enableDamping
      dampingFactor={0.12}
      zoomToCursor
      minDistance={LAB3D.minDistance}
      maxDistance={lim.dContain}
    />
  )
}

export default function Scene() {
  return (
    <div className="fixed inset-0" style={{ background: LAB3D.background }}>
      <Canvas
        dpr={[1, 2]}
        frameloop="demand"
        flat // no tone mapping: keep the parchment colours as drawn
        camera={{ fov: LAB3D.fov, near: 0.05, far: 200, position: [0, 20, 1] }}
      >
        <color attach="background" args={[LAB3D.background]} />
        <fog attach="fog" args={[LAB3D.background, 40, 80]} />
        <ambientLight color={LAB3D.ambient.color} intensity={LAB3D.ambient.intensity} />
        <directionalLight color={LAB3D.sun.color} intensity={LAB3D.sun.intensity} position={[...LAB3D.sun.position]} />
        <Suspense fallback={null}>
          <WorldSea />
          <Terrain />
          <Clouds />
        </Suspense>
        <CameraRig />
      </Canvas>
      {/* screen-space light (over the canvas, under the pins and the title) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: `radial-gradient(ellipse at center, rgba(20,8,2,0) 55%, rgba(20,8,2,${LAB3D.vignette}) 100%)` }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: `radial-gradient(ellipse at 0% 0%, rgba(${LAB3D.glow.color},${LAB3D.glow.opacity}) 0%, rgba(${LAB3D.glow.color},0) 65%)` }}
      />
      {/* replaces the removed title cartouche: a dark pill, readable over any part of the map (the tracking
          also trails the last letter, so the extra left padding re-centres the text) */}
      <div
        className="pointer-events-none absolute inset-x-0 z-10 flex justify-center"
        style={{ top: "calc(12px + env(safe-area-inset-top))" }}
      >
        <div
          className="rounded-full border border-[#9b8066]/60 bg-[#3f1d0e]/90 font-serif text-xl tracking-[0.18em] text-[#f4efcf] shadow-[0_2px_10px_rgba(20,8,2,.45)] sm:text-2xl"
          style={{ padding: "0.15em 0.8em 0.15em calc(0.8em + 0.18em)" }}
        >
          Protheka · 408 DE
        </div>
      </div>
    </div>
  )
}
