// Generates the deep-zoom discovery art: small ink silhouettes (ships, a sea serpent, standing stones, ...)
// in the map palette, drawn from simple shapes. The hand-drawn edge is baked into the path points here
// (resampled outlines nudged by seeded noise, strokes with a wobbling width), so the page needs no SVG
// filters; the output is identical on every run.
// Usage: npm run discoveries
//   -> components/map/discoveryArt.ts            (path data per kind, animated parts split out)
//   -> lod-preview/discoveries-art.png           (every glyph, at the size it appears on a phone at LVL4 and 3x)
//   -> lod-preview/discoveries-map.png           (the whole map with every discovery placed, numbered)
//   -> lod-preview/discoveries-closeups.png      (each discovery in its surroundings, about as seen at LVL4)
// Placements live in data/discoveries.json; they're checked here against the map bounds and the pins.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url))
const OUT = at("components/map/discoveryArt.ts")
const PREVIEW = at("lod-preview/")

// fills: indexes into the palette (the component maps them to colours)
const INK = 0
const HI = 1
const LIGHT = 2
const PALETTE = ["#3f1d0e", "#e5d2b3", "#f4efcf"]

// Art units: 64 units across = DISCOVER.size (% of the map width) at scale 1. Roughness is in the same
// units; a 64-unit glyph shows about 75px wide at LVL4 on a phone, so 1 unit is a little over 1px there.
const ROUGH = {
  step: 1.2,     // outline resampling distance
  amp: 0.42,     // smooth wobble of edges (low-frequency noise)
  period: 4.5,   // wobble wavelength along the outline
  grain: 0.14,   // per-point jitter on top (the pen catching the paper)
  strokeWobble: 0.18, // stroke width varies by up to this fraction
}
const SIZE_HINT = 1.7 // DISCOVER.size in lib/map.ts (only used for the previews)
const LVL4_HINT = 4.2

// ---------- seeded randomness
function mulberry32(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
let rng = mulberry32(1)

// ---------- geometry: parse absolute M/L/H/V/Q/C/Z paths into flattened polylines
function parse(d) {
  const toks = d.match(/[MLHVQCZ]|-?\d*\.?\d+/gi)
  const subs = []
  let cur = null
  let cmd = ""
  let x = 0
  let y = 0
  let i = 0
  const num = () => Number(toks[i++])
  const curve = (ctrl, ex, ey) => {
    const all = [[x, y], ...ctrl, [ex, ey]]
    let len = 0
    for (let k = 1; k < all.length; k++) len += Math.hypot(all[k][0] - all[k - 1][0], all[k][1] - all[k - 1][1])
    const n = Math.max(3, Math.ceil(len / ROUGH.step))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      const u = 1 - t
      if (ctrl.length === 1) {
        const [c] = ctrl
        cur.pts.push([u * u * x + 2 * u * t * c[0] + t * t * ex, u * u * y + 2 * u * t * c[1] + t * t * ey])
      } else {
        const [a, b] = ctrl
        cur.pts.push([
          u ** 3 * x + 3 * u * u * t * a[0] + 3 * u * t * t * b[0] + t ** 3 * ex,
          u ** 3 * y + 3 * u * u * t * a[1] + 3 * u * t * t * b[1] + t ** 3 * ey,
        ])
      }
    }
    x = ex
    y = ey
  }
  while (i < toks.length) {
    if (/^[a-z]$/i.test(toks[i])) cmd = toks[i++]
    if (cmd !== cmd.toUpperCase()) throw new Error(`absolute commands only: ${d}`)
    if (cmd === "M") {
      x = num()
      y = num()
      cur = { pts: [[x, y]], closed: false }
      subs.push(cur)
      cmd = "L"
    } else if (cmd === "L") {
      x = num()
      y = num()
      cur.pts.push([x, y])
    } else if (cmd === "H") {
      x = num()
      cur.pts.push([x, y])
    } else if (cmd === "V") {
      y = num()
      cur.pts.push([x, y])
    } else if (cmd === "Q") {
      const c = [num(), num()]
      curve([c], num(), num())
    } else if (cmd === "C") {
      const a = [num(), num()]
      const b = [num(), num()]
      curve([a, b], num(), num())
    } else if (cmd === "Z") {
      cur.closed = true
    } else throw new Error(`unsupported command ${cmd}`)
  }
  return subs
}

// split long segments so the noise has points to move
function resample(pts, closed) {
  const out = []
  const n = pts.length
  for (let k = 0; k < (closed ? n : n - 1); k++) {
    const a = pts[k]
    const b = pts[(k + 1) % n]
    const m = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / ROUGH.step))
    for (let j = 0; j < m; j++) out.push([a[0] + ((b[0] - a[0]) * j) / m, a[1] + ((b[1] - a[1]) * j) / m])
  }
  if (!closed) out.push(pts[n - 1])
  // drop repeats (and a closing point equal to the first)
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05
  const res = []
  for (const p of out) if (!res.length || !near(p, res.at(-1))) res.push(p)
  if (closed && res.length > 2 && near(res[0], res.at(-1))) res.pop()
  return res
}

const arcLengths = (pts) => {
  const s = [0]
  for (let k = 1; k < pts.length; k++) s.push(s[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]))
  return s
}
const normalAt = (pts, k, closed) => {
  const n = pts.length
  const a = pts[closed ? (k - 1 + n) % n : Math.max(0, k - 1)]
  const b = pts[closed ? (k + 1) % n : Math.min(n - 1, k + 1)]
  const tx = b[0] - a[0]
  const ty = b[1] - a[1]
  const len = Math.hypot(tx, ty) || 1
  return [-ty / len, tx / len]
}
// smooth 1D value noise along a length (periodic when closed), in [-1, 1]
function noise1(total, closed) {
  const knots = Math.max(3, Math.round(total / ROUGH.period))
  const kv = Array.from({ length: knots + 1 }, () => rng() * 2 - 1)
  if (closed) kv[knots] = kv[0]
  return (s) => {
    const u = Math.max(0, Math.min(knots - 1e-9, (s / (total || 1)) * knots))
    const k = Math.floor(u)
    const w = (1 - Math.cos((u - k) * Math.PI)) / 2
    return kv[k] * (1 - w) + kv[k + 1] * w
  }
}
const bbox = (pts) => {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
const signedArea = (pts) => pts.reduce((a, p, k) => {
  const q = pts[(k + 1) % pts.length]
  return a + p[0] * q[1] - q[0] * p[1]
}, 0) / 2

// hand-drawn edge: each outline point moves along its normal by smooth noise plus a little grain;
// small shapes (eyes, drops) wobble less so they keep their form
function roughen(pts, closed, amp = ROUGH.amp) {
  const [x0, y0, x1, y1] = bbox(pts)
  const k = Math.max(0.25, Math.min(1, Math.min(x1 - x0, y1 - y0) / 7))
  const s = arcLengths(pts)
  const total = s[s.length - 1] + (closed ? Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) : 0)
  const nz = noise1(total, closed)
  return pts.map((p, i) => {
    const [nx, ny] = normalAt(pts, i, closed)
    const off = k * (amp * nz(s[i]) + ROUGH.grain * (rng() * 2 - 1))
    return [p[0] + nx * off, p[1] + ny * off]
  })
}

