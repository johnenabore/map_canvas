"use client"
import { useEffect, useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { useTexture } from "@react-three/drei"
import * as THREE from "three"
import { REVEAL } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import { LAB3D, W, H, srgb } from "./config"
import { view, tier, focal, cubicBezier, Tween } from "./reveal"
import Pins from "./Pins"

// Normals from the heightmap in the fragment shader, so there's no normal map: central differences of the
// 16-bit height (R = high byte, G = low byte), a texel apart (a screen pixel apart when zoomed out, via
// fwidth), as the normal of the flat-lying plane (u = +x, v = north = -z), then into view space. Extended
// (vs. the original reliefNormals) to also: blend in height-detail.png's finer relief, weighted by
// uDetailMix, in both the vertex displacement and the fragment normal; and blend colorTerrainMap /
// colorDetailMap over the base colour map, gated by uTerrainMix/uDetailMix (camera-distance reveal) and an
// ink-bloom radial wipe (uTerrainBloomRadius/uDetailBloomRadius, sampling ink-mask.webp) -- the 3D
// counterpart of the 2D map's zoom-triggered LOD tier reveal and ink-spread bloom (lib/map.ts, MapContent.tsx).
function terrainShader(
  heightMap: THREE.Texture,
  heightDetailMap: THREE.Texture,
  colorTerrainMap: THREE.Texture,
  colorDetailMap: THREE.Texture,
  inkMask: THREE.Texture,
  uniformsOut: { current: Record<string, THREE.IUniform> | null },
) {
  const img = heightMap.image as { width: number; height: number }
  const slope = (LAB3D.displacementScale / (2 * (W / img.width))) * LAB3D.reliefExaggeration
  const detailImg = heightDetailMap.image as { width: number; height: number }
  const detailSlope = (LAB3D.detailDisplacementScale / (2 * (W / detailImg.width))) * LAB3D.reliefExaggeration

  return (shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.reliefMap = { value: heightMap }
    shader.uniforms.reliefTexel = { value: new THREE.Vector2(1 / img.width, 1 / img.height) }
    shader.uniforms.reliefSlope = { value: slope }
    shader.uniforms.heightDetailMap = { value: heightDetailMap }
    shader.uniforms.reliefDetailTexel = { value: new THREE.Vector2(1 / detailImg.width, 1 / detailImg.height) }
    shader.uniforms.reliefDetailSlope = { value: detailSlope }
    shader.uniforms.detailDisplacementScale = { value: LAB3D.detailDisplacementScale }
    shader.uniforms.colorTerrainMap = { value: colorTerrainMap }
    shader.uniforms.colorDetailMap = { value: colorDetailMap }
    shader.uniforms.inkMask = { value: inkMask }
    shader.uniforms.mapW = { value: W }
    shader.uniforms.mapH = { value: H }
    shader.uniforms.maskCore = { value: REVEAL.maskCore }
    shader.uniforms.uTerrainMix = { value: uniformsOut.current?.uTerrainMix.value ?? 0 }
    shader.uniforms.uDetailMix = { value: uniformsOut.current?.uDetailMix.value ?? 0 }
    shader.uniforms.uTerrainBloomCenter = { value: new THREE.Vector2(0.5, 0.5) }
    shader.uniforms.uDetailBloomCenter = { value: new THREE.Vector2(0.5, 0.5) }
    shader.uniforms.uTerrainBloomRadius = { value: 1 }
    shader.uniforms.uDetailBloomRadius = { value: 1 }
    shader.uniforms.uTerrainBloomActive = { value: 0 }
    shader.uniforms.uDetailBloomActive = { value: 0 }
    uniformsOut.current = shader.uniforms as unknown as Record<string, THREE.IUniform>

    // ---- vertex: fine-detail displacement, added on top of the stock displacementMap pass, only once
    // uDetailMix > 0 (independent uniform declaration -- the vertex and fragment shaders each have their
    // own <common> include, patching one doesn't add to the other)
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D heightDetailMap;
uniform float detailDisplacementScale;
uniform float uDetailMix;`,
      )
      .replace(
        "#include <displacementmap_vertex>",
        `#include <displacementmap_vertex>
#ifdef USE_DISPLACEMENTMAP
{
  vec4 dt = texture2D( heightDetailMap, vDisplacementMapUv );
  float hd = dt.r * 0.996109 + dt.g * 0.003891;
  transformed += normalize( objectNormal ) * ( hd * detailDisplacementScale * uDetailMix );
}
#endif`,
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform sampler2D reliefMap;
uniform vec2 reliefTexel;
uniform float reliefSlope;
uniform sampler2D heightDetailMap;
uniform vec2 reliefDetailTexel;
uniform float reliefDetailSlope;
uniform sampler2D colorTerrainMap;
uniform sampler2D colorDetailMap;
uniform sampler2D inkMask;
uniform float mapW;
uniform float mapH;
uniform float maskCore;
uniform float uTerrainMix;
uniform float uDetailMix;
uniform vec2 uTerrainBloomCenter;
uniform vec2 uDetailBloomCenter;
uniform float uTerrainBloomRadius;
uniform float uDetailBloomRadius;
uniform float uTerrainBloomActive;
uniform float uDetailBloomActive;
float reliefAt(vec2 uv) { vec4 t = texture2D(reliefMap, uv); return t.r * 0.996109 + t.g * 0.003891; }
float reliefDetailAt(vec2 uv) { vec4 t = texture2D(heightDetailMap, uv); return t.r * 0.996109 + t.g * 0.003891; }
// the ink-blot's contents never change -- only the radius uniform animates, so there's no per-frame
// texture re-rasterization; this is the shader-native analog of the 2D map's "mask fixed at final size,
// wrapper/uv trick to animate the visible radius" (MapContent.tsx's revealOn)
float bloomFactor(vec2 uv, vec2 center, float radius, float bloomActive) {
  vec2 worldOffset = vec2((uv.x - center.x) * mapW, (uv.y - center.y) * mapH);
  vec2 blotUv = vec2(0.5) + (worldOffset / max(radius, 1e-4)) * maskCore;
  return mix(1.0, texture2D(inkMask, blotUv).a, bloomActive);
}`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `vec2 reliefStep = max(reliefTexel, fwidth(vMapUv));
vec2 reliefK = reliefSlope * reliefTexel / reliefStep;
float reliefL = reliefAt(vMapUv - vec2(reliefStep.x, 0.0));
float reliefR = reliefAt(vMapUv + vec2(reliefStep.x, 0.0));
float reliefD = reliefAt(vMapUv - vec2(0.0, reliefStep.y));
float reliefU = reliefAt(vMapUv + vec2(0.0, reliefStep.y));
float reliefDx = (reliefL - reliefR) * reliefK.x;
float reliefDz = (reliefU - reliefD) * reliefK.y;
#ifdef USE_DISPLACEMENTMAP
{
  vec2 detailStep = max(reliefDetailTexel, fwidth(vMapUv));
  vec2 detailK = reliefDetailSlope * reliefDetailTexel / detailStep;
  float dL = reliefDetailAt(vMapUv - vec2(detailStep.x, 0.0));
  float dR = reliefDetailAt(vMapUv + vec2(detailStep.x, 0.0));
  float dD = reliefDetailAt(vMapUv - vec2(0.0, detailStep.y));
  float dU = reliefDetailAt(vMapUv + vec2(0.0, detailStep.y));
  reliefDx += (dL - dR) * detailK.x * uDetailMix;
  reliefDz += (dU - dD) * detailK.y * uDetailMix;
}
#endif
vec3 reliefN = normalize(vec3(reliefDx, 1.0, reliefDz));
normal = normalize((viewMatrix * vec4(reliefN, 0.0)).xyz);`,
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 baseSample = texture2D( map, vMapUv );
  vec3 blended = baseSample.rgb;
  vec4 terrainSample = texture2D( colorTerrainMap, vMapUv );
  float terrainBloom = bloomFactor(vMapUv, uTerrainBloomCenter, uTerrainBloomRadius, uTerrainBloomActive);
  blended = mix(blended, terrainSample.rgb, terrainSample.a * uTerrainMix * terrainBloom);
  vec4 detailSample = texture2D( colorDetailMap, vMapUv );
  float detailBloom = bloomFactor(vMapUv, uDetailBloomCenter, uDetailBloomRadius, uDetailBloomActive);
  blended = mix(blended, detailSample.rgb, detailSample.a * uDetailMix * detailBloom);
  diffuseColor *= vec4( blended, baseSample.a );
#endif`,
      )
  }
}

