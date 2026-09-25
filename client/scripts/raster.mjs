// Rasterizes the map SVG to a 4096px-wide WebP (fallback for A/B testing zoom performance).
// Usage: npm run raster
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import sharp from "sharp"

const WIDTH = 4096
const VIEWBOX_W = 903 // matches MAP.w in lib/map.ts

const svgPath = fileURLToPath(new URL("../public/maps/protheka.svg", import.meta.url))
const outPath = fileURLToPath(new URL("../public/maps/protheka-4096.webp", import.meta.url))

// sharp renders SVGs at 72dpi by default; raise the density so we render at full size instead of upscaling
const info = await sharp(await readFile(svgPath), { density: (72 * WIDTH) / VIEWBOX_W })
  .resize(WIDTH)
  .webp({ quality: 85 })
  .toFile(outPath)

console.log(`protheka-4096.webp: ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KiB`)