const rotatePts = (pts, deg, cx, cy) => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c])
}

// ---------- shape builders; each returns { fill, pts[][] } (closed outlines)
// opts.rotate = [deg, cx, cy]; opts.inset = u shrinks the shape by about u units per side (light panels
// inside an ink outline); opts.amp overrides the wobble
function shape(fill, d, opts = {}) {
  const outlines = parse(d).map((sub) => {
    let pts = sub.pts
    if (opts.rotate) pts = rotatePts(pts, ...opts.rotate)
    if (opts.inset) {
      const [x0, y0, x1, y1] = bbox(pts)
      const cx = (x0 + x1) / 2
      const cy = (y0 + y1) / 2
      const sx = Math.max(0.1, (x1 - x0 - 2 * opts.inset) / (x1 - x0))
      const sy = Math.max(0.1, (y1 - y0 - 2 * opts.inset) / (y1 - y0))
      pts = pts.map(([x, y]) => [cx + (x - cx) * sx, cy + (y - cy) * sy])
    }
    return roughen(resample(pts, true), true, opts.amp)
  })
  return { fill, outlines }
}
function ellipse(fill, cx, cy, rx, ry, opts = {}) {
  const n = Math.max(10, Math.ceil((Math.PI * (rx + ry)) / ROUGH.step))
  let pts = Array.from({ length: n }, (_, k) => {
    const a = (k / n) * Math.PI * 2
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]
  })
  if (opts.rotate) pts = rotatePts(pts, opts.rotate, cx, cy)
  return { fill, outlines: [roughen(pts, true, opts.amp ?? ROUGH.amp * 0.6)] }
}
// A pen stroke along an open path, as a filled outline: width w, tapering over the first/last fraction
// of its length (taper [start, end]; 0 = a flat, full-width end, e.g. where a coil goes under water).
function stroke(fill, d, w, opts = {}) {
  const [t0, t1] = opts.taper ?? [0.2, 0.2]
  const tip = opts.tip ?? 0.3
  const outlines = parse(d).map((sub) => {
    let pts = sub.pts
    if (opts.rotate) pts = rotatePts(pts, ...opts.rotate)
    pts = resample(pts, false)
    const s = arcLengths(pts)
    const total = s[s.length - 1] || 1
    const widthNoise = noise1(total, false)
    const drift = noise1(total, false)
    const left = []
    const right = []
    pts.forEach((p, i) => {
      const t = s[i] / total
      const ease = (u) => u * u * (3 - 2 * u)
      let prof = 1
      if (t0 > 0 && t < t0) prof = tip + (1 - tip) * ease(t / t0)
      if (t1 > 0 && t > 1 - t1) prof = Math.min(prof, tip + (1 - tip) * ease((1 - t) / t1))
      const width = (opts.widthAt ? opts.widthAt(t) : w) * prof * (1 + ROUGH.strokeWobble * widthNoise(s[i]))
      const [nx, ny] = normalAt(pts, i, false)
      const c = 0.22 * drift(s[i]) // the centreline wanders a little too
      left.push([p[0] + nx * (c + width / 2), p[1] + ny * (c + width / 2)])
      right.push([p[0] + nx * (c - width / 2), p[1] + ny * (c - width / 2)])
    })
    return left.concat(right.reverse())
  })
  return { fill, outlines }
}
const wave = (x, y, len, amp = 1.3, w = 1) =>
  stroke(INK, `M${x} ${y} Q${x + len / 4} ${y - amp} ${x + len / 2} ${y} Q${x + (3 * len) / 4} ${y + amp} ${x + len} ${y}`, w, { taper: [0.3, 0.3], tip: 0.15 })

// a part: its shapes plus optional animation (anim = CSS keyframe family, origin in art units)
const part = (shapes, anim, origin, delay) => ({ shapes, anim, origin, delay })

// ---------- the glyphs. Coordinates are art units in a w x h box; the placement point is the box centre.
// Light comes from the top-left (like the candle glow), so highlights sit on upper/left edges.
const GLYPHS = {}

GLYPHS.ship = () => {
  const sail = (d) => [shape(INK, d), shape(LIGHT, d, { inset: 1.3 })]
  const ship = [
    // rigging first (behind the sails)
    stroke(INK, "M32 6 L7.5 37.5", 0.7, { taper: [0, 0] }),
    stroke(INK, "M47 12 L63 34.5", 0.7, { taper: [0, 0] }),
    stroke(INK, "M32 43 L32 4.5", 1.9, { taper: [0, 0.35], tip: 0.5 }),
    stroke(INK, "M47 43 L47 10.5", 1.7, { taper: [0, 0.35], tip: 0.5 }),
    stroke(INK, "M56.5 40.5 L64 34", 1.3, { taper: [0, 0.5] }),
    ...sail("M41.5 13.5 L52.5 13.5 Q55 18 53 22.5 L42 22.5 Q44 18 41.5 13.5 Z"),
    ...sail("M39.5 25 L54.5 25 Q57.5 30.8 55 36.5 L40.5 36.5 Q43 30.8 39.5 25 Z"),
    ...sail("M24.5 9.5 L39.5 9.5 Q42.5 15 40 20.5 L25 20.5 Q27.5 15 24.5 9.5 Z"),
    ...sail("M22 23 L42 23 Q45.5 30 42.5 37.5 L23 37.5 Q26.5 30 22 23 Z"),
    stroke(INK, "M24.5 30.5 Q34 32.5 43.5 30.5", 0.8, { taper: [0.25, 0.25] }),
    stroke(INK, "M42 31 Q48 32.5 55 31", 0.7, { taper: [0.25, 0.25] }),
    // yards
    stroke(INK, "M23 9.3 L41 9.3", 1.2, { taper: [0.15, 0.15], tip: 0.5 }),
    stroke(INK, "M20.5 22.8 L44 22.8", 1.2, { taper: [0.15, 0.15], tip: 0.5 }),
    stroke(INK, "M40.5 13.3 L54 13.3", 1.1, { taper: [0.15, 0.15], tip: 0.5 }),
    stroke(INK, "M38.5 24.8 L56 24.8", 1.1, { taper: [0.15, 0.15], tip: 0.5 }),
    // pennant
    shape(INK, "M32 3.2 Q36.5 3.4 41.5 5.2 Q37 6 32 7.3 Z"),
    // hull with a raised stern, and a light strake along it
    shape(INK, "M6 37 L15.5 37.2 L16.8 42 L49 42 Q55 41.5 60.5 37.5 L58.8 43 Q54.5 50.5 45 52 L20 52 Q12 50.5 8.5 44.5 Z"),
    stroke(HI, "M12 45.6 Q33 46.4 55 45", 1.3, { taper: [0.12, 0.2] }),
    shape(HI, "M8.6 39 L10.6 39 L10.6 41 L8.6 41 Z", { amp: 0.15 }),
    shape(HI, "M11.8 39 L13.8 39 L13.8 41 L11.8 41 Z", { amp: 0.15 }),
  ]
  const water = [wave(2, 55, 21), wave(28, 55.6, 33, 1.4), wave(12, 59.3, 12, 1, 0.8), wave(43, 59.6, 12, 1, 0.8)]
  return { w: 64, h: 62, parts: [part(ship, "bob", [33, 52]), part(water)] }
}

