"use client"
import { useEffect, useRef } from "react"
import { useTransformInit, type ReactZoomPanPinchContext } from "react-zoom-pan-pinch"
import { MAP } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"

const K_WHEEL = 0.0015 // zoom per pixel of wheel delta (exponential)
const K_PINCH = 0.01   // trackpad pinch arrives as ctrl+wheel with much smaller deltas
const EASE = 0.2       // fraction of the remaining distance covered per frame
const LINE_PX = 16     // deltaMode 1 (lines) -> pixels

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

// Mirrors the library's private calculateBounds/getBounds (react-zoom-pan-pinch 4.2.0).
// setTransform/setState do NOT clamp, so we must. MapShell doesn't use disablePadding
// or min/maxPosition props, so those branches are left out.
export function clampToBounds(instance: ReactZoomPanPinchContext, scale: number, x: number, y: number) {
  const wrapper = instance.wrapperComponent!
  const content = instance.contentComponent!
  const ww = wrapper.clientWidth
  const wh = wrapper.clientHeight
  const cw = content.offsetWidth * scale
  const ch = content.offsetHeight * scale
  const f = instance.setup.centerZoomedOut ? 0.5 : 1
  const padX = ww > cw ? (ww - cw) * f : 0
  const padY = wh > ch ? (wh - ch) * f : 0
  return { x: clamp(x, ww - cw - padX, padX), y: clamp(y, wh - ch - padY, padY) }
}

// Eased mouse-wheel zoom. The library applies each wheel notch as an instant jump;
// this accumulates a target scale and lerps toward it every frame around the cursor.
// Requires wheel={{ disabled: true }} on TransformWrapper.
export default function SmoothWheel() {
  const reduced = useReducedMotion()
  const reducedRef = useRef(reduced)
  useEffect(() => {
    reducedRef.current = reduced
  }, [reduced])

  useTransformInit(({ instance }) => {
    const wrapper = instance.wrapperComponent
    if (!wrapper) return
    let target = instance.state.scale
    let raf = 0
    let cx = 0
    let cy = 0

    // zoom around the cursor, then clamp so the map never drifts off-screen
    const apply = (scale: number) => {
      const { scale: old, positionX, positionY } = instance.state
      let x = cx - (cx - positionX) * (scale / old)
      let y = cy - (cy - positionY) * (scale / old)
      if (instance.setup.limitToBounds) ({ x, y } = clampToBounds(instance, scale, x, y))
      // setState fires onChange/onTransform, so useTransformEffect and KeepScale still run
      instance.setState(scale, x, y)
    }

    const tick = () => {
      const diff = target - instance.state.scale
      if (Math.abs(diff) < 0.001) {
        apply(target)
        raf = 0
        return
      }
      apply(instance.state.scale + diff * EASE)
      raf = requestAnimationFrame(tick)
    }

    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }

    const onWheel = (e: WheelEvent) => {
      if (instance.setup.disabled || e.deltaY === 0) return // horizontal swipe: not a zoom
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * wrapper.clientHeight : e.deltaY
      // start from the live scale if pinch/double-click/buttons changed it since the last wheel
      if (!raf) target = instance.state.scale
      target = clamp(target * Math.exp(-dy * (e.ctrlKey ? K_PINCH : K_WHEEL)), MAP.minScale, MAP.maxScale)
      const r = wrapper.getBoundingClientRect()
      cx = e.clientX - r.left
      cy = e.clientY - r.top
      if (reducedRef.current) {
        stop()
        apply(target)
      } else if (!raf) {
        raf = requestAnimationFrame(tick)
      }
    }

    wrapper.addEventListener("wheel", onWheel, { passive: false })
    // a drag or pinch takes over: stop easing so we don't fight it
    wrapper.addEventListener("pointerdown", stop)
    wrapper.addEventListener("touchstart", stop, { passive: true })
    return () => {
      stop()
      wrapper.removeEventListener("wheel", onWheel)
      wrapper.removeEventListener("pointerdown", stop)
      wrapper.removeEventListener("touchstart", stop)
    }
  })

  return null
}
