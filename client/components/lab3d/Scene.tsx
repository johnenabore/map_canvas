"use client"
import { Suspense, useLayoutEffect, useMemo, useRef, type ComponentRef } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { MapControls, useTexture } from "@react-three/drei"
import * as THREE from "three"
import { MAP } from "@/lib/map"
import Pins from "./Pins"

// ---- every tunable of the spike (world units: the map is MAP.w/100 x MAP.h/100 = 9.03 x 6.73) ----
export const LAB3D = {
  map: { w: MAP.w / 100, h: MAP.h / 100 },
  segments: [512, 382] as const,
  displacementScale: 0.12,   // world units at height 1.0; subtle, so lettering on the land doesn't warp
  normalScale: 1,            // on top of the slope exaggeration baked into normal.png (gen-3d normalStrength)
  world: 3,                  // world sea plane: square, this x the map width
  seaTilesAcrossMap: 8,      // sea-tile.webp repeats: must match gen-3d (4096px map / 512px tile)
  worldFade: [0.62, 0.98],   // world plane: opaque out to this fraction of its half-size, gone at the second (radial)
  fov: 40,
  continents: { x0: 0.03, x1: 0.97, y0: 0.14, y1: 0.97 }, // fractions of the map: all of it fits at max zoom-out
  fitMargin: 1.04,
  panMargin: 0.08,           // may pan this far (x the map width) past the outermost continents
  minDistance: 1.1,          // max zoom-in
  pitch: [0.05, 0.85] as const, // rad from straight down: fully zoomed out -> fully zoomed in
  fog: [1.6, 3.2] as const,  // fog near/far, x the camera distance (tilted views fade into the background)
  background: "#412511",
  // together they light flat ground at about the texture's own colour (slightly warm); the low sun raises relief
  sun: { color: "#fff0de", intensity: 3.9, position: [-7, 3.4, -5] as const }, // top-left of the map, low
  ambient: { color: "#f7f9ff", intensity: 1.7 },
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

// colour textures in sRGB; data textures (height, normal) stay linear
const srgb = (tex: THREE.Texture | THREE.Texture[]) => {
  for (const t of Array.isArray(tex) ? tex : [tex]) {
    if (t.colorSpace === THREE.SRGBColorSpace) continue
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 8
    t.needsUpdate = true
  }
}

function Terrain() {
  const color = useTexture("/maps/3d/color.webp", srgb)
  const [height, normal] = useTexture(["/maps/3d/height.png", "/maps/3d/normal.png"])
  return (
    <>
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[W, H, ...LAB3D.segments]} />
        <meshStandardMaterial
          map={color}
          displacementMap={height}
          displacementScale={LAB3D.displacementScale}
          normalMap={normal}
          normalScale={[LAB3D.normalScale, LAB3D.normalScale]}
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

// MapControls without rotation. Max zoom-out fits every continent (portrait or landscape); the pitch
// follows the zoom (straight down when out, tilted when in); the target is clamped so you can pan a little
// past the outermost continents but never towards the edge of the world plane; fog scales with distance.
function CameraRig() {
  const controls = useRef<ComponentRef<typeof MapControls>>(null)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  const placed = useRef(false)
  const c = LAB3D.continents
  const lim = useMemo(() => {
    const tan = Math.tan(((LAB3D.fov / 2) * Math.PI) / 180)
    const aspect = size.width / Math.max(1, size.height)
    const cw = (c.x1 - c.x0) * W * LAB3D.fitMargin
    const ch = (c.y1 - c.y0) * H * LAB3D.fitMargin
    return {
      cx: ((c.x0 + c.x1) / 2 - 0.5) * W,
      cz: ((c.y0 + c.y1) / 2 - 0.5) * H,
      halfW: cw / 2,
      halfH: ch / 2,
      tan,
      aspect,
      dMax: Math.max(ch / (2 * tan), cw / (2 * tan * aspect)),
    }
  }, [size.width, size.height, c.x0, c.x1, c.y0, c.y1])

  useLayoutEffect(() => {
    const ctl = controls.current
    if (!ctl || placed.current) return
    placed.current = true
    // start fully zoomed out on the continents (?zoom=0..1 and ?at=x,y in map % pick another start)
    const q = new URLSearchParams(window.location.search)
    const t = Math.min(1, Math.max(0, Number(q.get("zoom") ?? 0) || 0))
    const at = q.get("at")?.split(",").map(Number)
    const d = lim.dMax * Math.pow(LAB3D.minDistance / lim.dMax, t)
    const pitch = LAB3D.pitch[0] + (LAB3D.pitch[1] - LAB3D.pitch[0]) * t
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
    const t = Math.min(1, Math.max(0, Math.log(lim.dMax / d) / Math.log(lim.dMax / LAB3D.minDistance)))
    view.t = t
    const pitch = LAB3D.pitch[0] + (LAB3D.pitch[1] - LAB3D.pitch[0]) * t
    if (Math.abs(ctl.minPolarAngle - pitch) > 1e-4) {
      ctl.minPolarAngle = ctl.maxPolarAngle = pitch
      ctl.update()
    }
    // pan limit: the continents' box, less what's already on screen, plus a margin
    const visH = d * lim.tan
    const mx = Math.max(0, lim.halfW - visH * lim.aspect) + LAB3D.panMargin * W
    const mz = Math.max(0, lim.halfH - visH) + LAB3D.panMargin * W
    const tx = Math.min(lim.cx + mx, Math.max(lim.cx - mx, ctl.target.x))
    const tz = Math.min(lim.cz + mz, Math.max(lim.cz - mz, ctl.target.z))
    if (tx !== ctl.target.x || tz !== ctl.target.z) {
      const dx = tx - ctl.target.x
      const dz = tz - ctl.target.z
      ctl.target.x = tx
      ctl.target.z = tz
      camera.position.x += dx
      camera.position.z += dz
    }
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.near = d * LAB3D.fog[0]
      scene.fog.far = d * LAB3D.fog[1]
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
      maxDistance={lim.dMax}
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
      {/* replaces the removed title cartouche */}
      <div
        className="pointer-events-none absolute inset-x-0 z-10 text-center font-serif text-xl tracking-[0.18em] text-[#f4efcf] sm:text-2xl"
        style={{ top: "calc(14px + env(safe-area-inset-top))", textShadow: "0 1px 8px rgba(20,8,2,.7)" }}
      >
        Protheka · 408 DE
      </div>
    </div>
  )
}