GLYPHS.rowboat = () => {
  const boat = [
    // oars reach down behind the hull into the water
    stroke(INK, "M17.5 11.5 L8 26", 1.1, { taper: [0.1, 0] }),
    stroke(INK, "M26.5 11.5 L36 26", 1.1, { taper: [0.1, 0] }),
    ellipse(INK, 7.3, 26.8, 1.3, 2.8, { rotate: 33 }),
    ellipse(INK, 36.7, 26.8, 1.3, 2.8, { rotate: -33 }),
    // rower
    ellipse(INK, 22, 8.2, 2.3, 2.4),
    shape(INK, "M17.8 16.5 Q18.2 11.3 22 10.8 Q25.8 11.3 26.2 16.5 Z"),
    // hull, the inside showing as a light sliver
    shape(INK, "M2.5 12.8 Q22 18 41.5 11.5 L39 17.8 Q30.5 23 21.5 23 Q11.5 23 6.5 18.2 Z"),
    shape(HI, "M5.5 13.9 Q22 18.2 38.6 12.6 Q30 17.4 21.5 17.6 Q12.5 17.6 5.5 13.9 Z", { amp: 0.25 }),
  ]
  const water = [wave(1, 25.5, 12, 1.1, 0.9), wave(31, 25.5, 12, 1.1, 0.9), wave(12, 28.5, 20, 1.2, 0.9)]
  return { w: 44, h: 32, parts: [part(boat, "bob", [22, 22]), part(water)] }
}

GLYPHS.serpent = () => {
  // a coil: an arch whose feet run on below the water line, hidden by the foam (to y 37), so it can
  // sink by up to its 6.5% (2.6 units, the disc-coil keyframes in globals.css) without showing them
  const coil = (cx, r, w, spikes) => {
    const k = 0.5523 * r
    const d = `M${cx - r} 34 L${cx - r} 30 C${cx - r} ${30 - k} ${cx - k} ${30 - r} ${cx} ${30 - r} C${cx + k} ${30 - r} ${cx + r} ${30 - k} ${cx + r} 30 L${cx + r} 34`
    const out = [stroke(INK, d, w, { taper: [0, 0] })]
    for (const a of spikes) {
      const rad = (a * Math.PI) / 180
      const R = r + w / 2 - 0.3
      const bx = cx + R * Math.cos(rad)
      const by = 30 - R * Math.sin(rad)
      const tx = cx + (R + 2.4) * Math.cos(rad - 0.12)
      const ty = 30 - (R + 2.4) * Math.sin(rad - 0.12)
      const ox = 1.1 * Math.sin(rad)
      const oy = 1.1 * Math.cos(rad)
      out.push(shape(INK, `M${bx - ox} ${by - oy} L${tx} ${ty} L${bx + ox} ${by + oy} Z`, { amp: 0.2 }))
    }
    // belly shine along the inside of the arch
    const ri = r - w / 2 + 0.9
    const ki = 0.5523 * ri
    out.push(stroke(HI, `M${cx - ri} 29 C${cx - ri} ${30 - ki} ${cx - ki} ${30 - ri} ${cx} ${30 - ri} C${cx + ki * 0.7} ${30 - ri} ${cx + ri * 0.8} ${30 - ki}  ${cx + ri * 0.9} 28`, 0.7, { taper: [0.3, 0.3] }))
    return out
  }
  const tail = [
    stroke(INK, "M10.5 35 L10.5 31 Q9.5 26.5 6 25 Q3.5 24 3 26.5", 2.8, { taper: [0, 0.45], tip: 0.2 }),
    shape(INK, "M6.2 25.2 L4 21 L8.2 24.3 Z", { amp: 0.2 }),
  ]
  const head = [
    stroke(INK, "M49 34 L49 30 Q48.5 22 52.5 17.2 Q55.5 13.8 58.5 12.6", 4.6, { taper: [0, 0.3], tip: 0.75 }),
    // frill down the back of the neck
    shape(INK, "M48.2 25 L45 23.5 L48.8 22 Z", { amp: 0.2 }),
    shape(INK, "M49.5 20.6 L46.6 18.4 L50.8 18 Z", { amp: 0.2 }),
    shape(INK, "M52 17 L50.2 13.8 L54 14.9 Z", { amp: 0.2 }),
    // head, jaws open to the right, backswept horns
    shape(INK, "M54 9.4 Q58 6.6 63 8.6 L69 10.6 Q70 12.1 67.8 12.5 L62.4 13 L66.5 15.3 Q64.5 16.9 60.6 16.2 Q56.2 15.7 53.8 14.2 Z"),
    stroke(INK, "M56 8.6 Q53.5 6.3 51.2 5.6", 1.2, { taper: [0, 0.6], tip: 0.2 }),
    stroke(INK, "M58.2 7.9 Q56.8 5 55 3.6", 1.1, { taper: [0, 0.6], tip: 0.2 }),
    ellipse(LIGHT, 59.6, 10.5, 0.9, 0.8, { amp: 0.1 }),
    stroke(HI, "M55.5 10.3 Q58 8.4 62 9.4", 0.6, { taper: [0.3, 0.3] }),
  ]
  // foam where the body breaks the surface: the same tone as the sea, with ink wavelets on top. It
  // covers the coils' feet, so they sink behind it.
  const foam = (x0, x1) =>
    shape(HI, `M${x0} 30.5 Q${x0 + 1.5} 29.2 ${x0 + 3} 29.6 L${x1 - 3} 29.6 Q${x1 - 1.5} 29.2 ${x1} 30.5 L${x1 + 0.5} 37 L${x0 - 0.5} 37 Z`, { amp: 0.3 })
  const water = [
    foam(5, 15), foam(11, 29.5), foam(25, 46.5), foam(44.5, 54),
    wave(1, 30.2, 7, 0.9, 0.9), wave(12.5, 30.6, 4.5, 0.8, 0.9), wave(24.5, 30.6, 3.5, 0.8, 0.9),
    wave(26.5, 30.6, 3.5, 0.8, 0.9), wave(43, 30.6, 3, 0.8, 0.9), wave(52, 30.4, 8, 1, 0.9),
    wave(8, 34.5, 14, 1.1, 0.8), wave(30, 35, 16, 1.1, 0.8), wave(50, 34.2, 12, 1, 0.8),
  ]
  return {
    w: 72,
    h: 40,
    parts: [
      part(tail),
      part(coil(19.5, 5.4, 4.2, [140, 95, 50]), "coil", [19.5, 30], 0),
      part(coil(35.5, 7.2, 4.8, [150, 115, 80, 45]), "coil", [35.5, 30], -1.8),
      part(head, "coil", [49, 30], -3.6),
      part(water),
    ],
  }
}

