// Splits the single traced map (public/maps/protheka.svg) into three level-of-detail tiers by shape size:
//   large  -> protheka-base.svg     (landmasses, coastlines, lettering, banners, compass, frame)
//   medium -> protheka-terrain.svg  (mountain and forest masses)
//   small  -> protheka-detail.svg   (individual trees, fine ridges and texture)
// Usage: npm run lod                 (defaults below)
//        npm run lod -- --base=600 --terrain=60 --res=4
//
// Two problems a naive split has, and what this does about them:
// 1. Stacking. Tiers are drawn base, then terrain, then detail, so a small shape that a later large shape
//    covered in the original would end up on top. Each shape is rendered in a unique flat colour with
//    antialiasing off ("ID buffer"), in the original and in the tiered order; wherever the topmost shape
//    differs, the offending shape moves down to the covering shape's tier (or is dropped if it is never
//    visible in the original). Repeat until nothing differs.
// 2. Holes. The art is traced with abutting shapes: removing small ones doesn't reveal land underneath, it
//    leaves holes. The base tier therefore starts with a small blurred raster that fills every hole with
//    the colours of the surrounding base art (normalised-convolution inpainting), so the overview reads as
//    clean land; terrain/detail cover it as they fade in.
// Outputs are optimised with svgo (multipass, precision 1). The stacked result is compared with the
// original, and preview PNGs are written to lod-preview/.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { svgPathBbox } from "svg-path-bbox"
import { optimize } from "svgo"

