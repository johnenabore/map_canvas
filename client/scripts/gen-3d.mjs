// Textures for the /lab/3d spike, rendered from the three LOD tiers with sharp (as in scripts/raster.mjs).
// Usage: npm run gen3d -> public/maps/3d/
//   color.webp          base+terrain+detail at 4096px, the title/legend band and the frame replaced by open
//                       sea, land along the old frame edges dissolving into mist (the compass stays)
//   sea-tile.webp       seamless sea (parchment tone + faint ink wave marks) for the world plane around the
//                       map; the same tile is painted into color.webp's sea margin on the same grid, so the
//                       two meet without a seam
//   height.png          1024px grayscale: land plateau 0.15 + blurred relief 0.85; sea and removed areas 0
//   normal.png          tangent-space normals from height.png (Sobel)
//   preview-height.png  height | hillshaded colour, side by side, for judging the relief
import { mkdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const maps = fileURLToPath(new URL("../public/maps/", import.meta.url))
const outDir = maps + "3d/"
const VIEWBOX_W = 903 // matches MAP.w in lib/map.ts

const CFG = {
  colorW: 4096,
  heightW: 1024,
  quality: 85,
  top: 0.14,           // title/legend band, fraction of the map height
  frame: 0.03,         // frame border, fraction of the map width (all four sides)
  fade: 0.04,          // land dissolves into mist over this, fraction of the map width, inward of the removed areas
  fadeNoise: 0.012,    // how ragged the dissolve edge is, fraction of the map width
  mist: 0.3,           // lightening in the middle of the dissolve
  compass: { x: 0.44, y: 0.892, r: 0.075 }, // kept: centre (fraction of w/h), radius (fraction of the width)
  seaTol: 18,          // flood fill: max per-channel distance from the sea colour
  letterCream: 0.3,    // an enclosed pocket that's at least this cream is lettering on the sea, not land
  minLand: 40,         // px (at 1024): smaller pockets are specks, not land
  land: 0.15,
  landBlur: 6,         // gaussian sigma, px at 1024
  relief: 0.85,
  reliefBlur: 24,
  tile: 512,           // sea tile, px; 8 tiles across the 4096px map, so the scene can line the world plane up
  waves: 26,           // ink wave marks per tile
  normalStrength: 6,   // slope exaggeration baked into normal.png (normalScale in the scene tunes it further)
}
// open-sea sample boxes (fractions of w/h), for the sea colour and as flood-fill seeds
const SEA = [[0.18, 0.56, 0.3, 0.64], [0.33, 0.57, 0.39, 0.62], [0.79, 0.73, 0.91, 0.79], [0.59, 0.745, 0.68, 0.79], [0.05, 0.36, 0.1, 0.43]]

// ---------- render the stacked tiers
const render = async (svg, w) => sharp(svg, { density: (72 * w) / VIEWBOX_W }).resize(w).png().toBuffer()
const svgs = await Promise.all(["base", "terrain", "detail"].map((t) => readFile(`${maps}protheka-${t}.svg`)))
const tiers = await Promise.all(svgs.map((s) => render(s, CFG.colorW)))
// composite first, then read out in a second pipeline (sharp resizes before compositing in one pipeline)
const stacked = await sharp(tiers[0]).composite(tiers.slice(1).map((input) => ({ input }))).png().toBuffer()
const big = await sharp(stacked).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const W = big.info.width
const H = big.info.height
const small = await sharp(stacked).resize(CFG.heightW).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const w = small.info.width
const h = small.info.height

// ---------- sea colour: median of the open-sea boxes
const seaPx = [[], [], []]
for (const [x0, y0, x1, y1] of SEA)
  for (let y = Math.round(y0 * h); y < y1 * h; y++)
    for (let x = Math.round(x0 * w); x < x1 * w; x++) for (let c = 0; c < 3; c++) seaPx[c].push(small.data[(y * w + x) * 3 + c])
const median = (a) => a.sort((p, q) => p - q)[a.length >> 1]
const sea = seaPx.map(median)
console.log(`sea colour rgb(${sea.join(",")})`)

// ---------- noise helpers (seeded)
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
// value noise on an nx x ny lattice (wrapping if periodic), cosine-interpolated, in [-1, 1]
function lattice(nx, ny, seed, periodic) {
  const rnd = mulberry32(seed)
  const gx = periodic ? nx : nx + 1
  const gy = periodic ? ny : ny + 1
  const v = Float32Array.from({ length: gx * gy }, () => rnd() * 2 - 1)
  const at = (i, j) => v[(periodic ? ((j % ny) + ny) % ny : j) * gx + (periodic ? ((i % nx) + nx) % nx : i)]
  return (u, t) => { // u, t in [0, 1]
    const x = u * nx
    const y = t * ny
    const i = Math.min(Math.floor(x), periodic ? x : nx - 1)
    const j = Math.min(Math.floor(y), periodic ? y : ny - 1)
    const fx = (1 - Math.cos((x - i) * Math.PI)) / 2
    const fy = (1 - Math.cos((y - j) * Math.PI)) / 2
    const a = at(i, j) * (1 - fx) + at(i + 1, j) * fx
    const b = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx
    return a * (1 - fy) + b * fy
  }
}

// ---------- seamless sea tile: sea tone, soft mottling, faint ink wave marks (drawn with wrap-around)
const T = CFG.tile
const tile = await (async () => {
  const rnd = mulberry32(408)
  let marks = ""
  for (let k = 0; k < CFG.waves; k++) {
    const x = rnd() * T
    const y = rnd() * T
    const len = 14 + rnd() * 18
    const a = 2 + rnd() * 1.5
    const d = `M0 0 Q${len / 4} ${-a} ${len / 2} 0 Q${(3 * len) / 4} ${a} ${len} 0`
    const op = (0.08 + rnd() * 0.07).toFixed(3)
    for (const ox of [-T, 0, T]) for (const oy of [-T, 0, T])
      marks += `<path transform="translate(${(x + ox).toFixed(1)} ${(y + oy).toFixed(1)})" d="${d}" fill="none" stroke="#3f1d0e" stroke-opacity="${op}" stroke-width="1.6" stroke-linecap="round"/>`
  }
  const ink = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${T}" height="${T}">${marks}</svg>`)).ensureAlpha().raw().toBuffer()
  const n1 = lattice(4, 4, 11, true)
  const n2 = lattice(16, 16, 23, true)
  const px = new Float32Array(T * T * 3)
  for (let y = 0; y < T; y++)
    for (let x = 0; x < T; x++) {
      const m = 1 + 0.03 * n1(x / T, y / T) + 0.012 * n2(x / T, y / T)
      const i = y * T + x
      const al = ink[i * 4 + 3] / 255
      for (let c = 0; c < 3; c++) px[i * 3 + c] = sea[c] * m * (1 - al) + [63, 29, 14][c] * al
    }
  // keep the tile's average exactly on the sea colour, so map and world sea match in tone
  for (let c = 0; c < 3; c++) {
    let s = 0
    for (let i = 0; i < T * T; i++) s += px[i * 3 + c]
    const shift = sea[c] - s / (T * T)
    for (let i = 0; i < T * T; i++) px[i * 3 + c] += shift
  }
  return px
})()
await mkdir(outDir, { recursive: true })
await sharp(Buffer.from(tile.map((v) => Math.max(0, Math.min(255, Math.round(v))))), { raw: { width: T, height: T, channels: 3 } })
  .webp({ quality: 90 })
  .toFile(outDir + "sea-tile.webp")

// ---------- keep/dissolve factor k: 0 in the removed band and frame, rising to 1 over CFG.fade inward
// (ragged with noise), 1 on the compass. u, t = fractions of the map width/height; distances in widths.
const aspect = H / W
const edgeNoise = lattice(36, Math.round(36 * aspect), 7, false)
const smooth = (e) => (e <= 0 ? 0 : e >= 1 ? 1 : e * e * (3 - 2 * e))
const compassK = (u, t) => {
  const d = Math.hypot(u - CFG.compass.x, (t - CFG.compass.y) * aspect)
  return 1 - smooth((d - CFG.compass.r) / 0.006)
}
function keep(u, t) {
  const inside = Math.min(u - CFG.frame, 1 - CFG.frame - u, (t - CFG.top) * aspect, (1 - CFG.frame / aspect - t) * aspect)
  const k = smooth((inside + CFG.fadeNoise * edgeNoise(u, t)) / CFG.fade)
  return Math.max(inside < 0 ? 0 : k, compassK(u, t))
}

// ---------- color.webp: map where k = 1, sea tile (same grid as the world plane) where k = 0, mist between
{
  const mistNoise = lattice(60, Math.round(60 * aspect), 19, false)
  const out = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1)
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1)
      const k = keep(u, t)
      const i = (y * W + x) * 3
      const ti = ((y % T) * T + (x % T)) * 3
      const mist = CFG.mist * 4 * k * (1 - k) * (0.65 + 0.35 * mistNoise(u, t))
      for (let c = 0; c < 3; c++) {
        const v = tile[ti + c] * (1 - k) + big.data[i + c] * k
        out[i + c] = Math.max(0, Math.min(255, Math.round(v + (255 - v) * mist * 0.5)))
      }
    }
  }
  const info = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: CFG.quality }).toFile(outDir + "color.webp")
  console.log(`color.webp ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KiB`)
}

