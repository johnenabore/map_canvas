// Textures for the /lab/3d spike, rendered from the three LOD tiers with sharp (as in scripts/raster.mjs).
// Usage: npm run gen3d -> public/maps/3d/ (+ the preview in lab3d-preview/)
//   color.webp          base+terrain+detail at 4096px, the title/legend band and the frame replaced by open
//                       sea, land along the old frame edges dissolving into mist (the compass, the region
//                       names and the labels listed in CFG.labels stay, and the dissolve runs shallow where
//                       the opening view can see it); the open sea inside gets the sea tile's wave marks,
//                       faint, so it isn't flat and empty
//   sea-tile.webp       seamless sea (parchment tone + faint ink wave marks) for the world plane around the
//                       map; the same tile is painted into color.webp's sea margin on the same grid, so the
//                       two meet without a seam
//   height.png          1024px, 16-bit height in two bytes: R = high byte (on its own the 8-bit height the
//                       displacement and the pins read), G = low byte (the scene's shader derives normals
//                       from R+G, so no normal map is needed and 8-bit terracing doesn't ripple the light);
//                       land plateau 0.15 + relief 0.85, rising from the coast over a smooth ramp; sea and
//                       removed areas exactly 0
//   land-bounds.json    bounding box of the land (the flood-fill land mask, where it survives the dissolve),
//                       in map UV (v down from the top edge) and world units; the scene frames the camera on it
//   lab3d-preview/preview-height.png   height | hillshaded colour, for judging the relief (git-ignored)
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"
import { svgPathBbox } from "svg-path-bbox"

const maps = fileURLToPath(new URL("../public/maps/", import.meta.url))
const outDir = maps + "3d/"
const previewDir = fileURLToPath(new URL("../lab3d-preview/", import.meta.url))
const VIEWBOX_W = 903 // matches MAP.w in lib/map.ts
const VIEWBOX_H = 672.8 // the traced map's viewBox height (MAP.h rounded, as in the svgs)
const WORLD = { w: 903 / 100, h: 672.75 / 100 } // the scene's map plane: MAP.w/100 x MAP.h/100 world units

