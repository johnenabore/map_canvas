// Generates the map's atmosphere textures (paper, clouds, cloud shadows) from inline SVG filters.
// Usage: npm run atmos   -> public/maps/atmos/*.webp
// librsvg (via sharp) renders feTurbulence / feComponentTransfer / feDisplacementMap / feGaussianBlur.
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const outDir = fileURLToPath(new URL("../public/maps/atmos/", import.meta.url))

// sRGB + user-space filter region = the whole canvas, so pixels map 1:1
const filterAttrs = (w, h) =>
  `filterUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}" color-interpolation-filters="sRGB"`

// gray from the R channel, fully opaque (turbulence alpha is noise too, which breaks arithmetic compositing)
const GRAY = "1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1"

// same curve on R, G and B
const rgbFunc = (attrs) => ["R", "G", "B"].map((c) => `<feFunc${c} ${attrs}/>`).join("")

// palette ramp over the product (0..1): #9b8066 below ~0.67, #e5d2b3 -> #f4efcf above it
const ramp = (dark, mid, light) => `${dark} ${dark} ${mid} ${light}`

// 512px tileable paper = fine grain x large soft mottling x sparse horizontal fibers (each a 0..1
// gray factor, multiplied), then mapped onto the map palette. Only stitched noise + per-pixel ops
// (no blur), so the tile edges wrap seamlessly.
function paperSvg() {
  const s = 512
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
  <filter id="p" ${filterAttrs(s, s)}>
    <feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="3" seed="7" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="${GRAY}"/>
    <feComponentTransfer result="grain">${rgbFunc('type="linear" slope="1" intercept="0.45"')}</feComponentTransfer>
    <feTurbulence type="fractalNoise" baseFrequency="0.008" numOctaves="2" seed="19" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="${GRAY}"/>
    <feComponentTransfer result="mottle">${rgbFunc('type="linear" slope="0.6" intercept="0.65"')}</feComponentTransfer>
    <feTurbulence type="turbulence" baseFrequency="0.004 0.07" numOctaves="2" seed="11" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="${GRAY}"/>
    <feComponentTransfer result="fibers">${rgbFunc('type="table" tableValues="1 1 0.85 0.6"')}</feComponentTransfer>
    <feComposite in="grain" in2="mottle" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>
    <feComposite in2="fibers" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>
    <feComponentTransfer>
      <feFuncR type="table" tableValues="${ramp(0.608, 0.898, 0.957)}"/>
      <feFuncG type="table" tableValues="${ramp(0.502, 0.824, 0.937)}"/>
      <feFuncB type="table" tableValues="${ramp(0.4, 0.702, 0.812)}"/>
    </feComponentTransfer>
  </filter>
  <rect width="${s}" height="${s}" filter="url(#p)"/>
</svg>`
}

// librsvg's stitchTiles still leaves a faint seam, so force the tile seamless: per axis, blend the
// image with a copy rolled by half a tile. The copy is continuous across the wrap and supplies the
// edges; the original covers the copy's own seam in the middle. Narrow band = little contrast loss.
function makeSeamless(src, w, h, c, band) {
  const weight = (d) => {
    const t = Math.min(1, d / band)
    return t * t * (3 - 2 * t) // 0 at the edge -> 1 inside the band
  }
  const pass = (img, horizontal) => {
    const out = Buffer.alloc(img.length)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = horizontal ? weight(Math.min(x, w - 1 - x)) : weight(Math.min(y, h - 1 - y))
        const sx = horizontal ? (x + w / 2) % w : x
        const sy = horizontal ? y : (y + h / 2) % h
        const i = (y * w + x) * c
        const j = (sy * w + sx) * c
        for (let k = 0; k < c; k++) out[i + k] = Math.round(img[i + k] * m + img[j + k] * (1 - m))
      }
    }
    return out
  }
  return pass(pass(src, true), false)
}

// soft cream cloud: overlapping soft ellipses carved by fractal noise, then a contrast curve on alpha
function cloudSvg(seed, blobs) {
  const w = 512
  const h = 320
  const ellipses = blobs
    .map(([cx, cy, rx, ry]) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#b)"/>`)
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    <radialGradient id="b">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0.7"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <filter id="c" ${filterAttrs(w, h)}>
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="5" seed="${seed}"/>
      <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 0.98  0 0 0 0 0.925  1.3 0 0 0 0"/>
      <feComposite in2="SourceGraphic" operator="in"/>
      <feComponentTransfer><feFuncA type="linear" slope="2.2" intercept="-0.35"/></feComponentTransfer>
      <feGaussianBlur stdDeviation="2.5"/>
    </filter>
  </defs>
  <g filter="url(#c)">${ellipses}</g>