// ---------- land mask: flood-fill the sea from open-sea seeds over sea-coloured pixels, inside the old
// frame only (land cut off by the frame then stays land); what the sea doesn't reach is land, except
// pockets that are mostly cream (lettering on the sea) or tiny
const N = w * h
const isSea = new Uint8Array(N)
{
  const x0 = Math.ceil(CFG.frame * w)
  const x1 = Math.floor((1 - CFG.frame) * w)
  const y0 = Math.ceil(CFG.top * h)
  const y1 = Math.floor(h - CFG.frame * w)
  const inRect = (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1
  const passable = (p) => Math.max(...[0, 1, 2].map((c) => Math.abs(small.data[p * 3 + c] - sea[c]))) <= CFG.seaTol
  const queue = new Int32Array(N)
  let head = 0
  let tail = 0
  for (const [bx0, by0, bx1, by1] of SEA) {
    const p = Math.round(((by0 + by1) / 2) * h) * w + Math.round(((bx0 + bx1) / 2) * w)
    if (passable(p) && !isSea[p]) {
      isSea[p] = 1
      queue[tail++] = p
    }
  }
  while (head < tail) {
    const p = queue[head++]
    const x = p % w
    const y = (p / w) | 0
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx
      const ny = y + dy
      const q = ny * w + nx
      if (inRect(nx, ny) && !isSea[q] && passable(q)) {
        isSea[q] = 1
        queue[tail++] = q
      }
    }
  }
  // outside the old frame interior counts as sea too
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!inRect(x, y)) isSea[y * w + x] = 1
  // pockets of "land" enclosed by sea: lettering or specks go back to sea
  const seen = new Uint8Array(N)
  let relabelled = 0
  for (let s = 0; s < N; s++) {
    if (isSea[s] || seen[s]) continue
    const comp = []
    let cream = 0
    seen[s] = 1
    const stack = [s]
    while (stack.length) {
      const p = stack.pop()
      comp.push(p)
      const [r, g, b] = [small.data[p * 3], small.data[p * 3 + 1], small.data[p * 3 + 2]]
      if (r > 236 && g > 226 && b > 192) cream++
      const x = p % w
      const y = (p / w) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (!isSea[q] && !seen[q]) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    if (comp.length < CFG.minLand || cream / comp.length > CFG.letterCream) {
      for (const p of comp) isSea[p] = 1
      relabelled++
    }
  }
  let landPx = 0
  for (let p = 0; p < N; p++) landPx += !isSea[p]
  console.log(`land mask: ${((landPx / N) * 100).toFixed(1)}% of the map is land (${relabelled} lettering/speck pockets returned to sea)`)
}