const CFG = {
  // 3072, not 4096: the base tier is only ever seen at or below the zoom where the terrain tier arrives
  // (it is 1:1 at about that zoom), and 4096 x 3052 RGBA8 costs 67 MB of GPU memory with its mipmaps
  // against 37 MB here -- 29 MB saved for detail the reader never gets close enough to want.
  colorW: 3072,
  // the two upper tiers cover 14% and 5% of the map, so they carry far less than the base and can be
  // much smaller: 9 MB each on the GPU instead of 50
  overlayW: 1536,
  heightW: 1024,
  quality: 85,
  top: 0.14,           // title/legend band, fraction of the map height
  frame: 0.03,         // frame border, fraction of the map width (all four sides)
  // The dissolve, in fractions of the map width. Its depth -- how far inward of the map's edge the land
  // goes from open sea to fully intact -- is frame + fade, give or take fadeNoise. It runs shallow along
  // the stretches the opening (cover) view shows, where a deeper dissolve eats into the region names and
  // the coast, and deep where only the fully zoomed-out view reaches, which is what stops the island
  // reading as a rectangle. coverSpans() works out which stretch is which.
  fade: { visible: 0.04, hidden: 0.08 },       // land dissolves into mist over this, inward of the removed areas
  fadeNoise: { visible: 0.012, hidden: 0.03 }, // how ragged the dissolve edge is
  edgeBlend: 0.09,     // the two depths cross-fade over this, along an edge and around the corners
  // the scene's opening view, for deciding which stretches it shows: LAB3D.fov in components/lab3d/Scene.tsx,
  // and the two orientations to cover (landscape, portrait)
  cover: { fov: 40, aspects: [16 / 9, 9 / 16] },
  mist: 0.3,           // lightening in the middle of the dissolve
  compass: { x: 0.44, y: 0.892, r: 0.075 }, // kept: centre (fraction of w/h), radius (fraction of the width)
  // Lettering kept out of the dissolve. The traced art has no groups or ids, but the display lettering is
  // the one thing with a colour of its own: every path painted letterFill in the base tier is a glyph of
  // the big names, and nothing else is one. CFG.labels names the other text the dissolve reaches; each
  // rect (viewBox units, x0 y0 x1 y1) selects the shapes that sit wholly inside it, in any tier, and it is
  // those shapes that are protected, not the rectangle.
  letterFill: "#f4efcf",
  letterGuard: 3,      // viewBox units: protected halo around each shape, covering the outline drawn round it
                       // (wider and it starts keeping the dark art behind a glyph as a smudge in the mist)
  letterFeather: 3,    // viewBox units: soft edge on that halo, so the mask has no step in it
  letterRelief: 26,    // viewBox units: the height mask is this much wider and smoothed, so the ground under
                       // the lettering stays up without glyph-shaped mesas appearing in the relief
  labelClip: 0.008,    // fraction of the map width: a label's protection fades out over this as it nears the
                       // removed band, so no rect can bring a piece of the frame back with it
  labels: [
    ["Calyn banner (bottom left)", 126, 606, 200, 640],
    ["unlettered banner (bottom right)", 766, 613, 812, 644],
    ["banner above Osiris (right)", 756, 330, 840, 362],
    ["Osiris (right)", 812, 354, 862, 402],
  ],
  seaTol: 18,          // flood fill: max per-channel distance from the sea colour
  letterCream: 0.3,    // an enclosed pocket that's at least this cream is lettering on the sea, not land
  minLand: 40,         // px (at 1024): smaller pockets are specks, not land
  land: 0.15,
  coastRamp: 16,       // px at 1024: the land plateau rises from 0 at the coast over this...
  reliefRamp: 48,      // ...and the relief over this, so coasts are gentle lowlands (soft rims, no cliff)
  relief: 0.85,
  reliefBlur: 24,      // gaussian sigma, px at 1024 (in float, so no 8-bit terraces)
  tile: 512,           // sea tile, px; 8 tiles across the 4096px map, so the scene can line the world plane up
  waves: 26,           // ink wave marks per tile
  seaMarks: 0.6,       // the tile's wave marks on the open sea inside the map, at this x their opacity (faint)
  marksClear: 5,       // px at 1024: they fade out over this towards anything drawn on the sea (coast, lettering)
  // the hillshade in the preview mimics the scene's shader normals and lights: LAB3D.displacementScale,
  // LAB3D.reliefExaggeration and LAB3D.sun.position in components/lab3d/Scene.tsx; ambient = the ambient
  // light's share of flat ground's light (LAB3D.ambient.intensity / (that + sun intensity x its height))
  preview: { displacement: 0.12, exaggeration: 3.5, sun: [-7, 13.8, -5], ambient: 0.51 },
}
// open-sea sample boxes (fractions of w/h), for the sea colour and as flood-fill seeds
const SEA = [[0.18, 0.56, 0.3, 0.64], [0.33, 0.57, 0.39, 0.62], [0.79, 0.73, 0.91, 0.79], [0.59, 0.745, 0.68, 0.79], [0.05, 0.36, 0.1, 0.43]]

// ---------- render the stacked tiers
const render = async (svg, w) => sharp(svg, { density: (72 * w) / VIEWBOX_W }).resize(w).png().toBuffer()
const svgs = await Promise.all(["base", "terrain", "detail"].map((t) => readFile(`${maps}protheka-${t}.svg`)))
const tiers = await Promise.all(svgs.map((s) => render(s, CFG.colorW)))
// composite first, then read out in a second pipeline (sharp resizes before compositing in one pipeline).
// The stacked map is what the sea colour and the land mask are read from - terrain and detail don't change
// where the water is, and the mask should see the map as drawn.
const stacked = await sharp(tiers[0]).composite(tiers.slice(1).map((input) => ({ input }))).png().toBuffer()
// color.webp carries the base tier alone; the two upper tiers ship as overlays the shader soaks in as the
// reader zooms, so that "zooming reveals terrain detail" is a real reveal and not a magnified raster.
const big = await sharp(tiers[0]).removeAlpha().raw().toBuffer({ resolveWithObject: true })
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