</svg>`
}

// very soft dark ground shadow: a warped radial blob, heavily blurred
function shadowSvg(seed, blobs) {
  const s = 256
  const ellipses = blobs
    .map(([cx, cy, rx, ry]) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#s)"/>`)
    .join("")
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
  <defs>
    <radialGradient id="s">
      <stop offset="0" stop-color="#3f1d0e" stop-opacity="0.9"/>
      <stop offset="1" stop-color="#3f1d0e" stop-opacity="0"/>
    </radialGradient>
    <filter id="d" ${filterAttrs(s, s)}>
      <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="${seed}" result="t"/>
      <feDisplacementMap in="SourceGraphic" in2="t" scale="40" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="8"/>
    </filter>
  </defs>
  <g filter="url(#d)">${ellipses}</g>
</svg>`
}

// seeded PRNG so every run produces the same wisps
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// mix two #rrggbb colours
const mix = (a, b, t) =>
  "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, "0")).join("")

// volcano smoke wisp (128x192): soft radial puffs up a curve that leans right (the CSS drift goes
// right too), growing and thinning toward the top; ink #3f1d0e at the base -> #9b8066 (kept darker
// than the map, or it vanishes into it). Alpha is broken up by fractal noise (like the clouds), then
// curled by displacement and softened. Puffs stay inside the canvas so alpha reaches 0 at the edges.
function wispSvg(seed) {
  const w = 128
  const h = 192
  const rnd = mulberry32(seed)
  const n = 6
  let defs = ""
  let puffs = ""
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    const cy = 158 - t * 96
    // centred on the emitter (the box's bottom-centre); the CSS drift does the leaning
    const cx = 62 + t * 6 + (rnd() - 0.5) * 6
    const r = 18 + t * 24 + rnd() * 3
    const col = mix("#3f1d0e", "#9b8066", Math.min(0.85, t * 1.3))
    const a = 1 - t * 0.4
    // flat-ish falloff so each puff is solid across most of its radius (reads as volume, not a thread)
    defs += `<radialGradient id="p${i}"><stop offset="0" stop-color="${col}" stop-opacity="${a.toFixed(2)}"/><stop offset="0.7" stop-color="${col}" stop-opacity="${(a * 0.8).toFixed(2)}"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></radialGradient>`
    puffs += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="url(#p${i})"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
  <defs>
    ${defs}
    <filter id="w" ${filterAttrs(w, h)}>
      <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="3" seed="${seed}" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1.1 0 0 0 0.25" result="na"/>
      <feComposite in="SourceGraphic" in2="na" operator="in" result="patchy"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="${seed + 1}" result="d"/>
      <feDisplacementMap in="patchy" in2="d" scale="14" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="2.5"/>
    </filter>
  </defs>
  <g filter="url(#w)">${puffs}</g>
</svg>`
}

// ink-blot mask for the zoom reveal (512x512, white + alpha; only the alpha is used as a CSS mask):
// a soft disc warped by low-frequency turbulence into an irregular blot, a finer displacement for a
// ragged fringe, then a soft alpha threshold. The solid core radius is measured after rendering and
// reported (REVEAL.maskCore in lib/map.ts), so the reveal knows how big the blot must get to cover the map.
function inkMaskSvg() {
  const s = 512
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}">
  <defs>
    <radialGradient id="r">
      <stop offset="0" stop-color="#fff" stop-opacity="1"/>
      <stop offset="0.7" stop-color="#fff" stop-opacity="1"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <filter id="k" ${filterAttrs(s, s)}>
      <feTurbulence type="fractalNoise" baseFrequency="0.011" numOctaves="3" seed="5" result="warp"/>
      <feDisplacementMap in="SourceGraphic" in2="warp" scale="70" xChannelSelector="R" yChannelSelector="G" result="blob"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.07" numOctaves="2" seed="9" result="grain"/>
      <feDisplacementMap in="blob" in2="grain" scale="16" xChannelSelector="R" yChannelSelector="G"/>
      <feComponentTransfer><feFuncA type="linear" slope="2.6" intercept="-0.9"/></feComponentTransfer>
      <feGaussianBlur stdDeviation="1.5"/>
    </filter>
  </defs>
  <circle cx="${s / 2}" cy="${s / 2}" r="210" fill="url(#r)" filter="url(#k)"/>