GLYPHS.whale = () => {
  const tail = [
    shape(INK, "M20.5 35 Q21.5 27 22.8 21 Q15 19.5 9 14.5 Q5 10.5 3.5 5 Q10 8.5 15.5 8.3 Q21 8.5 24 13 Q27 8.5 32.5 8.3 Q38 8.5 44.5 5 Q43 10.5 39 14.5 Q33 19.5 25.2 21 Q26.5 27 27.5 35 Z"),
    stroke(HI, "M6.5 8.6 Q12 10.4 18 10.6", 0.9, { taper: [0.3, 0.4] }),
    stroke(HI, "M28 11.6 Q31 10.2 35 10", 0.8, { taper: [0.3, 0.4] }),
    stroke(HI, "M22.4 22.5 Q21.8 28 21.6 33", 0.7, { taper: [0.3, 0.3] }),
    ellipse(INK, 4.6, 11.8, 0.7, 1.1),
    ellipse(INK, 5.8, 15.6, 0.55, 0.85),
    ellipse(INK, 43.4, 12.2, 0.7, 1.1),
    ellipse(INK, 41.8, 16.2, 0.55, 0.85),
    ellipse(INK, 24, 17.2, 0.45, 0.7),
  ]
  const water = [
    shape(HI, "M14 33.2 Q24 31.8 34 33.2 L34.5 36.5 L13.5 36.5 Z", { amp: 0.3 }),
    wave(8, 34.2, 14, 1.2), wave(26.5, 34.2, 14, 1.2), wave(12, 38.3, 24, 1.3, 0.9),
  ]
  return { w: 48, h: 42, parts: [part(tail), part(water)] }
}

GLYPHS.wreck = () => {
  const wreck = [
    // broken mast with a torn sail, leaning with the hull
    stroke(INK, "M35.5 24 L43.5 4", 1.9, { taper: [0, 0.2], tip: 0.6 }),
    shape(INK, "M43 4.5 L44.6 2.6 L45 4.8 L43.8 5.6 Z", { amp: 0.15 }),
    stroke(INK, "M37.5 11.8 L49 8.6", 1.1, { taper: [0.1, 0.2] }),
    shape(INK, "M39 12.3 L47.5 9.9 L47 14.5 L45 13.2 L44 16.8 L42.4 14 L40.6 16.2 Z"),
    shape(LIGHT, "M39 12.3 L47.5 9.9 L47 14.5 L45 13.2 L44 16.8 L42.4 14 L40.6 16.2 Z", { inset: 1 }),
    // ribs of the broken hull
    stroke(INK, "M13.5 30 Q12.2 24 14.8 19.4", 1.4, { taper: [0, 0.35], tip: 0.3 }),
    stroke(INK, "M19.5 28.8 Q18.6 22 21.3 17.4", 1.4, { taper: [0, 0.35], tip: 0.3 }),
    stroke(INK, "M25.5 27.3 Q25 21 27.6 16.8", 1.4, { taper: [0, 0.35], tip: 0.3 }),
    stroke(INK, "M31 25.8 Q31 22.6 32.6 19.8", 1.3, { taper: [0, 0.35], tip: 0.3 }),
    // the hull, bow up, the stern already under
    shape(INK, "M5 30 Q18 27.5 30 25 L44 19.5 Q49 18 52.5 15 L51 22 Q48.5 29 40 32.5 L12 34.2 Z"),
    stroke(HI, "M10 31.3 Q28 28.6 45.5 23.8", 0.8, { taper: [0.2, 0.3] }),
  ]
  const water = [
    shape(HI, "M1.5 31.5 Q10 30.2 20 31.2 Q32 30.5 47 31.6 L47.5 37 L1 37 Z", { amp: 0.3 }),
    wave(1, 32, 17, 1.2), wave(22, 32.6, 25, 1.3), wave(7, 36.6, 14, 1, 0.8), wave(30, 37, 16, 1, 0.8),
  ]
  return { w: 56, h: 40, parts: [part(wreck), part(water)] }
}

GLYPHS.tower = () => {
  const tower = [
    stroke(INK, "M18 13 L18 3", 0.9, { taper: [0, 0.2] }),
    shape(INK, "M18.3 2.8 Q22 3.6 25.8 3 Q23.4 4.8 25.4 6.8 Q21.6 6.4 18.3 7 Z", { amp: 0.25 }),
    shape(INK, "M10.4 56.5 L12 21.5 L24 21.5 L25.6 56.5 Z"),
    // battlements on a corbelled ledge
    shape(INK, "M8.6 22.5 L27.4 22.5 L27 15.6 L25 15.6 L25 12.6 L21.6 12.6 L21.6 15.6 L19.8 15.6 L19.8 12.6 L16.2 12.6 L16.2 15.6 L14.4 15.6 L14.4 12.6 L11 12.6 L11 15.6 L9 15.6 Z", { amp: 0.25 }),
    stroke(HI, "M10 19 L26 19", 0.6, { taper: [0.1, 0.1] }),
    // windows, a door, stone courses and the lit left edge
    shape(LIGHT, "M17.2 26.5 L18.8 26.5 L18.8 31.5 L17.2 31.5 Z", { amp: 0.15 }),
    shape(LIGHT, "M16.8 41.5 L16.8 38.2 Q18 36.6 19.2 38.2 L19.2 41.5 Z", { amp: 0.15 }),
    shape(HI, "M15.4 56.5 L15.4 51 Q18 47.6 20.6 51 L20.6 56.5 Z", { amp: 0.2 }),
    stroke(HI, "M13.2 33.5 L16.5 33.5", 0.6, { taper: [0.2, 0.2] }),
    stroke(HI, "M19.8 45.5 L23.4 45.5", 0.6, { taper: [0.2, 0.2] }),
    stroke(HI, "M12.8 47.8 L15 47.8", 0.6, { taper: [0.2, 0.2] }),
    stroke(HI, "M12.6 24 L11.4 54.5", 0.8, { taper: [0.15, 0.15] }),
  ]
  const ground = [
    stroke(INK, "M2 59 Q10 56 18 56 Q26 56 34 59", 1.4, { taper: [0.25, 0.25] }),
    stroke(INK, "M5 58.4 L4.2 55.6", 0.6, { taper: [0, 0.6] }),
    stroke(INK, "M6.6 57.8 L7 55", 0.6, { taper: [0, 0.6] }),
    stroke(INK, "M29.6 57.6 L30.2 55", 0.6, { taper: [0, 0.6] }),
    stroke(INK, "M31.2 58.2 L32.6 55.8", 0.6, { taper: [0, 0.6] }),
    wave(4, 61.5, 9, 0.6, 0.6), wave(22, 61.8, 10, 0.6, 0.6),
  ]
  return { w: 36, h: 64, parts: [part([...tower, ...ground])] }
}