// ---------- seamless sea tile: sea tone, soft mottling, faint ink wave marks (drawn with wrap-around); the
// marks' alpha (tileInk, RGBA) is kept for the open sea inside the map
const T = CFG.tile
const INK = [63, 29, 14]
const [tile, tileInk] = await (async () => {
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
      for (let c = 0; c < 3; c++) px[i * 3 + c] = sea[c] * m * (1 - al) + INK[c] * al
    }
  // keep the tile's average exactly on the sea colour, so map and world sea match in tone
  for (let c = 0; c < 3; c++) {
    let s = 0
    for (let i = 0; i < T * T; i++) s += px[i * 3 + c]
    const shift = sea[c] - s / (T * T)
    for (let i = 0; i < T * T; i++) px[i * 3 + c] += shift
  }
  return [px, ink]
})()
await mkdir(outDir, { recursive: true })
await sharp(Buffer.from(tile.map((v) => Math.max(0, Math.min(255, Math.round(v))))), { raw: { width: T, height: T, channels: 3 } })
  .webp({ quality: 90 })
  .toFile(outDir + "sea-tile.webp")

// ---------- the removed areas: how far inside them a point is (in map widths, negative once removed), and
// the compass, which is kept whole. u, t = fractions of the map width/height.
const aspect = H / W
const smooth = (e) => (e <= 0 ? 0 : e >= 1 ? 1 : e * e * (3 - 2 * e))
const mix = (a, b, f) => a + (b - a) * f
// each of the four edges' distance inward: left, right, top (the title/legend band), bottom
const edgeDist = (u, t) => [u - CFG.frame, 1 - CFG.frame - u, (t - CFG.top) * aspect, (1 - CFG.frame / aspect - t) * aspect]
const insideAt = (u, t) => Math.min(...edgeDist(u, t))
const compassK = (u, t) => {
  const d = Math.hypot(u - CFG.compass.x, (t - CFG.compass.y) * aspect)
  return 1 - smooth((d - CFG.compass.r) / 0.006)
}
// the ragged edge: a fine lattice, with a coarser one mixed in as the dissolve deepens, so the deep
// stretches wander in big lobes instead of spikes the size of their own amplitude
const edgeFine = lattice(36, Math.round(36 * aspect), 7, false)
const edgeCoarse = lattice(11, Math.round(11 * aspect), 29, false)
const ragged = (u, t, vis) => mix(0.45 * edgeFine(u, t) + 0.55 * edgeCoarse(u, t), edgeFine(u, t), vis)

// ---------- land mask: flood-fill the sea from open-sea seeds over sea-coloured pixels, inside the old
// frame only (land cut off by the frame then stays land); what the sea doesn't reach is land, except
// pockets that are mostly cream (lettering on the sea) or tiny. openSea = what the fill reached.
const N = w * h
const isSea = new Uint8Array(N)
const openSea = new Uint8Array(N)
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
  openSea.set(isSea)
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

// chamfer distance (3-4, two passes) in px x 3, in place: each entry becomes its distance to the nearest
// entry that starts at 0 (start the others at 1e9)
function chamfer(dist) {
  for (const [ys, dir] of [[0, 1], [h - 1, -1]])
    for (let y = ys; y >= 0 && y < h; y += dir)
      for (let x = dir > 0 ? 0 : w - 1; x >= 0 && x < w; x += dir) {
        const p = y * w + x
        if (!dist[p]) continue
        for (const [dx, dy, c] of [[-dir, 0, 3], [-dir, -dir, 4], [0, -dir, 3], [dir, -dir, 4]]) {
          const nx = x + dx
          const ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < w && ny < h) dist[p] = Math.min(dist[p], dist[ny * w + nx] + c)
        }
      }
  return dist
}

// separable gaussian over a w x h float field, edges clamped
function gaussian(src, sigma) {
  const r = Math.ceil(sigma * 3)
  const kernel = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)))
  const total = kernel.reduce((a, b) => a + b, 0)
  let cur = src
  for (const horizontal of [true, false]) {
    const dst = new Float32Array(N)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let acc = 0
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k))
          acc += cur[yy * w + xx] * kernel[k + r]
        }
        dst[y * w + x] = acc / total
      }
    cur = dst
  }
  return cur
}