const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`))
  return a ? Number(a.split("=")[1]) : def
}
const CONFIG = {
  baseMinArea: arg("base", 600),    // bbox area (viewBox units^2; the map is 903 x 672.75) at/above -> base
  terrainMinArea: arg("terrain", 60), // at/above -> terrain, below -> detail
  idScale: arg("res", 4),           // px per viewBox unit for the ID buffers (stacking check)
  underlayWidth: 452,               // px width of the hole-filling raster under the base tier
  previewWidth: 1400,
  diffWidth: 1806,
  maxIterations: 30,
}
const TIERS = ["base", "terrain", "detail"]

const maps = fileURLToPath(new URL("../public/maps/", import.meta.url))
const previewDir = fileURLToPath(new URL("../lod-preview/", import.meta.url))
const kb = (n) => `${(n / 1024).toFixed(0)} KiB`

// ---------- parse
const src = await readFile(maps + "protheka.svg", "utf8")
const viewBox = src.match(/<svg\b[^>]*\bviewBox="([^"]+)"/)[1]
const [, , vbW, vbH] = viewBox.split(/[\s,]+/).map(Number)
const defs = src.match(/<defs>[\s\S]*?<\/defs>/)?.[0] ?? ""
const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`
const tagRe = /<(path|circle|rect|polygon|ellipse)\b([^>]*?)\/>/g
const els = [...src.matchAll(tagRe)].map((m) => {
  const a = Object.fromEntries([...m[2].matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
  let b
  if (m[1] === "path") b = svgPathBbox(a.d)
  else if (m[1] === "circle") b = [+a.cx - +a.r, +a.cy - +a.r, +a.cx + +a.r, +a.cy + +a.r]
  else if (m[1] === "ellipse") b = [+a.cx - +a.rx, +a.cy - +a.ry, +a.cx + +a.rx, +a.cy + +a.ry]
  else if (m[1] === "rect") b = [+(a.x ?? 0), +(a.y ?? 0), +(a.x ?? 0) + +a.width, +(a.y ?? 0) + +a.height]
  else {
    const p = a.points.trim().split(/[\s,]+/).map(Number)
    const xs = p.filter((_, k) => k % 2 === 0)
    const ys = p.filter((_, k) => k % 2 === 1)
    b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
  const area = (b[2] - b[0]) * (b[3] - b[1])
  const tier = area >= CONFIG.baseMinArea ? 0 : area >= CONFIG.terrainMinArea ? 1 : 2
  return { raw: m[0], area, tier, sizeTier: tier }
})
const leftovers = src.replace(defs, "").replace(tagRe, "").replace(/<\/?svg\b[^>]*>/g, "").trim()
if (leftovers) console.warn(`warning: unhandled markup in the source: ${leftovers.slice(0, 120)}…`)
console.log(`parsed ${els.length} shapes, viewBox ${viewBox}`)

// ---------- ID buffers: which shape is on top at every pixel, for a given draw order
const W = Math.round(vbW * CONFIG.idScale)
const H = Math.round(vbH * CONFIG.idScale)
// scattered colours, so the odd blended edge pixel can't decode to a neighbouring id
const idColor = els.map((_, i) => ((i + 1) * 2654435761) & 0xffffff)
const colorToId = new Map(idColor.map((c, i) => [c, i]))
if (colorToId.size !== els.length) throw new Error("ID colour collision")
const flat = (raw, hex) => raw.replace(/\s(class|style|fill)="[^"]*"/g, "").replace(/\/>$/, ` fill="${hex}"/>`)
async function renderIds(order) {
  const body = order.map((i) => flat(els[i].raw, "#" + idColor[i].toString(16).padStart(6, "0"))).join("")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${W}" height="${H}" shape-rendering="crispEdges">${body}</svg>`
  const px = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
  const ids = new Int32Array(W * H)
  let blended = 0
  for (let p = 0; p < W * H; p++) {
    if (px[p * 4 + 3] === 0) {
      ids[p] = -1
      continue
    }
    const id = colorToId.get((px[p * 4] << 16) | (px[p * 4 + 1] << 8) | px[p * 4 + 2])
    if (id === undefined) blended++
    ids[p] = id ?? -2
  }
  return { ids, blended }
}

const t0 = Date.now()
const orig = await renderIds(els.map((_, i) => i))
const visible = new Int32Array(els.length)
for (const id of orig.ids) if (id >= 0) visible[id]++
console.log(`ID buffer ${W}x${H} (${CONFIG.idScale} px/unit), unreadable edge pixels: ${orig.blended}`)

// never visible in the original: contributes nothing, drop it
const kept = els.map((_, i) => i).filter((i) => visible[i] > 0)
console.log(`hidden in the original (dropped): ${els.length - kept.length}`)
const initial = TIERS.map((_, t) => kept.filter((i) => els[i].tier === t).length)

let mismatch = 0
for (let iter = 1; iter <= CONFIG.maxIterations; iter++) {
  const order = [0, 1, 2].flatMap((t) => kept.filter((i) => els[i].tier === t))
  const { ids } = await renderIds(order)
  mismatch = 0
  const moveTo = new Map()
  for (let p = 0; p < ids.length; p++) {
    const a = ids[p]
    const o = orig.ids[p]
    if (a === o || a < 0 || o < 0) continue
    mismatch++
    // `a` is on top here but was under `o` in the original: it can only be because `o` sits in a lower
    // tier, so `a` moves down to that tier (keeping original order within it)
    if (els[a].tier > els[o].tier) moveTo.set(a, Math.min(moveTo.get(a) ?? 2, els[o].tier))
  }
  console.log(`  stacking pass ${iter}: ${mismatch} px differ, ${moveTo.size} shapes move down a tier`)
  if (moveTo.size === 0) break
  for (const [i, t] of moveTo) els[i].tier = t
}
const counts = TIERS.map((_, t) => kept.filter((i) => els[i].tier === t).length)
const moved = (from, to) => kept.filter((i) => els[i].sizeTier === from && els[i].tier === to).length
console.log(
  `stacking fixed in ${((Date.now() - t0) / 1000).toFixed(1)}s; moved down: ` +
    `terrain->base ${moved(1, 0)}, detail->base ${moved(2, 0)}, detail->terrain ${moved(2, 1)}`,
)

// ---------- underlay: fill the base tier's holes with the surrounding base colours
const baseBody = kept.filter((i) => els[i].tier === 0).map((i) => els[i].raw).join("")
async function inpaintUnderlay() {
  const uw = CONFIG.underlayWidth
  const uh = Math.round((uw * vbH) / vbW)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${uw}" height="${uh}">${defs}${baseBody}</svg>`
  const px = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer()
  const n = uw * uh
  const out = new Float32Array(n * 4) // premultiplied, 0..1
  for (let p = 0; p < n; p++) {
    const a = px[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) out[p * 4 + c] = (px[p * 4 + c] / 255) * a
    out[p * 4 + 3] = a
  }
  const band = (k) => {
    const b = Buffer.alloc(n)
    for (let p = 0; p < n; p++) b[p] = Math.round(Math.min(1, out[p * 4 + k]) * 255)
    return b
  }
  // pyramid of normalised convolutions: small holes fill from nearby colours, big ones from further out
  const src4 = [0, 1, 2, 3].map(band)
  for (const sigma of [1, 2, 4, 8, 16, 32, 64]) {
    const blurred = await Promise.all(
      src4.map((b) => sharp(b, { raw: { width: uw, height: uh, channels: 1 } }).blur(sigma).raw().toBuffer()),
    )
    for (let p = 0; p < n; p++) {
      const holeA = 1 - out[p * 4 + 3]
      const wa = blurred[3][p] / 255
      if (holeA <= 0.001 || wa < 0.05) continue
      for (let c = 0; c < 3; c++) out[p * 4 + c] += holeA * Math.min(1, blurred[c][p] / 255 / wa)
      out[p * 4 + 3] = 1
    }
  }
  const rgb = Buffer.alloc(n * 3)
  for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round(Math.min(1, out[p * 4 + c]) * 255)
  // JPEG, not WebP: librsvg (sharp, used for the previews/diff) can't decode WebP inside an SVG
  const jpeg = await sharp(rgb, { raw: { width: uw, height: uh, channels: 3 } }).blur(0.8).jpeg({ quality: 72, mozjpeg: true }).toBuffer()
  return `<image width="${vbW}" height="${vbH}" preserveAspectRatio="none" href="data:image/jpeg;base64,${jpeg.toString("base64")}"/>`
}
const underlay = await inpaintUnderlay()

// ---------- write + optimise the tiers
const tierSvg = (t) =>
  svgOpen + defs + (t === 0 ? underlay : "") + kept.filter((i) => els[i].tier === t).map((i) => els[i].raw).join("") + "</svg>"
const files = []
for (let t = 0; t < 3; t++) {
  const raw = tierSvg(t)
  // svgo sometimes drops preserveAspectRatio from <image>; the underlay's pixel size can't match the
  // map's odd aspect exactly, so make sure it stretches instead of letterboxing
  const data = optimize(raw, { multipass: true, floatPrecision: 1 }).data.replace(
    /<image (?![^>]*preserveAspectRatio)/,
    '<image preserveAspectRatio="none" ',
  )
  const file = `protheka-${TIERS[t]}.svg`
  await writeFile(maps + file, data)
  files.push({ file, shapes: counts[t], raw: raw.length, size: Buffer.byteLength(data), data })
}

// ---------- stacking check: stacked tiers vs the original (both over the same underlay)
const renderAt = (svg, w) => sharp(Buffer.from(svg), { density: (72 * w) / vbW }).resize(w).png().toBuffer()
async function stack(svgs, w, background) {
  const layers = await Promise.all(svgs.map((s) => renderAt(s, w)))
  // composite first, flatten in a second pass (sharp applies flatten before composite in one pipeline)
  const composed = layers.length > 1 ? await sharp(layers[0]).composite(layers.slice(1).map((input) => ({ input }))).png().toBuffer() : layers[0]
  return sharp(composed).flatten({ background }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
}
const underlayOnly = svgOpen + underlay + "</svg>"
const minSvg = await readFile(maps + "protheka.min.svg", "utf8")
const a = await stack([underlayOnly, minSvg], CONFIG.diffWidth, "#ffffff")
const b = await stack(files.map((f) => f.data), CONFIG.diffWidth, "#ffffff")
let sum = 0
let noticeable = 0
const pixels = a.info.width * a.info.height
for (let p = 0; p < pixels; p++) {
  let m = 0
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(a.data[p * 3 + c] - b.data[p * 3 + c])
    sum += d
    m = Math.max(m, d)
  }
  if (m > 32) noticeable++
}

// ---------- previews
await mkdir(previewDir, { recursive: true })
const previews = [
  ["1-base.png", [files[0].data]],
  ["2-base+terrain.png", [files[0].data, files[1].data]],
  ["3-all-tiers.png", files.map((f) => f.data)],
  ["0-original.png", [minSvg]],
]
for (const [name, svgs] of previews) {
  const { data, info } = await stack(svgs, CONFIG.previewWidth, "#ffffff")
  await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toFile(previewDir + name)
}

// ---------- report
console.log(`\nthresholds: base >= ${CONFIG.baseMinArea}, terrain >= ${CONFIG.terrainMinArea} (bbox area, units^2)`)
console.log(`initial tiers (by size): base ${initial[0]}, terrain ${initial[1]}, detail ${initial[2]}`)
for (const f of files) console.log(`${f.file.padEnd(22)} ${String(f.shapes).padStart(5)} shapes  ${kb(f.raw).padStart(9)} -> ${kb(f.size).padStart(8)} (svgo)`)
console.log(`${"total".padEnd(22)} ${String(kept.length).padStart(5)} shapes  ${"".padStart(9)}    ${kb(files.reduce((s, f) => s + f.size, 0)).padStart(8)}   (protheka.min.svg: ${kb(Buffer.byteLength(minSvg))})`)
console.log(`stacking: ${mismatch} px of ${W * H} still on the wrong layer after the fix (ID buffer)`)
console.log(`stacked vs original (${a.info.width}px): mean |diff| ${(sum / (pixels * 3)).toFixed(3)} / 255, noticeable (>32) ${((noticeable / pixels) * 100).toFixed(3)}% of pixels`)
console.log(`previews: ${previews.map(([n]) => "lod-preview/" + n).join(", ")}`)
