"use client"
import { useEffect, useRef, useState, type RefObject } from "react"
import { useTransformEffect, useTransformInit, type ReactZoomPanPinchContext } from "react-zoom-pan-pinch"
import { DISCOVER, LOD, MAP, MAP_BLUR, LVL2, LVL3, LVL4, POIS, REVEAL, type POI } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import PoiPin from "./PoiPin"
import { MapPaper, MapSpaceAtmos } from "./Atmosphere"
import Birds from "./Birds"
import { DiscoveryCard, DiscoveryLayer } from "./Discoveries"
import { DISCOVERIES, closeDiscovery } from "./discoveryStore"
import type { IntroLink } from "./Intro"

type Tier = "terrain" | "detail"
const TIER_LEVEL: Record<Tier, number> = { terrain: LVL2, detail: LVL3 }
type Point = { x: number; y: number } // % of the map content
type Reveal = { anims: Animation[] | null; timer: number }

// mask properties with and without the -webkit- prefix (older Safari only knows the prefixed ones)
const setMask = (el: HTMLElement, prop: string, value: string) => {
  el.style.setProperty(`-webkit-mask-${prop}`, value)
  el.style.setProperty(`mask-${prop}`, value)
}
const clearMask = (el: HTMLElement) => {
  for (const prop of ["image", "repeat", "size", "position"]) {
    el.style.removeProperty(`-webkit-mask-${prop}`)
    el.style.removeProperty(`mask-${prop}`)
  }
}