// read a w x h field at u, t (fractions of the map), bilinear
const sampler = (field) => (u, t) => {
  const x = u * (w - 1)
  const y = t * (h - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const top = field[y0 * w + x0] * (1 - fx) + field[y0 * w + x1] * fx
  const bottom = field[y1 * w + x0] * (1 - fx) + field[y1 * w + x1] * fx
  return top * (1 - fy) + bottom * fy
}

// ---------- lettering kept out of the dissolve: the base tier's display lettering (CFG.letterFill), minus
// the glyphs inside the removed title band, plus the shapes CFG.labels' rects pick out of the three tiers.
// Two masks come out of it: a tight one for the colour, and a wide, smoothed one for the height, so the
// ground under the lettering stays up without the glyphs cutting their own silhouettes into the relief.
const [letterKeep, letterRelief] = await (async () => {
  const shapeRe = /<(path|circle|rect|polygon|ellipse)\b([^>]*?)\/>/g
  const picked = [[], []] // display lettering, then the CFG.labels shapes
  const labelHits = CFG.labels.map(() => 0)
  let glyphs = 0
  let dropped = 0
  for (const [tier, svg] of ["base", "terrain", "detail"].map((t, i) => [t, svgs[i].toString("utf8")])) {
    const styles = Object.fromEntries([...svg.matchAll(/\.(cls-\d+)\{fill:(#[0-9a-f]{6})\}/g)].map((m) => [m[1], m[2]]))
    for (const m of svg.matchAll(shapeRe)) {
      if (m[1] !== "path") continue // the traced art is all paths; anything else is neither lettering nor label
      const a = Object.fromEntries([...m[2].matchAll(/([\w:-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
      const lettering = tier === "base" && (a.fill ?? styles[a.class] ?? "") === CFG.letterFill
      const b = svgPathBbox(a.d)
      const label = CFG.labels.findIndex(([, x0, y0, x1, y1]) => b[0] >= x0 && b[1] >= y0 && b[2] <= x1 && b[3] <= y1)
      if (lettering) {
        // the title band's glyphs go with the band: it is removed by design, not by the dissolve
        if (insideAt((b[0] + b[2]) / 2 / VIEWBOX_W, (b[1] + b[3]) / 2 / VIEWBOX_H) < 0) {
          dropped++
          continue
        }
        glyphs++
      } else if (label >= 0) labelHits[label]++
      else continue
      picked[lettering ? 0 : 1].push(m[0])
    }
  }
  const px = (units) => (units * w) / VIEWBOX_W // viewBox units -> mask px
  // each group's distance (in mask px) to the nearest shape it holds
  const distances = await Promise.all(
    picked.map(async (group) => {
      const body = group.map((raw) => raw.replace(/\s(class|style|fill)="[^"]*"/g, "").replace(/\/>$/, ' fill="#fff"/>')).join("")
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX_W} ${VIEWBOX_H}">${body}</svg>`
      const mask = await sharp(Buffer.from(svg), { density: (72 * w) / VIEWBOX_W }).resize(w, h).extractChannel(3).raw().toBuffer()
      if (mask.length !== N) throw new Error(`lettering mask: expected ${N} px, got ${mask.length}`)
      return Float32Array.from(chamfer(Float32Array.from(mask, (a) => (a > 127 ? 0 : 1e9))), (v) => v / 3)
    }),
  )
  const halo = (dist) => Float32Array.from(dist, (v) => 1 - smooth((v - px(CFG.letterGuard)) / px(CFG.letterFeather)))
  const [glyphHalo, labelHalo] = distances.map(halo)
  // the region names are kept whole, the way the compass is, even where they overhang the removed band; a
  // label is faded out as it nears that band instead, so no rect can bring a piece of the frame back with it
  const guard = Float32Array.from(glyphHalo, (v, p) =>
    Math.max(v, labelHalo[p] * smooth(insideAt((p % w) / (w - 1), ((p / w) | 0) / (h - 1)) / CFG.labelClip)),
  )
  const r = px(CFG.letterRelief)
  // the height guard only undoes the dissolve inside the land: past the frame the height is cut to sea
  // anyway, so letting the guard reach that far would leave a cliff for the shader's normals to catch
  const relief = Float32Array.from(gaussian(Float32Array.from(distances[0], (v) => 1 - smooth((v - r) / r)), r / 3), (v, p) =>
    Math.min(v, smooth(insideAt((p % w) / (w - 1), ((p / w) | 0) / (h - 1)) / CFG.fade.visible)),
  )
  console.log(
    `lettering protected: ${glyphs} ${CFG.letterFill} glyphs in the base tier (${dropped} in the removed title band dropped), ` +
      `${CFG.labels.map(([name], i) => `${name} ${labelHits[i]}`).join(", ")}`,
  )
  return [sampler(guard), sampler(relief)]
})()

// ---------- the dissolve: 0 in the removed band and frame, rising to 1 over CFG.fade inward (ragged with
// noise), 1 on the compass and on the protected lettering. The fade is CFG.fade.visible along the stretches
// the opening view shows and CFG.fade.hidden along the rest, crossing over smoothly in between.
// coverSpans: the scene opens at "cover" (components/lab3d/Scene.tsx) -- straight down, the land box filling
// the screen, its tighter axis fitting and the other overflowing, centred on the box. That shows the full
// width of the box in landscape and the full height in portrait, so in each orientation two of the four
// frame stretches are on screen, and only over the span the view reaches. The rest waits for min zoom.
function coverSpans(box) {
  const tan = Math.tan(((CFG.cover.fov / 2) * Math.PI) / 180)
  const bw = (box.u1 - box.u0) * WORLD.w
  const bh = (box.v1 - box.v0) * WORLD.h
  const cu = (box.u0 + box.u1) / 2
  const cv = (box.v0 + box.v1) / 2
  const span = { u: [1, 0], v: [1, 0] } // along the top/bottom and the left/right stretches
  for (const a of CFG.cover.aspects) {
    const d = Math.min(bh / (2 * tan), bw / (2 * tan * a))
    const hu = (d * tan * a) / WORLD.w // half the view on the ground, in map fractions
    const hv = (d * tan) / WORLD.h
    // an edge counts as shown only in the orientations that reach it; the other pair is off screen
    if (cu - hu <= box.u0 + 1e-6) span.v = [Math.min(span.v[0], cv - hv), Math.max(span.v[1], cv + hv)]
    if (cv - hv <= box.v0 + 1e-6) span.u = [Math.min(span.u[0], cu - hu), Math.max(span.u[1], cu + hu)]
  }
  return span
}
// the land box the scene frames on, read off the shallow dissolve and the land alone: protected lettering
// is not land reaching further out, and deepening a corner must not move the camera either
const landBox = (k) => {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!isSea[y * w + x] && k(x / (w - 1), y / (h - 1)) >= 0.5) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
  const r4 = (v) => Math.round(v * 1e4) / 1e4
  return { u0: r4(x0 / w), u1: r4((x1 + 1) / w), v0: r4(y0 / h), v1: r4((y1 + 1) / h) }
}
const dissolveAt = (u, t, fade, amp) => {
  const inside = insideAt(u, t)
  return inside < 0 ? 0 : smooth((inside + amp * ragged(u, t, 1)) / fade)
}
const keepShallow = (u, t) => Math.max(dissolveAt(u, t, CFG.fade.visible, CFG.fadeNoise.visible), compassK(u, t))
const coverBox = landBox(keepShallow)
const shown = coverSpans(coverBox)
// how much of the opening view a stretch is in: 1 over the span it shows, easing to 0 over CFG.edgeBlend
// outside it. The four edges are then weighted by how close each one is, so corners average their two.
const inSpan = ([a, b], x) => Math.min(smooth((x - a) / CFG.edgeBlend + 1), smooth((b - x) / CFG.edgeBlend + 1))
function keep(u, t, guard = 0) {
  const d = edgeDist(u, t)
  const seen = [inSpan(shown.v, t), inSpan(shown.v, t), inSpan(shown.u, u), inSpan(shown.u, u)]
  const inside = Math.min(...d)
  let weight = 0
  let vis = 0
  for (let e = 0; e < 4; e++) {
    const near = smooth((CFG.edgeBlend - (d[e] - inside)) / CFG.edgeBlend)
    weight += near
    vis += near * seen[e]
  }
  vis /= weight
  const fade = mix(CFG.fade.hidden, CFG.fade.visible, vis)
  const amp = mix(CFG.fadeNoise.hidden, CFG.fadeNoise.visible, vis)
  const k = smooth((inside + amp * ragged(u, t, vis)) / fade)
  return Math.max(inside < 0 ? 0 : k, compassK(u, t), guard)
}
{
  const pct = (v) => `${(v * 100).toFixed(1)}%`
  const depth = (vis) => [CFG.frame + mix(CFG.fade.hidden, CFG.fade.visible, vis), mix(CFG.fadeNoise.hidden, CFG.fadeNoise.visible, vis)]
  const range = (vis) => { const [d, n] = depth(vis); return `${pct(d - n)}..${pct(d + n)}` }
  console.log(
    `cover shows: the left/right stretches over v ${shown.v.map((x) => x.toFixed(3)).join("..")}, ` +
      `the top/bottom over u ${shown.u.map((x) => x.toFixed(3)).join("..")}`,
  )
  console.log(`dissolve depth (of the map width): shown ${range(1)}, hidden ${range(0)}`)
}

// ---------- color.webp: map where k = 1, sea tile (same grid as the world plane) where k = 0, mist between;
// on the open sea inside, the tile's wave marks at CFG.seaMarks x their opacity, fading out over
// CFG.marksClear towards anything that isn't open sea (so they never touch a coast or a letter)
{
  const marksAt = sampler(
    Float32Array.from(chamfer(Float32Array.from(openSea, (s) => (s ? 1e9 : 0))), (v) => smooth(v / 3 / CFG.marksClear)),
  )
  const mistNoise = lattice(60, Math.round(60 * aspect), 19, false)
  const out = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    const t = y / (H - 1)
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1)
      const k = keep(u, t, letterKeep(u, t))
      const i = (y * W + x) * 3
      const tp = (y % T) * T + (x % T)
      const ink = tileInk[tp * 4 + 3]
      const a = ink && k > 0 ? (ink / 255) * CFG.seaMarks * marksAt(u, t) : 0
      const mist = CFG.mist * 4 * k * (1 - k) * (0.65 + 0.35 * mistNoise(u, t))
      for (let c = 0; c < 3; c++) {
        const v = tile[tp * 3 + c] * (1 - k) + (big.data[i + c] * (1 - a) + INK[c] * a) * k
        out[i + c] = Math.max(0, Math.min(255, Math.round(v + (255 - v) * mist * 0.5)))
      }
    }
  }
  const info = await sharp(out, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: CFG.quality }).toFile(outDir + "color.webp")
  console.log(`color.webp ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KiB (base tier)`)
}

// ---------- terrain.webp / detail.webp: the two upper tiers as overlays, for the scene to soak in over the
// base as the reader zooms (the ink-spread reveal in components/lab3d/Scene.tsx). RGB is the tier's own art,
// straight (not premultiplied) alpha is its own coverage times the dissolve, so an overlay thins out at the
// island's edge exactly in step with the base beneath it.
//
// The rasteriser leaves RGB black wherever a tier draws nothing, and both lossy WebP and the GPU's bilinear
// filter mix that black into the texels along every shape's edge - a dark fringe around every tree. So the
// art's own colour is bled a few texels outwards first, by the same normalised convolution that
// scripts/split-lod.mjs uses to fill the base tier's holes. Alpha is never touched, so the bleed can only
// change pixels that are already transparent: nothing new becomes visible.
async function bleedEdges(rgba, width, height) {
  const n = width * height
  const src = [0, 1, 2, 3].map((c) => {
    const b = Buffer.alloc(n)
    // premultiplied, which is what a normalised convolution needs: sum(colour x weight) / sum(weight)
    for (let p = 0; p < n; p++) b[p] = c === 3 ? rgba[p * 4 + 3] : Math.round((rgba[p * 4 + c] * rgba[p * 4 + 3]) / 255)
    return b
  })
  const out = Float32Array.from({ length: n * 3 }, (_, i) => rgba[((i / 3) | 0) * 4 + (i % 3)] / 255)
  const filled = Uint8Array.from({ length: n }, (_, p) => (rgba[p * 4 + 3] > 0 ? 1 : 0))
  for (const sigma of [1, 2, 4, 8]) {
    const blurred = await Promise.all(
      src.map((b) => sharp(b, { raw: { width, height, channels: 1 } }).blur(sigma).raw().toBuffer()),
    )
    for (let p = 0; p < n; p++) {
      if (filled[p]) continue
      const wa = blurred[3][p] / 255
      if (wa < 0.05) continue // nothing opaque within reach at this radius; a wider one may find some
      for (let c = 0; c < 3; c++) out[p * 3 + c] = Math.min(1, blurred[c][p] / 255 / wa)
      filled[p] = 1
    }
  }
  const px = Buffer.alloc(n * 4)
  for (let p = 0; p < n; p++) {
    for (let c = 0; c < 3; c++) px[p * 4 + c] = Math.round(out[p * 3 + c] * 255)
    px[p * 4 + 3] = rgba[p * 4 + 3]
  }
  return px
}

for (const [i, name] of [[1, "terrain"], [2, "detail"]]) {
  const { data: px, info: size } = await sharp(await render(svgs[i], CFG.overlayW)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const ow = size.width
  const oh = size.height
  let covered = 0
  for (let y = 0; y < oh; y++) {
    const t = y / (oh - 1)
    for (let x = 0; x < ow; x++) {
      const p = (y * ow + x) * 4
      if (!px[p + 3]) continue
      const u = x / (ow - 1)
      px[p + 3] = Math.round(px[p + 3] * keep(u, t, letterKeep(u, t)))
      if (px[p + 3] > 127) covered++
    }
  }
  const info = await sharp(await bleedEdges(px, ow, oh), { raw: { width: ow, height: oh, channels: 4 } })
    .webp({ quality: CFG.quality, alphaQuality: 100 })
    .toFile(outDir + name + ".webp")
  console.log(`${name}.webp ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KiB, covers ${((covered / (ow * oh)) * 100).toFixed(1)}% of the map`)
}

// ---------- height: relief from the terrain+detail coverage (blurred in float), on a land plateau that rises
// from the coast over a smooth ramp (distance into the land), so the sea stays exactly 0 and the coast step
// is soft
const reliefTiers = await Promise.all(svgs.slice(1).map((s) => render(s, CFG.heightW)))
const reliefRaw = await sharp(reliefTiers[0]).composite([{ input: reliefTiers[1] }]).png().toBuffer()
const alpha = await sharp(reliefRaw).extractChannel(3).raw().toBuffer()
if (alpha.length !== N) throw new Error(`expected ${N} px, got ${alpha.length}`)
// sRGB-encoded after the blur: the earlier (8-bit, sharp) version blurred in linear light and returned encoded
// values, which lifts sparse areas; this keeps that relief curve, just without the 8-bit terraces
const srgbEncode = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
const coverage = gaussian(Float32Array.from(alpha, (a) => a / 255), CFG.reliefBlur).map(srgbEncode)
// normalized = stretched between the 5th and 99.5th percentile of coverage on land (coverage saturates
// over most of the land, so dividing by the peak alone would leave a flat plateau)
const onLand = Array.from(coverage).filter((_, p) => !isSea[p]).sort((a, b) => a - b)
const lo = onLand[Math.floor(onLand.length * 0.05)]
const peak = Math.max(lo + 1e-3, onLand[Math.floor(onLand.length * 0.995)])
// distance into the land, px x 3
const dist = chamfer(Float32Array.from(isSea, (s) => (s ? 0 : 1e9)))
// the ramps, blurred so the chamfer distance's straight creases (its medial axis) don't show in the shading
const rampAt = (len, sigma) => gaussian(Float32Array.from(dist, (v, p) => (isSea[p] ? 0 : smooth(v / 3 / len))), sigma)
const plateauRamp = rampAt(CFG.coastRamp, 3)
const reliefRamp = rampAt(CFG.reliefRamp, 8)
const height = new Float32Array(N)
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const p = y * w + x
    if (isSea[p]) continue
    const u = x / (w - 1)
    const t = y / (h - 1)
    const relief = Math.max(0, Math.min(1, (coverage[p] - lo) / (peak - lo))) * CFG.relief
    // removed areas and the compass stay flat; the ground under the lettering keeps its height, on a mask
    // wide and smooth enough that no glyph cuts its own outline into the relief
    const k = keep(u, t, letterRelief(u, t)) * (1 - compassK(u, t))
    height[p] = Math.min(1, (plateauRamp[p] * CFG.land + reliefRamp[p] * relief) * k)
  }
{
  const out = Buffer.alloc(N * 3)
  for (let p = 0; p < N; p++) {
    const v = Math.round(height[p] * 65535)
    out[p * 3] = out[p * 3 + 2] = v >> 8
    out[p * 3 + 1] = v & 255
  }
  await sharp(out, { raw: { width: w, height: h, channels: 3 } }).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(outDir + "height.png")
}

// ---------- land-bounds.json: the box the scene frames the opening view on. It is coverBox -- the land
// mask where the shallow dissolve keeps at least half of it -- so that deepening a corner, which only the
// fully zoomed-out view sees, can never move the camera. Any drift against the box the deep dissolve would
// have given is reported below, as land that survives the opening view but not min zoom.
const bounds = (() => {
  const r4 = (v) => Math.round(v * 1e4) / 1e4
  const uv = coverBox
  const deep = landBox((u, t) => keep(u, t))
  const drift = ["u0", "u1", "v0", "v1"].filter((k) => Math.abs(deep[k] - uv[k]) > 1e-4)
  console.log(
    drift.length
      ? `land bounds: kept at the cover box; the deep dissolve would have moved ${drift.map((k) => `${k} ${uv[k]}->${deep[k]}`).join(", ")}`
      : "land bounds: the deep dissolve leaves the box unchanged",
  )
  return {
    note: "land bounding box. uv: fractions of the map, v down from the top edge. world: the scene's map plane, centred on the origin, x right, z south (down the map).",
    uv,
    world: {
      x0: r4((uv.u0 - 0.5) * WORLD.w),
      x1: r4((uv.u1 - 0.5) * WORLD.w),
      z0: r4((uv.v0 - 0.5) * WORLD.h),
      z1: r4((uv.v1 - 0.5) * WORLD.h),
    },
  }
})()
await writeFile(outDir + "land-bounds.json", JSON.stringify(bounds, null, 2) + "\n")

// ---------- preview-height.png: height (left) | colour x hillshade (right), shaded like the scene's shader
{
  const P = CFG.preview
  const s = (P.displacement / (2 * (WORLD.w / w))) * P.exaggeration
  const L = (() => {
    const m = Math.hypot(...P.sun)
    return P.sun.map((c) => c / m)
  })()
  const hAt = (x, y) => height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  const colorSmall = await sharp(outDir + "color.webp").resize(w, h).removeAlpha().raw().toBuffer()
  const out = Buffer.alloc(w * 2 * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // world normal of the displaced surface: x right, y up, z south (image down)
      const n = [(hAt(x - 1, y) - hAt(x + 1, y)) * s, 1, (hAt(x, y - 1) - hAt(x, y + 1)) * s]
      const m = Math.hypot(...n)
      const shade = Math.max(0, (n[0] * L[0] + n[1] * L[1] + n[2] * L[2]) / m) / L[1]
      const g = Math.round(height[p] * 255)
      const o = (y * w * 2 + x) * 3
      out[o] = out[o + 1] = out[o + 2] = g
      const q = (y * w * 2 + w + x) * 3
      for (let c = 0; c < 3; c++) out[q + c] = Math.min(255, Math.round(colorSmall[p * 3 + c] * (P.ambient + (1 - P.ambient) * shade)))
    }
  await mkdir(previewDir, { recursive: true })
  await sharp(out, { raw: { width: w * 2, height: h, channels: 3 } }).png().toFile(previewDir + "preview-height.png")
}

let maxH = 0
let sum = 0
for (const v of height) {
  maxH = Math.max(maxH, v)
  sum += v
}
console.log(`height.png ${w}x${h} (16-bit in R+G): land coverage p5..p99.5 ${lo.toFixed(3)}..${peak.toFixed(3)}, max height ${maxH.toFixed(2)}, mean ${(sum / N).toFixed(3)}`)
console.log(`land bounds: uv u ${bounds.uv.u0}..${bounds.uv.u1}, v ${bounds.uv.v0}..${bounds.uv.v1} | world x ${bounds.world.x0}..${bounds.world.x1}, z ${bounds.world.z0}..${bounds.world.z1}`)
console.log("wrote public/maps/3d/: color.webp, terrain.webp, detail.webp, sea-tile.webp, height.png, land-bounds.json; lab3d-preview/preview-height.png")