GLYPHS.stones = () => {
  const stone = (d, lit) => [shape(INK, d), stroke(HI, lit, 1, { taper: [0.15, 0.3] })]
  const shapes = [
    stroke(INK, "M1.5 35.5 Q32 32.5 62.5 35.5", 1.3, { taper: [0.2, 0.2] }),
    ...stone("M4.8 34.5 L5.4 22.6 Q7.4 19.8 10 21.2 L11 34.5 Z", "M6.1 23.4 L5.8 33"),
    ...stone("M14.6 34 L15 15.2 Q17.6 12.4 20.6 14.6 L21.2 34 Z", "M15.9 16.2 L15.7 32.5"),
    ...stone("M26 33.6 L26.5 11.8 L32 11.6 L32.6 33.6 Z", "M27.3 13 L27 32"),
    ...stone("M38 33.6 L38.6 11.8 L44 11.6 L44.6 33.6 Z", "M39.6 13 L39.3 32"),
    ...stone("M24.4 12.2 L24.9 7.2 L46.2 6.6 L46.4 11.8 Z", "M25.8 8.2 L44.8 7.7"),
    ...stone("M49.5 34 L50 17.2 Q53 14.6 56 17 L56.6 34 Z", "M50.9 18.4 L50.8 32.5"),
    ...stone("M58 34.4 L58.6 26.4 Q60.4 24.6 62 26.6 L62.2 34.4 Z", "M59.4 27.2 L59.3 33.4"),
    // tufts at the feet of the stones
    stroke(INK, "M12.6 35 L12 32.4", 0.6, { taper: [0, 0.6] }),
    stroke(INK, "M23.6 34.6 L24.4 32.2", 0.6, { taper: [0, 0.6] }),
    stroke(INK, "M47.2 34.6 L46.6 32", 0.6, { taper: [0, 0.6] }),
    wave(16, 38.2, 12, 0.6, 0.6), wave(36, 38.4, 14, 0.6, 0.6),
  ]
  return { w: 64, h: 40, parts: [part(shapes)] }
}

GLYPHS.campfire = () => {
  const base = [
    ellipse(INK, 10, 34.6, 1.7, 1.2),
    ellipse(INK, 30, 34.6, 1.7, 1.2),
    stroke(INK, "M8.5 38.5 L31 31.5", 2.7, { taper: [0, 0] }),
    stroke(INK, "M9.5 31.5 L31.5 38.5", 2.7, { taper: [0, 0] }),
    ellipse(HI, 8.6, 38.4, 0.9, 1.1, { amp: 0.1 }),
    ellipse(HI, 31.4, 38.4, 0.9, 1.1, { amp: 0.1 }),
    ellipse(INK, 6.5, 39, 2.3, 1.7),
    ellipse(INK, 12.6, 40.8, 2.3, 1.6),
    ellipse(INK, 19.8, 41.4, 2.4, 1.6),
    ellipse(INK, 27, 41, 2.3, 1.6),
    ellipse(INK, 33.4, 39.2, 2.3, 1.7),
    stroke(HI, "M5.4 38 Q6.4 37.4 7.6 37.6", 0.5, { taper: [0.3, 0.3] }),
    stroke(HI, "M18.6 40.3 Q19.8 39.8 21 40.1", 0.5, { taper: [0.3, 0.3] }),
  ]
  const flame = [
    shape(INK, "M20 36.8 Q12 34.2 13 27 Q13.5 22 17 18.5 Q16.5 23 19 25 Q18 17 23 10.5 Q22.5 18 25.5 21 Q27 18.5 26.5 15.5 Q30.8 21 28.6 28 Q27.5 34.2 20 36.8 Z"),
    shape(LIGHT, "M20 34.6 Q15.6 32.6 16.5 28 Q17.4 25.6 19.4 24.6 Q19.8 27.6 21.5 28 Q21.4 24 24 21.4 Q24.6 25.6 26 27 Q27 31.6 20 34.6 Z", { amp: 0.25 }),
    ellipse(INK, 15.2, 13.6, 0.5, 0.5, { amp: 0.05 }),
    ellipse(INK, 27.8, 9.6, 0.45, 0.45, { amp: 0.05 }),
    ellipse(INK, 30.2, 14.6, 0.4, 0.4, { amp: 0.05 }),
  ]
  // smoke (the ambient smoke wisps, as HTML): bottom-centre of a 2:3 box at x/y, w = box width, all
  // fractions of the glyph box
  return { w: 40, h: 44, parts: [part(base), part(flame, "flame", [20, 36])], smoke: { x: 0.55, y: 0.3, w: 0.7 } }
}

GLYPHS.runestone = () => {
  const shapes = [
    stroke(INK, "M1 45.5 Q15 43.4 29 45.5", 1.2, { taper: [0.25, 0.25] }),
    shape(INK, "M6 44.4 L5 14 Q6 4 15 3 Q24 4 25 14 L24 44.4 Z"),
    stroke(HI, "M6.8 15 Q7 30 7.3 42.5", 0.9, { taper: [0.2, 0.2] }),
    stroke(HI, "M8.5 9 Q11 5.6 15 5.1", 0.7, { taper: [0.3, 0.4] }),
    // carved runes
    ...[
      "M13.5 9.5 L13.5 18", "M13.5 11 L17.5 8.8", "M13.5 14.2 L17.5 12",
      "M15.5 21 L15.5 29", "M15.5 23.6 L12.4 20.8", "M15.5 23.6 L18.6 20.8",
      "M13 32 L13 40", "M13 32 L17 34 L13 36 L17.4 40",
    ].map((d) => stroke(LIGHT, d, 0.85, { taper: [0.1, 0.1], tip: 0.6 })),
    stroke(INK, "M4 44.8 L3.2 41.8", 0.6, { taper: [0, 0.6] }),
    stroke(INK, "M26 44.6 L27 41.6", 0.6, { taper: [0, 0.6] }),
  ]
  return { w: 30, h: 48, parts: [part(shapes)] }
}

