import type * as THREE from "three"

// Height (0..1) at a point of the map, read on the CPU from the same heightmap the terrain is displaced
// with (public/maps/3d/height.png, npm run gen3d): 16-bit in two bytes, R = high, G = low. Bilinear, so a
// pin standing between texels doesn't jump. Used to stand the pins on the ground (Pins.tsx) and to land
// the reveal's focal point on it rather than on the sea plane (Scene.tsx).
export function heightSampler(image: CanvasImageSource & { width: number; height: number }) {
  const c = document.createElement("canvas")
  c.width = image.width
  c.height = image.height
  const ctx = c.getContext("2d", { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
  const px = (x: number, y: number) => {
    const i = (Math.min(height - 1, y) * width + Math.min(width - 1, x)) * 4
    return (data[i] * 256 + data[i + 1]) / 65535
  }
  return (u: number, v: number) => {
    const x = Math.max(0, Math.min(1, u)) * (width - 1)
    const y = Math.max(0, Math.min(1, v)) * (height - 1)
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const fx = x - x0
    const fy = y - y0
    const top = px(x0, y0) * (1 - fx) + px(x0 + 1, y0) * fx
    const bottom = px(x0, y0 + 1) * (1 - fx) + px(x0 + 1, y0 + 1) * fx
    return top * (1 - fy) + bottom * fy
  }
}

export const heightSamplerFor = (tex: THREE.Texture) => heightSampler(tex.image as HTMLImageElement)