// ---------- height.png
const gray = (arr) => sharp(Buffer.from(arr), { raw: { width: w, height: h, channels: 1 } })
// (extractChannel(0): sharp hands back 3 channels after blurring a 1-channel raw input)
const land = await gray(Uint8Array.from(isSea, (s) => (s ? 0 : 255))).blur(CFG.landBlur).extractChannel(0).raw().toBuffer()
const reliefTiers = await Promise.all(svgs.slice(1).map((s) => render(s, CFG.heightW)))
const reliefRaw = await sharp(reliefTiers[0]).composite([{ input: reliefTiers[1] }]).png().toBuffer()
const coverage = await sharp(reliefRaw).extractChannel(3).blur(CFG.reliefBlur).extractChannel(0).raw().toBuffer()
if (land.length !== N || coverage.length !== N) throw new Error(`expected ${N} px, got ${land.length} / ${coverage.length}`)
// normalized = stretched between the 5th and 99.5th percentile of coverage on land (coverage saturates
// over most of the land, so dividing by the peak alone would leave a flat plateau)
const onLand = Array.from(coverage).filter((_, p) => !isSea[p]).sort((a, b) => a - b)
const lo = onLand[Math.floor(onLand.length * 0.05)]
const peak = Math.max(lo + 1, onLand[Math.floor(onLand.length * 0.995)])
const height = new Float32Array(N)
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const p = y * w + x
    const u = x / (w - 1)
    const t = y / (h - 1)
    const l = land[p] / 255
    const relief = Math.max(0, Math.min(1, (coverage[p] - lo) / (peak - lo))) * CFG.relief * l // relief only on land
    const k = keep(u, t) * (1 - compassK(u, t)) // removed areas and the compass stay flat
    height[p] = Math.min(1, (l * CFG.land + relief) * k)
  }