GLYPHS.dragon = () => {
  const torso = (t) => {
    // thick at the chest, thin tail and neck
    const w = t < 0.45 ? 0.6 + 5.4 * Math.sin((t / 0.45) * (Math.PI / 2)) ** 2 : 6 - 3.6 * ((t - 0.45) / 0.55)
    return Math.max(0.6, w)
  }
  const shapes = [
    // far wing, behind the body
    shape(INK, "M39 24 Q41 15 45.5 9 Q48 5 53 2.5 Q51.5 7 51 9.5 Q54 10.5 56 13 Q52.5 13.5 50.5 15.5 Q52.5 18 53 21 Q48 20 44 23 Z"),
    stroke(HI, "M41.5 21.5 Q46 12 52 3.8", 0.55, { taper: [0.2, 0.4] }),
    stroke(HI, "M42.5 21.8 Q48 15.5 54.8 12.8", 0.55, { taper: [0.2, 0.4] }),
    // body: tail -> chest -> neck
    stroke(INK, "M1.5 36.2 Q12 30.5 22 30.8 Q31 31 38 27 Q44 23.5 49 19.5 Q52 17 54.5 16", 1, { taper: [0, 0.08], tip: 0.7, widthAt: torso }),
    shape(INK, "M4.8 34.4 L0 33.6 L1.6 38.6 Z", { amp: 0.2 }),
    // legs tucked under
    stroke(INK, "M29.5 32.5 L27.8 36.4 L30.4 37.4", 1.4, { taper: [0, 0.3] }),
    stroke(INK, "M38 29.5 L37.4 34 L40 35", 1.4, { taper: [0, 0.3] }),
    // head and horns
    shape(INK, "M52.6 14.2 Q57 12 61.6 13.6 L63.8 15.6 Q61 17.2 57.4 17.4 L53.4 18.6 Z"),
    stroke(INK, "M54.6 14.4 L50.8 10.6", 1, { taper: [0, 0.6] }),
    stroke(INK, "M56.2 13.6 L53.6 9.6", 0.9, { taper: [0, 0.6] }),
    ellipse(LIGHT, 57.8, 14.9, 0.55, 0.5, { amp: 0.05 }),
    // near wing, raised, with light ribs
    shape(INK, "M34 25.5 Q34 16 29 10 Q26 5 19 1.5 Q21.5 6 21.5 8.5 Q18.5 9.5 15.5 12.5 Q19.5 13.5 21 15.5 Q17.5 17.5 16 21.5 Q21 20.5 24 23 Q25.5 25.5 27 28 Z"),
    stroke(HI, "M31.5 23.5 Q27.5 12 20.5 3.2", 0.6, { taper: [0.2, 0.4] }),
    stroke(HI, "M30.5 23.8 Q24 15.6 17 12.7", 0.6, { taper: [0.2, 0.4] }),
    stroke(HI, "M30 24.6 Q23.5 21 17.4 21", 0.6, { taper: [0.2, 0.4] }),
    stroke(HI, "M14 33.3 Q22 31.7 30 32.2", 0.6, { taper: [0.3, 0.3] }),
  ]
  return { w: 64, h: 40, parts: [part(shapes)] }
}

GLYPHS.tent = () => {
  const shapes = [
    stroke(INK, "M1 32.6 Q24 30.4 47 32.6", 1.2, { taper: [0.2, 0.2] }),
    // guy ropes and pegs
    stroke(INK, "M12.5 20.5 L2.5 31.2", 0.6, { taper: [0, 0] }),
    stroke(INK, "M39.5 19.5 L46 30.4", 0.6, { taper: [0, 0] }),
    stroke(INK, "M2.5 31.5 L2 29.2", 0.8, { taper: [0, 0] }),
    stroke(INK, "M46 30.8 L46.6 28.4", 0.8, { taper: [0, 0] }),
    // pole and pennant
    stroke(INK, "M21 7 L20.6 1.8", 0.9, { taper: [0, 0.2] }),
    shape(INK, "M20.8 1.6 L25 2.8 L20.8 4.2 Z", { amp: 0.15 }),
    // side panel, then the light front with the dark doorway and a folded-back flap
    shape(INK, "M20.5 7 L36.5 9.5 L45 30.8 L32 31.6 Z"),
    stroke(HI, "M23 9 L38.8 30.6", 0.6, { taper: [0.2, 0.2] }),
    shape(INK, "M6.4 31.8 L21 6 L34 31.8 Z"),
    shape(LIGHT, "M9.6 30.2 L21 9.8 L31.4 30.2 Z", { amp: 0.3 }),
    shape(INK, "M16.6 30.4 L21 18.4 L25.4 30.4 Z", { amp: 0.25 }),
    shape(HI, "M21.2 18.8 L25.6 30.3 L28.6 25.2 Z", { amp: 0.2 }),
    stroke(INK, "M21.2 18.8 L28.6 25.2 L25.6 30.3", 0.5, { taper: [0, 0] }),
  ]
  return { w: 48, h: 34, parts: [part(shapes)] }
}

GLYPHS.bottle = () => {
  const R = [-16, 17, 13] // the bottle floats tilted; the waves stay level
  const bottle = [
    shape(INK, "M4.5 13 Q4.5 8.8 9 8.8 L20 8.8 Q23 8.8 25 10.8 L28.6 11.6 L28.6 14.4 L25 15.2 Q23 17.2 20 17.2 L9 17.2 Q4.5 17.2 4.5 13 Z", { rotate: R }),
    shape(HI, "M6.6 13 Q6.6 10.8 9.4 10.8 L19.6 10.8 Q22 10.8 23.4 12.3 L23.4 13.7 Q22 15.2 19.6 15.2 L9.4 15.2 Q6.6 15.2 6.6 13 Z", { rotate: R, amp: 0.2 }),
    shape(LIGHT, "M9.4 11.8 L19 11.8 L19 14.2 L9.4 14.2 Z", { rotate: R, amp: 0.15 }),
    stroke(INK, "M14.2 11.5 L14.2 14.5", 0.8, { taper: [0, 0], rotate: R }),
    shape(INK, "M28.4 11.2 L31.8 11.5 L31.8 14.5 L28.4 14.8 Z", { rotate: R, amp: 0.2 }),
    stroke(LIGHT, "M9.5 10.1 L19 10.1", 0.5, { taper: [0.3, 0.3], rotate: R }),
  ]
  const water = [
    shape(HI, "M3 17.8 Q17 16.6 33 17.6 L33.5 21.5 L2.5 21.5 Z", { amp: 0.3 }),
    wave(1, 18.4, 16, 1.1, 0.9), wave(18, 18.2, 16, 1.1, 0.9), wave(6, 22.6, 22, 1.1, 0.8),
  ]
  return { w: 36, h: 26, parts: [part(bottle, "bob", [17, 18]), part(water)] }
}

// the "found" stamp on the discovery card: a double ring round a compass star, like the pins' seal
const STAMP = () => {
  const ring = (r, w) => {
    const k = 0.5523 * r
    return stroke(
      INK,
      `M20 ${20 - r} C${20 + k} ${20 - r} ${20 + r} ${20 - k} ${20 + r} 20 C${20 + r} ${20 + k} ${20 + k} ${20 + r} 20 ${20 + r} C${20 - k} ${20 + r} ${20 - r} ${20 + k} ${20 - r} 20 C${20 - r} ${20 - k} ${20 - k} ${20 - r} 20.6 ${20 - r - 0.1}`,
      w,
      { taper: [0.04, 0.04], tip: 0.5 },
    )
  }
  return {
    w: 40,
    h: 40,
    parts: [
      part([
        ring(17, 2.2),
        ring(13.4, 0.9),
        shape(INK, "M20 9.5 L22.2 17.8 L30.5 20 L22.2 22.2 L20 30.5 L17.8 22.2 L9.5 20 L17.8 17.8 Z", { amp: 0.25 }),
        ellipse(LIGHT, 20, 20, 1.3, 1.3, { amp: 0.05 }),
        ...[0, 90, 180, 270].map((a) => ellipse(INK, 20 + 15.2 * Math.cos((a * Math.PI) / 180 + Math.PI / 4), 20 + 15.2 * Math.sin((a * Math.PI) / 180 + Math.PI / 4), 0.7, 0.7, { amp: 0.05 })),
      ]),
    ],
  }
}