const PLAIN_FADE_MS = 300 // reduced motion: a flat fade both ways, no bloom (matches 2D's plain.current fallback)

function Terrain() {
  const color = useTexture("/maps/3d/color-base.webp", srgb)
  const colorTerrain = useTexture("/maps/3d/color-terrain.webp", srgb)
  const colorDetail = useTexture("/maps/3d/color-detail.webp", srgb)
  const height = useTexture("/maps/3d/height.png")
  const heightDetail = useTexture("/maps/3d/height-detail.png")
  const inkMask = useTexture(REVEAL.mask)
  const invalidate = useThree((s) => s.invalidate)
  const reducedMotion = useReducedMotion()

  // sparse, blurred-edge overlays: only ever meaningfully visible near 1:1 texel density, where mipmapping
  // buys nothing and would worsen bleed at their feathered alpha edges
  useEffect(() => {
    for (const t of [colorTerrain, colorDetail, heightDetail]) {
      t.generateMipmaps = false
      t.minFilter = THREE.LinearFilter
      t.needsUpdate = true
    }
  }, [colorTerrain, colorDetail, heightDetail])

  const uniformsRef = useRef<Record<string, THREE.IUniform> | null>(null)
  const onBeforeCompile = useMemo(
    () => terrainShader(height, heightDetail, colorTerrain, colorDetail, inkMask, uniformsRef),
    [height, heightDetail, colorTerrain, colorDetail, inkMask],
  )

  const prevTier = useRef({ terrain: false, detail: false })
  const mixTween = useRef({ terrain: new Tween(), detail: new Tween() })
  const bloomTween = useRef({ terrain: new Tween(), detail: new Tween() })
  const easeOut = useMemo(() => cubicBezier(REVEAL.easing), [])

  useFrame(() => {
    const uniforms = uniformsRef.current
    if (!uniforms) return
    const now = performance.now()
    let animating = false

    for (const t of ["terrain", "detail"] as const) {
      const on = tier[t]
      const was = prevTier.current[t]
      const mix = mixTween.current[t]
      const bloom = bloomTween.current[t]
      const Cap = t === "terrain" ? "Terrain" : "Detail"

      if (on !== was) {
        prevTier.current[t] = on
        if (reducedMotion) {
          mix.set(mix.value, on ? 1 : 0, PLAIN_FADE_MS, (x) => x, now)
          bloom.active = false
        } else if (on) {
          // spread only on the ON transition (matches 2D); OFF is always a plain fade. The focal point is
          // snapshotted here, once, not re-read live during the spread, so it doesn't drift if the user
          // keeps panning mid-reveal.
          mix.set(mix.value, 1, REVEAL.fadeInMs, (x) => x, now)
          const reach = view.reach || 1
          ;(uniforms[`u${Cap}BloomCenter`].value as THREE.Vector2).set(focal.u, focal.v)
          bloom.set(Math.max(0.05, reach * REVEAL.maskStart), reach * REVEAL.maskScale, REVEAL.spreadMs, easeOut, now)
        } else {
          mix.set(mix.value, 0, REVEAL.fadeOutMs, (x) => x, now)
          bloom.active = false
        }
      }

      const mixActive = mix.update(now)
      const bloomActive = bloom.update(now)
      animating = animating || mixActive || bloomActive

      uniforms[`u${Cap}Mix`].value = mix.value
      uniforms[`u${Cap}BloomRadius`].value = bloom.value
      uniforms[`u${Cap}BloomActive`].value = bloomActive ? 1 : 0
    }

    if (animating) invalidate()
  })

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

export default Terrain