await gray(Uint8Array.from(height, (v) => Math.round(v * 255))).png().toFile(outDir + "height.png")

// ---------- normal.png (Sobel; OpenGL convention: +x right, +y up, as three.js expects)
// the blurs above are 8-bit, so the height has tiny terraces that Sobel turns into ripples: smooth a copy
// in float (two passes of a 5px box blur) for the normals only
const soft = (() => {
  let src = height
  for (let pass = 0; pass < 2; pass++)
    for (const horizontal of [true, false]) {
      const dst = new Float32Array(N)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let sum = 0
          for (let k = -2; k <= 2; k++) {
            const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x
            const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k))
            sum += src[yy * w + xx]
          }
          dst[y * w + x] = sum / 5
        }
      src = dst
    }
  return src
})()
const hAt = (x, y) => soft[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
const normal = Buffer.alloc(N * 3)
const shade = new Float32Array(N) // hillshade for the preview: light from the top-left, low
const L = (() => { const v = [-0.6, 0.55, 0.58]; const m = Math.hypot(...v); return v.map((c) => c / m) })()
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const gx = hAt(x + 1, y - 1) + 2 * hAt(x + 1, y) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x - 1, y) - hAt(x - 1, y + 1)
    const gy = hAt(x - 1, y + 1) + 2 * hAt(x, y + 1) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x, y - 1) - hAt(x + 1, y - 1)
    // image y runs down, texture v up: d/dv = -d/dy
    let nx = -gx * CFG.normalStrength
    let ny = gy * CFG.normalStrength
    let nz = 1
    const m = Math.hypot(nx, ny, nz)
    nx /= m
    ny /= m
    nz /= m
    const p = y * w + x
    normal[p * 3] = Math.round((nx * 0.5 + 0.5) * 255)
    normal[p * 3 + 1] = Math.round((ny * 0.5 + 0.5) * 255)
    normal[p * 3 + 2] = Math.round((nz * 0.5 + 0.5) * 255)
    shade[p] = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]) / L[2]
  }
await sharp(normal, { raw: { width: w, height: h, channels: 3 } }).png().toFile(outDir + "normal.png")

// ---------- preview-height.png: height (left) | colour x hillshade (right)
{
  const colorSmall = await sharp(outDir + "color.webp").resize(w, h).removeAlpha().raw().toBuffer()
  const out = Buffer.alloc(w * 2 * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      const g = Math.round(height[p] * 255)
      const o = (y * w * 2 + x) * 3
      out[o] = out[o + 1] = out[o + 2] = g
      const q = (y * w * 2 + w + x) * 3
      for (let c = 0; c < 3; c++) out[q + c] = Math.min(255, Math.round(colorSmall[p * 3 + c] * (0.55 + 0.45 * shade[p])))
    }
  await sharp(out, { raw: { width: w * 2, height: h, channels: 3 } }).png().toFile(outDir + "preview-height.png")
}

let maxH = 0
let sum = 0
for (const v of height) {
  maxH = Math.max(maxH, v)
  sum += v
}
console.log(`height.png / normal.png ${w}x${h}: land coverage p5..p99.5 ${lo}..${peak}/255, max height ${maxH.toFixed(2)}, mean ${(sum / N).toFixed(3)}`)
console.log("wrote public/maps/3d/: color.webp, sea-tile.webp, height.png, normal.png, preview-height.png")