// ---------- build: roughen every glyph with its own seed, then compact the paths
// relative path in tenths of a unit; consecutive same-fill shapes share one <path> (all outlines are
// wound the same way, so overlaps add up instead of cutting holes under nonzero fill)
const tenth = (v) => Math.round(v * 10)
const numStr = (t) => {
  let s = String(t / 10)
  if (s.startsWith("0.")) s = s.slice(1)
  else if (s.startsWith("-0.")) s = "-" + s.slice(2)
  return s
}
function toD(pts) {
  if (signedArea(pts) < 0) pts = [...pts].reverse()
  let px = tenth(pts[0][0])
  let py = tenth(pts[0][1])
  let d = `M${numStr(px)} ${numStr(py)}l`
  let last = null // previous number: a separator is only needed where the next one could run into it
  for (const p of pts.slice(1)) {
    const x = tenth(p[0])
    const y = tenth(p[1])
    if (x === px && y === py) continue
    for (const v of [numStr(x - px), numStr(y - py)]) {
      const joins = last === null || v.startsWith("-") || (v.startsWith(".") && last.includes("."))
      d += joins ? v : " " + v
      last = v
    }
    px = x
    py = y
  }
  return d + "z"
}
function build(name, make, seed) {
  rng = mulberry32(seed)
  const g = make()
  const parts = g.parts.map((p) => {
    const paths = []
    for (const s of p.shapes) {
      const d = s.outlines.map(toD).join("")
      const prev = paths.at(-1)
      if (prev && prev[0] === s.fill) prev[1] += d
      else paths.push([s.fill, d])
    }
    const out = { paths }
    if (p.anim) {
      out.anim = p.anim
      out.origin = `${((p.origin[0] / g.w) * 100).toFixed(1)}% ${((p.origin[1] / g.h) * 100).toFixed(1)}%`
      if (p.delay) out.delay = p.delay
    }
    return out
  })
  return { name, w: g.w, h: g.h, parts, smoke: g.smoke }
}

const names = Object.keys(GLYPHS)
const art = names.map((n, i) => build(n, GLYPHS[n], 101 + i * 37))
const stamp = build("stamp", STAMP, 7)

// ---------- write components/map/discoveryArt.ts
const ts = `// generated by scripts/gen-discoveries.mjs (npm run discoveries) — do not edit by hand
// Ink silhouettes for the deep-zoom discoveries. Coordinates are art units: a glyph's box is w x h, and
// 64 units across = DISCOVER.size (% of the map width) at scale 1. Each part is drawn as its own <svg>
// over the whole box, so animated parts (anim) can move on their own compositor layer; fills index
// ART_PALETTE. The rough edges are baked into the points.

export const ART_PALETTE = ${JSON.stringify(PALETTE)} as const

export type ArtAnim = "bob" | "coil" | "flame"
export type ArtPart = {
  paths: [fill: number, d: string][]
  anim?: ArtAnim
  origin?: string // transform-origin, % of the box
  delay?: number  // s, phase offset between parts
}
export type ArtGlyph = {
  w: number
  h: number
  parts: ArtPart[]
  smoke?: { x: number; y: number; w: number } // chimney/campfire smoke: bottom-centre + width, fractions of the box
}

export const ART = {
${art.map((g) => `  ${g.name}: ${JSON.stringify({ w: g.w, h: g.h, parts: g.parts, ...(g.smoke ? { smoke: g.smoke } : {}) })},`).join("\n")}
} satisfies Record<string, ArtGlyph>

export type DiscoveryKind = keyof typeof ART

// the "found" stamp on the discovery card
export const STAMP_ART: ArtGlyph = ${JSON.stringify({ w: stamp.w, h: stamp.h, parts: stamp.parts })}
`
await writeFile(OUT, ts)