// CSS cubic-bezier easing: time fraction -> progress (bisection on the curve's x)
function cubicBezier([x1, y1, x2, y2]: readonly [number, number, number, number]) {
  const at = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3
  return (x: number) => {
    let lo = 0
    let hi = 1
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2
      if (at(mid, x1, x2) < x) lo = mid
      else hi = mid
    }
    return at((lo + hi) / 2, y1, y2)
  }
}
const spreadEase = cubicBezier(REVEAL.easing)
// time fraction at which the eased progress reaches p
const timeAt = (p: number) => {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2
    if (spreadEase(mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
// Keyframes for a spread from scale k0 to 1: scales step geometrically (constant ratio), each placed in
// time where the eased progress reaches it. The wrapper plays s and the image inside plays 1/s; with a
// small ratio per step, linear interpolation keeps s x (1/s) within ~0.2% of 1, so the map holds still.
function spreadFrames(k0: number, steps = 48) {
  const frames: { offset: number; s: number }[] = []
  for (let i = 0; i <= steps; i++) {
    const s = i === steps ? 1 : k0 * Math.pow(1 / k0, i / steps)
    frames.push({ offset: i === 0 ? 0 : i === steps ? 1 : timeAt((s - k0) / (1 - k0)), s })
  }
  return frames
}

export default function MapContent({
  onPinTap,
  selectedId,
  atmos,
  onReady,
  introRef,
}: {
  onPinTap: (p: POI, at: { x: number; y: number }) => void
  selectedId: string | null // focus mode: data-focus on .map dims the other pins
  atmos: boolean
  onReady?: () => void
  introRef: RefObject<IntroLink>
}) {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef({ lvl: "1", scale: 1 })
  const idle = useRef<number | undefined>(undefined)
  const moving = useRef(false)
  // MapShell's root (.map-shell): .moving goes there so it reaches the screen-space flicker too
  const shell = useRef<HTMLElement | null>(null)
  const img = useRef<HTMLImageElement>(null)
  const terrainWrap = useRef<HTMLDivElement>(null)
  const detailWrap = useRef<HTMLDivElement>(null)
  const terrainImg = useRef<HTMLImageElement>(null)
  const detailImg = useRef<HTMLImageElement>(null)
  const decoded = useRef<Record<Tier, boolean>>({ terrain: false, detail: false })
  const shown = useRef<Record<Tier, boolean>>({ terrain: false, detail: false })
  const reveals = useRef<Record<Tier, Reveal>>({
    terrain: { anims: null, timer: 0 },
    detail: { anims: null, timer: 0 },
  })
  const discLayer = useRef<HTMLDivElement>(null)
  const discShown = useRef(false)
  const discTimer = useRef(0)
  const inst = useRef<ReactZoomPanPinchContext | null>(null)
  const focal = useRef<(Point & { t: number }) | null>(null) // last gesture focal point
  const [ready, setReady] = useState(false)
  const reduced = useReducedMotion()
  const plain = useRef(true) // plain fades (reduced motion / REVEAL off); true until hydrated
  useEffect(() => {
    plain.current = reduced || !REVEAL.enabled
  }, [reduced])

  // ---- focal point: the map point (content %) under a screen point, and the current focal point
  const toContent = (clientX: number, clientY: number): Point | null => {
    const i = inst.current
    const wrapper = i?.wrapperComponent
    const map = ref.current
    if (!i || !wrapper || !map) return null
    const r = wrapper.getBoundingClientRect()
    const { scale, positionX, positionY } = i.state
    return {
      x: ((clientX - r.left - positionX) / scale / map.offsetWidth) * 100,
      y: ((clientY - r.top - positionY) / scale / map.offsetHeight) * 100,
    }
  }
  // a fresh gesture point (pinch midpoint, wheel cursor, double-click/tap), else the viewport centre
  // (button zoom, flyTo)
  const focalNow = (): Point => {
    const f = focal.current
    if (f && performance.now() - f.t < REVEAL.focalFreshMs) return f
    const w = inst.current?.wrapperComponent
    const r = w?.getBoundingClientRect()
    return (r && toContent(r.left + r.width / 2, r.top + r.height / 2)) ?? { x: 50, y: 50 }
  }

  // ---- ink-spread reveal. The mask never changes while it spreads (changing a mask or clip-path
  // re-rasterizes the heavy tier every frame in Chrome); instead the ink blot is fixed at its final size
  // on the tier wrapper, and the wrapper scales up from the focal point while the tier image inside scales
  // down by the exact inverse. Both are transform animations on the compositor: the image stays put, the
  // blot grows, and only the (cheap) mask layer is ever re-rastered. Everything is removed at the end.
  const tierEl = (tier: Tier) => (tier === "terrain" ? terrainWrap : detailWrap).current
  const finishReveal = (tier: Tier) => {
    const r = reveals.current[tier]
    clearTimeout(r.timer)
    r.anims?.forEach((a) => a.cancel())
    r.anims = null
    const el = tierEl(tier)
    if (!el) return
    clearMask(el) // zero ongoing cost once the spread is done
    el.style.removeProperty("transition")
    el.style.removeProperty("transform-origin")
    ;(el.firstElementChild as HTMLElement | null)?.style.removeProperty("transform-origin")
  }
  const revealOn = (tier: Tier) => {
    const el = tierEl(tier)
    const img = el?.firstElementChild as HTMLElement | null
    const map = ref.current
    if (!el || !img || !map) return
    const r = reveals.current[tier]
    if (!plain.current) {
      if (r.anims) {
        // back on while a switch-off was fading a half-spread blot: keep soaking from where it paused
        clearTimeout(r.timer)
        el.style.transition = `opacity ${REVEAL.fadeInMs}ms ease-out`
        r.anims.forEach((a) => a.play())
      } else if (parseFloat(getComputedStyle(el).opacity) < 0.05) {
        // fresh spread: the blot starts small on the focal point and ends where its solid core covers
        // what's on screen (sized to the visible part of the map, so the spread crosses the screen over
        // the whole duration; the off-screen rest appears when the mask is dropped at the end)
        const f = focalNow()
        const w = el.offsetWidth
        const h = el.offsetHeight
        const fx = (f.x / 100) * w
        const fy = (f.y / 100) * h
        const cam = inst.current
        const vw = cam?.wrapperComponent?.clientWidth ?? w
        const vh = cam?.wrapperComponent?.clientHeight ?? h
        const s = cam?.state.scale ?? 1
        const x0 = Math.max(0, -(cam?.state.positionX ?? 0) / s)
        const y0 = Math.max(0, -(cam?.state.positionY ?? 0) / s)
        const x1 = Math.min(w, x0 + vw / s)
        const y1 = Math.min(h, y0 + vh / s)
        const reach = Math.max(Math.hypot(fx - x0, fy - y0), Math.hypot(x1 - fx, fy - y0), Math.hypot(fx - x0, y1 - fy), Math.hypot(x1 - fx, y1 - fy))
        const cover = (reach / REVEAL.maskCore) * REVEAL.maskScale
        const frames = spreadFrames(Math.min(0.9, (REVEAL.maskStart * Math.max(x1 - x0, y1 - y0)) / cover))
        el.style.transition = `opacity ${REVEAL.fadeInMs}ms ease-out` // the ink soaks in, not a hard wipe
        el.style.transformOrigin = img.style.transformOrigin = `${fx.toFixed(1)}px ${fy.toFixed(1)}px`
        setMask(el, "image", `url(${REVEAL.mask})`)
        setMask(el, "repeat", "no-repeat")
        setMask(el, "size", `${cover.toFixed(1)}px ${cover.toFixed(1)}px`)
        setMask(el, "position", `${(fx - cover / 2).toFixed(1)}px ${(fy - cover / 2).toFixed(1)}px`)
        const timing = { duration: REVEAL.spreadMs, easing: "linear", fill: "both" as const }
        const spread = el.animate(frames.map(({ offset, s }) => ({ offset, transform: `scale(${s})` })), timing)
        const hold = img.animate(frames.map(({ offset, s }) => ({ offset, transform: `scale(${1 / s})` })), timing)
        r.anims = [spread, hold]
        spread.finished.then(() => finishReveal(tier), () => {}) // cancelled: finishReveal already ran
      }
      // else: still partly visible from an unmasked fade-out, so it simply fades back in (CSS)
    }
    map.setAttribute(`data-${tier}`, "")
  }
  const revealOff = (tier: Tier) => {
    const el = tierEl(tier)
    const map = ref.current
    if (!el || !map) return
    const r = reveals.current[tier]
    if (r.anims) {
      // off mid-spread: freeze the blot where it is (both animations together), fade out, then clean up
      r.anims.forEach((a) => a.pause())
      el.style.transition = `opacity ${REVEAL.fadeOutMs}ms ease-out`
      clearTimeout(r.timer)
      r.timer = window.setTimeout(() => finishReveal(tier), REVEAL.fadeOutMs + 50)
    }
    map.removeAttribute(`data-${tier}`)
  }

  // Level-triggered tiers: switch when the zoom crosses LVL2 / LVL3 (and the tier is decoded).
  // Hysteresis: once shown, a tier hides only below (level - LOD.hysteresis). Writes only on a change.
  const syncTiers = (scale: number) => {
    if (!ref.current || !LOD.enabled) return
    for (const tier of ["terrain", "detail"] as const) {
      const level = TIER_LEVEL[tier]
      const want = decoded.current[tier] && scale >= (shown.current[tier] ? level - LOD.hysteresis : level)
      if (want !== shown.current[tier]) {
        shown.current[tier] = want
        if (want) revealOn(tier)
        else revealOff(tier)
      }
    }
  }

  // (re)start the stamp-in on an element: transform + opacity, delayed by its place in the queue
  const stamp = (el: HTMLElement, delayMs: number, durationMs: number) => {
    el.classList.remove("stamp")
    el.style.animationDuration = `${durationMs}ms`
    el.style.animationDelay = `${delayMs}ms`
    void el.offsetWidth // restart cleanly if it was still stamping
    el.classList.add("stamp")
    el.addEventListener("animationend", () => el.classList.remove("stamp"), { once: true })
  }
  // nearest the focal point first
  const byDistance = <T extends Point>(items: T[]) => {
    const f = focalNow()
    return items
      .map((item) => ({ item, d: Math.hypot(((item.x - f.x) * MAP.w) / 100, ((item.y - f.y) * MAP.h) / 100) }))
      .sort((a, b) => a.d - b.d)
      .map(({ item }) => item)
  }

  // pins that appear at a new level stamp in, closest to the focal point first (transform + opacity on
  // the pin button; KeepScale owns the wrapper's transform). Pins already visible don't animate.
  const stampPins = (from: number, to: number) => {
    const map = ref.current
    if (!map || plain.current) return
    byDistance(POIS.filter((p) => p.minLevel > from && p.minLevel <= to)).forEach((p, i) => {
      const pin = map.querySelector<HTMLElement>(`#poi-${p.id} .poi-pin`)
      if (pin) stamp(pin, i * REVEAL.pinStaggerMs, REVEAL.pinStampMs)
    })
  }

  // Deep-zoom discoveries: shown from LVL4 (hidden again only below LVL4 - hysteresis). ON = display, then
  // every discovery stamps in like the pins, nearest the focal point first; OFF = the layer fades
  // (opacity), then display:none, and any open card closes. Back ON mid-fade just fades back in.
  const syncDiscoveries = (scale: number) => {
    const map = ref.current
    if (!map || !DISCOVER.enabled) return
    const want = scale >= (discShown.current ? LVL4 - DISCOVER.hysteresis : LVL4)
    if (want === discShown.current) return
    discShown.current = want
    clearTimeout(discTimer.current)
    if (want) {
      const fading = map.dataset.discoveries === "out"
      map.dataset.discoveries = "on"
      const layer = discLayer.current
      if (fading || !layer || plain.current) return
      byDistance(DISCOVERIES).forEach((d, i) => {
        const el = layer.querySelector<HTMLElement>(`.disc[data-id="${d.id}"] .disc-stamp`)
        if (el) stamp(el, i * DISCOVER.staggerMs, DISCOVER.stampMs)
      })
    } else {
      closeDiscovery()
      if (plain.current) {
        delete map.dataset.discoveries
        return
      }
      map.dataset.discoveries = "out"
      discTimer.current = window.setTimeout(() => delete map.dataset.discoveries, DISCOVER.fadeOutMs)
    }
  }

  // Warm up before the first gesture: decode the base tier and promote the GPU layer now, so the first
  // zooms don't pay for decode + layer creation + texture upload mid-gesture. The blur placeholder shows
  // until the base is decoded; then terrain/detail (and the reveal's ink mask) decode in the background,
  // long before the user can zoom to their levels (if they get there first, the tier appears as soon as
  // it's ready). One state change on load, not per frame.
  useEffect(() => {
    let alive = true
    const base = img.current
    if (!base) return
    base
      .decode()
      .catch(() => {}) // broken/unsupported decode: still reveal the img
      .then(() => {
        if (!alive) return
        // TransformComponent renders wrapper > content (transformed) > children, so .map's parent is the content element.
        // Cleared again by the debounced reset in useTransformEffect after the first gesture.
        const content = ref.current?.parentElement
        if (content) content.style.willChange = "transform"
        setReady(true)
        onReady?.() // the intro waits for this (plus the 300ms fade) before it starts
        const mask = new Image()
        mask.src = REVEAL.mask
        mask.decode().catch(() => {})
        const tierImgs = { terrain: terrainImg.current, detail: detailImg.current }
        for (const tier of ["terrain", "detail"] as const) {
          tierImgs[tier]
            ?.decode()
            .catch(() => {})
            .then(() => {
              if (!alive) return
              decoded.current[tier] = true
              syncTiers(last.current.scale)
            })
        }
      })
    return () => {
      alive = false
    }
    // run once on mount; onReady is read when the decode settles
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // remember where gestures happen, in map space (the zoom stays anchored there, so the point holds)
  useTransformInit(({ instance }) => {
    inst.current = instance
    const wrapper = instance.wrapperComponent
    if (!wrapper) return
    const mark = (x: number, y: number) => {
      const c = toContent(x, y)
      if (c) focal.current = { ...c, t: performance.now() }
    }
    const onWheel = (e: WheelEvent) => mark(e.clientX, e.clientY)
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length >= 2) mark((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2)
    }
    const onDouble = (e: MouseEvent) => mark(e.clientX, e.clientY)
    let tap = { x: 0, y: 0, t: -1e9 }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return // mice get dblclick
      if (e.timeStamp - tap.t < 300 && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) < 40) mark(e.clientX, e.clientY)
      tap = { x: e.clientX, y: e.clientY, t: e.timeStamp }
    }
    const opts = { capture: true, passive: true } as const
    wrapper.addEventListener("wheel", onWheel, opts)
    wrapper.addEventListener("touchstart", onTouch, opts)
    wrapper.addEventListener("touchmove", onTouch, opts)
    wrapper.addEventListener("dblclick", onDouble, opts)
    wrapper.addEventListener("pointerdown", onDown, opts)
    return () => {
      wrapper.removeEventListener("wheel", onWheel, opts)
      wrapper.removeEventListener("touchstart", onTouch, opts)
      wrapper.removeEventListener("touchmove", onTouch, opts)
      wrapper.removeEventListener("dblclick", onDouble, opts)
      wrapper.removeEventListener("pointerdown", onDown, opts)
    }
  })

  useTransformEffect(({ state, instance }) => {
    // --- smooth movement: GPU layer while moving ---
    const content = instance.contentComponent
    if (content) {
      if (content.style.willChange !== "transform") content.style.willChange = "transform"
      // .moving pauses all ambient animation (shadows, smoke, birds, flicker): 2 class writes per
      // gesture, not per frame
      shell.current ??= ref.current?.closest<HTMLElement>(".map-shell") ?? null
      const root = shell.current
      if (!moving.current) {
        moving.current = true
        root?.classList.add("moving")
      }
      clearTimeout(idle.current)
      idle.current = window.setTimeout(() => {
        content.style.willChange = "auto" // re-sharpen when stopped
        moving.current = false
        root?.classList.remove("moving")
      }, 400)
    }

    // --- zoom-level logic: write only when the value changed ---
    const el = ref.current
    if (!el) return
    last.current.scale = state.scale
    const z = Math.round(state.scale * 100) / 100
    const lvl = z >= LVL4 ? "4" : z >= LVL3 ? "3" : z >= LVL2 ? "2" : "1"
    if (lvl !== last.current.lvl) {
      const from = Number(last.current.lvl)
      el.dataset.lvl = lvl // pin visibility
      last.current.lvl = lvl
      if (Number(lvl) > from) stampPins(from, Number(lvl))
    }
    syncTiers(state.scale)
    syncDiscoveries(state.scale)
  })

  const fade = `transition-opacity duration-300 motion-reduce:transition-none ${ready ? "opacity-100" : "opacity-0"}`
  return (
    <div
      ref={ref}
      data-lvl="1"
      data-focus={selectedId ?? undefined}
      className="map relative"
      style={{
        height: "100dvh",
        aspectRatio: `${MAP.w} / ${MAP.h}`,
        backgroundImage: `url(${MAP_BLUR})`,
        backgroundSize: "100% 100%",
      }}
    >
      {/* base tier (or the single-file fallback): not promoted, painted into the content layer with the
          paper grain; revealed once decoded */}
      <img ref={img} src={LOD.enabled ? LOD.base : LOD.fallback} alt="" draggable={false}
        className={`layer ${fade}`} fetchPriority="high" decoding="async" />
      {atmos && <MapPaper />}
      {/* terrain/detail tiers: each wrapper is its own promoted layer, switched by data-terrain /
          data-detail; the ink-spread mask goes on the wrapper, never on the heavy <img> */}
      {LOD.enabled && (
        <>
          <div ref={terrainWrap} aria-hidden className="layer lod-tier lod-terrain">
            <img ref={terrainImg} src={LOD.terrain} alt="" draggable={false} className="layer"
              fetchPriority="low" decoding="async" />
          </div>
          <div ref={detailWrap} aria-hidden className="layer lod-tier lod-detail">
            <img ref={detailImg} src={LOD.detail} alt="" draggable={false} className="layer"
              fetchPriority="low" decoding="async" />
          </div>
        </>
      )}
      {/* deep-zoom discoveries: above the detail tier, below the pins; content, so kept with ?atmos=0 */}
      {DISCOVER.enabled && <DiscoveryLayer ref={discLayer} />}
      {/* above the map tiers, below the pins (see Atmosphere.tsx for why the order matters) */}
      {atmos && <MapSpaceAtmos />}
      {atmos && <Birds introRef={introRef} />}

      {POIS.map((p) => (
        <PoiPin key={p.id} poi={p} selected={p.id === selectedId} onTap={onPinTap} />
      ))}
      {/* after the pins, so a discovery's card sits above them */}
      {DISCOVER.enabled && <DiscoveryCard />}
    </div>
  )
}
