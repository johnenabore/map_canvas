"use client"
import { Suspense, useLayoutEffect, useMemo, useRef, type ComponentRef } from "react"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { MapControls, useTexture } from "@react-three/drei"
import * as THREE from "three"
import LAND from "@/public/maps/3d/land-bounds.json" // npm run gen3d
import { LAB3D, W, H, SEA, srgb } from "./config"
import { view, tier, focal, smoothstep } from "./reveal"
import Terrain from "./Terrain"

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
  const shownTier = useRef({ terrain: false, detail: false })
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
    // zoom state at camera distance d: t = 0 at cover .. 1 fully in (the clouds and the tier reveal read it),
    // out = 0 at cover .. 1 at contain. The pitch and the fog ease from their contain values into their cover
    // values (flat there), then the pitch follows the in-curve.
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
    view.out = out

    // Level-triggered tiers: switch when t crosses terrainInT / detailInT (the 3D counterpart of the 2D
    // map's LVL2/LVL3). Hysteresis: once shown, a tier hides only below (level - tierHysteresis), so a
    // small wobble around the threshold can't flip it back and forth. Read by Terrain.tsx (the shader mix
    // + ink bloom) and Pins.tsx (minLevel gating + stamp-in).
    for (const [key, level] of [["terrain", LAB3D.terrainInT], ["detail", LAB3D.detailInT]] as const) {
      const want = t >= (shownTier.current[key] ? level - LAB3D.tierHysteresis : level)
      if (want !== shownTier.current[key]) {
        shownTier.current[key] = want
        tier[key] = want
      }
    }
    // the camera's look-at point, in plane UV -- always current (MapControls' own pivot), so no staleness
    // window is needed the way 2D's discrete pointer-event capture requires one
    focal.u = ctl.target.x / W + 0.5
    focal.v = ctl.target.z / H + 0.5
    // world-space distance from the view's centre to its farthest ground corner, used to size the ink bloom
    const f = footprint(pitch, d, lim.tan, lim.aspect)
    view.reach = Math.hypot(f.halfWidth, Math.max(Math.abs(f.far), Math.abs(f.near)))

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