// ---------- check the placements
const data = JSON.parse(await readFile(at("data/discoveries.json"), "utf8"))
const mapTs = await readFile(at("lib/map.ts"), "utf8")
const MAPW = Number(mapTs.match(/export const MAP = \{ w: ([\d.]+)/)[1])
const MAPH = Number(mapTs.match(/export const MAP = \{[^}]*h: ([\d.]+)/)[1])
const size = Number(mapTs.match(/DISCOVER = \{[\s\S]*?\bsize: ([\d.]+)/)?.[1] ?? SIZE_HINT)
const pins = [...mapTs.matchAll(/id: "([\w-]+)",[\s\S]*?\n\s+x: ([\d.]+),\s*\n\s+y: ([\d.]+),/g)].map((m) => ({ id: m[1], x: +m[2], y: +m[3] }))
const byName = Object.fromEntries(art.map((g) => [g.name, g]))
const problems = []
const ids = new Set()
for (const d of data) {
  const g = byName[d.kind]
  if (!g) problems.push(`${d.id}: unknown kind "${d.kind}" (have: ${names.join(", ")})`)
  if (ids.has(d.id)) problems.push(`${d.id}: duplicate id`)
  ids.add(d.id)
  for (const k of ["x", "y", "rotation", "scale"]) if (typeof d[k] !== "number") problems.push(`${d.id}: ${k} must be a number`)
  if (typeof d.flip !== "boolean") problems.push(`${d.id}: flip must be true/false`)
  if (!d.name || !d.lore) problems.push(`${d.id}: needs a name and a lore line`)
  if (d.x < 6 || d.x > 94 || d.y < 9 || d.y > 91) problems.push(`${d.id}: inside the burnt edge (${d.x}, ${d.y})`)
  for (const p of pins) {
    const dist = Math.hypot(((d.x - p.x) * MAPW) / 100, ((d.y - p.y) * MAPH) / 100)
    if (dist < 25) problems.push(`${d.id}: only ${dist.toFixed(0)} map units from the "${p.id}" pin`)
  }
}
for (const a of data) for (const b of data) {
  if (a.id >= b.id) continue
  const dist = Math.hypot(((a.x - b.x) * MAPW) / 100, ((a.y - b.y) * MAPH) / 100)
  if (dist < 30) problems.push(`${a.id} and ${b.id} are only ${dist.toFixed(0)} map units apart`)
}

// ---------- previews
const svgGlyph = (g, attrs = "") =>
  `<g ${attrs}>${g.parts.map((p) => p.paths.map(([f, d]) => `<path fill="${PALETTE[f]}" d="${d}"/>`).join("")).join("")}</g>`
await mkdir(PREVIEW, { recursive: true })

// 1. art sheet: each glyph on parchment at ~LVL4 phone size and at 3x that
{
  const phonePxPerUnit = ((1133 * size) / 100 / 64) * LVL4_HINT // map 1133 css px wide on an 844px-tall phone
  const cells = [...art, stamp]
  const cellW = 300
  const cellH = 240
  const cols = 4
  const rows = Math.ceil(cells.length / cols)
  let body = ""
  cells.forEach((g, i) => {
    const cx = (i % cols) * cellW
    const cy = Math.floor(i / cols) * cellH
    const small = phonePxPerUnit
    const big = Math.min((cellW - 110) / g.w, (cellH - 50) / g.h)
    body += `<text x="${cx + 10}" y="${cy + 22}" font-family="Georgia, serif" font-size="16" fill="#3f1d0e">${g.name}</text>`
    body += `<text x="${cx + 10}" y="${cy + 40}" font-family="Georgia, serif" font-size="11" fill="#9b8066">${g.w}x${g.h} u, ${g.parts.length} part${g.parts.length > 1 ? "s" : ""}${g.parts.some((p) => p.anim) ? ", animated: " + g.parts.filter((p) => p.anim).map((p) => p.anim).join("/") : ""}</text>`
    body += svgGlyph(g, `transform="translate(${cx + 12} ${cy + 60}) scale(${small})"`)
    body += svgGlyph(g, `transform="translate(${cx + 100} ${cy + 48}) scale(${big})"`)
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cellW}" height="${rows * cellH}"><rect width="100%" height="100%" fill="#e8d6b4"/>${body}</svg>`
  await sharp(Buffer.from(svg)).png().toFile(PREVIEW + "discoveries-art.png")
}

// 2. the whole map with the discoveries, and close-ups, over the 4096px raster of the full map
const raster = at("public/maps/protheka-4096.webp")
const meta = await sharp(raster).metadata()
const RW = meta.width
const RH = meta.height
const placed = data.filter((d) => byName[d.kind])
const glyphAt = (d, k = 1) => {
  const g = byName[d.kind]
  const pxPerUnit = ((RW * size) / 100 / 64) * d.scale * k
  return svgGlyph(
    g,
    `transform="translate(${((d.x / 100) * RW * k).toFixed(1)} ${((d.y / 100) * RH * k).toFixed(1)}) rotate(${d.rotation}) scale(${d.flip ? -pxPerUnit : pxPerUnit} ${pxPerUnit}) translate(${-g.w / 2} ${-g.h / 2})"`,
  )
}
const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${RW}" height="${RH}">${placed.map((d) => glyphAt(d)).join("")}</svg>`
const composed = await sharp(raster).composite([{ input: Buffer.from(overlay) }]).png().toBuffer()
{
  const W = 2400
  const k = W / RW
  const H = Math.round(RH * k)
  const labels = placed
    .map((d, i) => {
      const x = (d.x / 100) * W
      const y = (d.y / 100) * H
      const g = byName[d.kind]
      const r = (((W * size) / 100 / 64) * d.scale * Math.max(g.w, g.h)) / 2 + 6
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#d0107a" stroke-width="2"/><text x="${x + r + 2}" y="${y - r + 12}" font-family="Arial" font-weight="bold" font-size="18" fill="#d0107a" stroke="#fff" stroke-width="3" paint-order="stroke">${i + 1}</text>`
    })
    .join("")
  const legend = placed.map((d, i) => `${i + 1} ${d.name} (${d.kind})`)
  const legendSvg = legend.map((t, i) => `<text x="${16 + Math.floor(i / 6) * 800}" y="${H + 30 + (i % 6) * 24}" font-family="Arial" font-size="17" fill="#3f1d0e">${t.replace(/&/g, "&amp;")}</text>`).join("")
  const small = await sharp(composed).resize(W).png().toBuffer()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H + 170}">${labels}${legendSvg}</svg>`
  await sharp({ create: { width: W, height: H + 170, channels: 4, background: "#f4efcf" } })
    .composite([{ input: small, top: 0, left: 0 }, { input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(PREVIEW + "discoveries-map.png")
}
{
  // ~LVL4 on a phone: the map is 1133 x 4.2 = 4758px wide there, the raster 4096, so crops are scaled up to match
  const zoom = (1133 * LVL4_HINT) / RW
  const cw = 420
  const ch = 300
  const cols = 4
  const rows = Math.ceil(placed.length / cols)
  const tiles = []
  for (const [i, d] of placed.entries()) {
    const srcW = Math.round(cw / zoom)
    const srcH = Math.round(ch / zoom)
    const left = Math.max(0, Math.min(RW - srcW, Math.round((d.x / 100) * RW - srcW / 2)))
    const top = Math.max(0, Math.min(RH - srcH, Math.round((d.y / 100) * RH - srcH / 2)))
    const tile = await sharp(composed).extract({ left, top, width: srcW, height: srcH }).resize(cw, ch).png().toBuffer()
    tiles.push({ input: tile, left: (i % cols) * (cw + 10) + 10, top: Math.floor(i / cols) * (ch + 40) + 34 })
  }
  const W = cols * (cw + 10) + 10
  const H = rows * (ch + 40) + 10
  const captions = placed
    .map((d, i) => `<text x="${(i % cols) * (cw + 10) + 12}" y="${Math.floor(i / cols) * (ch + 40) + 26}" font-family="Georgia, serif" font-size="16" fill="#3f1d0e">${i + 1}. ${d.name} — ${d.kind} at ${d.x}, ${d.y}</text>`)
    .join("")
  await sharp({ create: { width: W, height: H, channels: 4, background: "#f4efcf" } })
    .composite([...tiles, { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${captions}</svg>`), top: 0, left: 0 }])
    .png()
    .toFile(PREVIEW + "discoveries-closeups.png")
}

// ---------- report
const bytes = Buffer.byteLength(ts)
console.log(`${art.length} glyphs (+ stamp) -> components/map/discoveryArt.ts, ${(bytes / 1024).toFixed(1)} KiB`)
for (const g of art) {
  const pts = g.parts.reduce((n, p) => n + p.paths.reduce((m, [, d]) => m + (d.match(/-?(?:\d+(?:\.\d+)?|\.\d+)/g)?.length ?? 0) / 2, 0), 0)
  console.log(`  ${g.name.padEnd(10)} ${g.w}x${g.h}  parts: ${g.parts.map((p) => p.anim ?? "static").join(", ").padEnd(34)} ~${Math.round(pts)} points`)
}
console.log(`${placed.length} discoveries in data/discoveries.json; pins checked: ${pins.map((p) => p.id).join(", ")}`)
if (problems.length) {
  console.log("placement problems:")
  for (const p of problems) console.log("  - " + p)
  process.exitCode = 1
} else console.log("placements OK (inside the map, clear of the pins and of each other)")
console.log("previews: lod-preview/discoveries-art.png, lod-preview/discoveries-map.png, lod-preview/discoveries-closeups.png")