</svg>`
}

// [cx, cy, rx, ry] per blob; kept well inside the canvas so alpha reaches 0 before the edge
const CLOUDS = [
  { seed: 3, blobs: [[180, 170, 130, 80], [300, 150, 140, 90], [390, 185, 90, 60]] },
  { seed: 17, blobs: [[140, 180, 100, 70], [250, 140, 150, 95], [370, 170, 110, 75]] },
  { seed: 29, blobs: [[256, 160, 200, 85], [170, 185, 90, 55]] },
  { seed: 41, blobs: [[200, 150, 120, 95], [320, 175, 130, 75], [130, 195, 70, 45], [410, 150, 60, 45]] },
]
const SHADOWS = [
  { seed: 5, blobs: [[128, 128, 70, 55]] },
  { seed: 13, blobs: [[110, 130, 55, 45], [150, 120, 50, 40]] },
  { seed: 23, blobs: [[128, 135, 75, 45], [150, 110, 40, 35]] },
]

const jobs = [
  // q90: lossy WebP encodes edge blocks independently, which re-introduces a seam at low quality
  { name: "paper.webp", svg: paperSvg(), webp: { quality: 90, effort: 6 }, seamless: true },
  ...CLOUDS.map((c, i) => ({ name: `cloud-${i + 1}.webp`, svg: cloudSvg(c.seed, c.blobs), webp: { quality: 70, alphaQuality: 100, effort: 6 } })),
  ...SHADOWS.map((c, i) => ({ name: `shadow-${i + 1}.webp`, svg: shadowSvg(c.seed, c.blobs), webp: { quality: 60, alphaQuality: 100, effort: 6 } })),
  ...[7, 19, 31, 43, 55, 67].map((seed, i) => ({ name: `wisp-${i + 1}.webp`, svg: wispSvg(seed), webp: { quality: 70, alphaQuality: 100, effort: 6 } })),
  { name: "ink-mask.webp", svg: inkMaskSvg(), webp: { quality: 20, alphaQuality: 100, effort: 6 }, measureCore: true },
]

await mkdir(outDir, { recursive: true })
let total = 0
for (const job of jobs) {
  let img = sharp(Buffer.from(job.svg))
  if (job.seamless) {
    const { data, info: raw } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true })
    const fixed = makeSeamless(data, raw.width, raw.height, raw.channels, 96)
    img = sharp(fixed, { raw: { width: raw.width, height: raw.height, channels: raw.channels } })
  }
  const info = await img.webp(job.webp).toFile(outDir + job.name)
  total += info.size
  console.log(`${job.name.padEnd(14)} ${info.width}x${info.height}  ${(info.size / 1024).toFixed(1)} KiB`)
  if (job.measureCore) {
    // walk 360 rays out from the centre: where the blot stops being solid (core) and where it ends
    const { data, info: m } = await sharp(outDir + job.name).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const alpha = (x, y) => data[(Math.round(y) * m.width + Math.round(x)) * 4 + 3]
    let core = Infinity
    let outer = 0
    for (let a = 0; a < 360; a++) {
      const dx = Math.cos((a * Math.PI) / 180)
      const dy = Math.sin((a * Math.PI) / 180)
      for (let r = 0; r < m.width / 2 - 1; r++) {
        const v = alpha(m.width / 2 + dx * r, m.height / 2 + dy * r)
        if (v < 250) core = Math.min(core, r)
        if (v > 3) outer = Math.max(outer, r)
      }
    }
    console.log(`  ink mask: solid core radius ${(core / m.width).toFixed(3)} x size (REVEAL.maskCore), blot reaches ${(outer / m.width).toFixed(3)} (must stay < 0.5)`)
  }
}
console.log(`total          ${(total / 1024).toFixed(1)} KiB`)
