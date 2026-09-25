"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { TransformWrapper, TransformComponent, type ReactZoomPanPinchContext } from "react-zoom-pan-pinch"
import { FOCUS, MAP, POIS, SHEET, type POI } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import { useMediaQuery } from "@/lib/useMediaQuery"
import MapContent from "./MapContent"
import Controls from "./Controls"
import PoiSheet from "./PoiSheet"
import SmoothWheel from "./SmoothWheel"
import Clouds from "./Clouds"
import Spotlight from "./Spotlight"
import { ScreenAtmos } from "./Atmosphere"
import Intro, { createIntroLink, type IntroLink } from "./Intro"
import Tilt from "./Tilt"
import { flyTo, focusScale, visibleCentre } from "./camera"

const HISTORY_KEY = "protheka" // marks the history entries we push for an open location
const TAP_PX = 8                // map tap vs drag (same guard as the pins)
const TAP_MS = 300

const byId = (id: string | null | undefined) => POIS.find((p) => p.id === id) ?? null

// current URL with ?poi= set or removed, keeping everything else (e.g. ?atmos=0)
function urlWith(id: string | null) {
  const url = new URL(window.location.href)
  if (id) url.searchParams.set("poi", id)
  else url.searchParams.delete("poi")
  return url.pathname + url.search + url.hash
}

// atmos=false (?atmos=0) renders no atmosphere layers or hooks at all, for A/B perf checks
export default function MapShell({ focus, atmos = true }: { focus?: string; atmos?: boolean }) {
  const [selected, setSelected] = useState<POI | null>(null)
  const reduced = useReducedMotion()
  const desktop = useMediaQuery(SHEET.desktopQuery)
  // links MapContent's warm-up, the intro and the clouds without any React state
  const introRef = useRef<IntroLink>(createIntroLink())
  const shellRef = useRef<HTMLDivElement>(null)
  const ripples = useRef<HTMLDivElement>(null)
  const instance = useRef<ReactZoomPanPinchContext | null>(null)
  // id of the open (or deep-link pending) location, for handlers registered once
  const openId = useRef<string | null>(null)
  const env = useRef({ reduced, desktop })
  useEffect(() => {
    env.current = { reduced, desktop }
  }, [reduced, desktop])

  // .tab-hidden pauses all ambient animation while the tab isn't visible (like .moving, set by MapContent)
  useEffect(() => {
    const root = shellRef.current
    if (!root) return
    const sync = () => root.classList.toggle("tab-hidden", document.hidden)
    sync()
    document.addEventListener("visibilitychange", sync)
    return () => document.removeEventListener("visibilitychange", sync)
  }, [])

  // camera: put the location in the middle of the part of the map the sheet/panel leaves visible,
  // zooming to its kind's level (never out, never below where its pin shows). Reduced motion: jump.
  const frame = useCallback((poi: POI) => {
    const inst = instance.current
    const wrapper = inst?.wrapperComponent
    if (!inst || !wrapper) return Promise.resolve("cancelled" as const)
    const { reduced, desktop } = env.current
    return flyTo(inst, poi.x, poi.y, focusScale(poi, inst.state.scale), reduced ? 0 : FOCUS.flyMs, {
      focus: visibleCentre(wrapper.clientWidth, wrapper.clientHeight, desktop),
    }).done
  }, [])

  // local open/close only; history is handled by the callers
  const show = useCallback((poi: POI | null) => {
    openId.current = poi?.id ?? null
    setSelected(poi)
  }, [])

  // open a location from a tap / prev-next: push a ?poi= entry (replace it when switching while open,
  // so Back doesn't step through every pin), open the sheet and fly there at the same time
  const openPoi = useCallback(
    (poi: POI) => {
      if (openId.current === poi.id) {
        frame(poi) // same pin again: just re-frame it
        return
      }
      const state = { [HISTORY_KEY]: 1 }
      if (openId.current) window.history.replaceState(state, "", urlWith(poi.id))
      else window.history.pushState(state, "", urlWith(poi.id))
      show(poi)
      frame(poi)
    },
    [frame, show],
  )

  // close: step back off our own entry (popstate below does the closing, and Forward reopens it);
  // otherwise close here and drop ?poi= from the URL
  const closePoi = useCallback(() => {
    if (!openId.current) return
    if (window.history.state?.[HISTORY_KEY]) {
      window.history.back()
    } else {
      window.history.replaceState(null, "", urlWith(null))
      show(null)
    }
  }, [show])
  const closeRef = useRef(closePoi)
  useEffect(() => {
    closeRef.current = closePoi
  }, [closePoi])

  const step = useCallback(
    (dir: 1 | -1) => {
      const i = POIS.findIndex((p) => p.id === openId.current)
      if (i >= 0) openPoi(POIS[(i + dir + POIS.length) % POIS.length])
    },
    [openPoi],
  )

  // Back/Forward: the URL decides. Next.js restores its own state for our entries (they carry its
  // internal tree), so the page stays mounted; this only opens/closes the sheet.
  useEffect(() => {
    const onPop = () => {
      const poi = byId(new URLSearchParams(window.location.search).get("poi"))
      show(poi)
      if (poi) frame(poi)
    }
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [show, frame])

  // tap feedback: an ink ripple at the pin's tip (screen space, removed when its animation ends)
  const ripple = useCallback((at: { x: number; y: number }) => {
    const layer = ripples.current
    if (!layer || env.current.reduced) return
    const box = layer.getBoundingClientRect()
    const r = document.createElement("div")
    r.className = "poi-ripple"
    r.style.left = `${at.x - box.left}px`
    r.style.top = `${at.y - box.top}px`
    r.addEventListener("animationend", () => r.remove(), { once: true })
    layer.appendChild(r)
  }, [])

  const onPinTap = useCallback(
    (poi: POI, at: { x: number; y: number }) => {
      ripple(at)
      openPoi(poi)
    },
    [ripple, openPoi],
  )

  const onInit = (inst: ReactZoomPanPinchContext) => {
    instance.current = inst
    const wrapper = inst.wrapperComponent
    if (!wrapper) return

    // a real tap on the map (not a drag or pinch, not a pin) closes the sheet
    let down: { x: number; y: number; t: number } | null = null
    wrapper.addEventListener("pointerdown", (e) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null
    })
    wrapper.addEventListener("pointerup", (e) => {
      const d = down
      down = null
      if (!d || !openId.current || (e.target as Element).closest(".poi")) return
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_PX || e.timeStamp - d.t > TAP_MS) return
      closeRef.current()
    })

    // deep link (?poi= on load, or coming Back from a story): fly there, then open the sheet. Make the
    // entry below it the plain map first, so Back closes the sheet instead of leaving the page.
    const poi = byId(new URLSearchParams(window.location.search).get("poi") ?? focus)
    if (!poi) return
    if (!window.history.state?.[HISTORY_KEY]) {
      window.history.replaceState(null, "", urlWith(null))
      window.history.pushState({ [HISTORY_KEY]: 1 }, "", urlWith(poi.id))
    }
    openId.current = poi.id // pending: taps meanwhile switch (replaceState) instead of pushing
    setTimeout(() => {
      frame(poi).then(() => {
        if (openId.current === poi.id) show(poi)
      })
    }, 50)
  }

  return (
    <>
      <div ref={shellRef} className="map-shell relative h-[100dvh] w-full touch-none overflow-hidden bg-[#412511]">
        <TransformWrapper
          minScale={MAP.minScale}
          maxScale={MAP.maxScale}
          centerOnInit
          limitToBounds
          // wheel/trackpad zoom is handled by <SmoothWheel /> (eased); the library's is instant per notch
          wheel={{ disabled: true }}
          // glide after a flick
          velocityAnimation={{ disabled: reduced, animationTime: 400, maxAnimationTime: 900, animationType: "easeOutCubic" }}
          // rubber-band snap back from the edges
          autoAlignment={{
            animationTime: reduced ? 0 : 250,
            velocityAlignmentTime: reduced ? 0 : 400,
            animationType: "easeOutCubic",
          }}
          doubleClick={{ mode: "zoomIn", step: 0.7, animationTime: reduced ? 0 : 150, animationType: "easeOutCubic" }}
          zoomAnimation={{ animationTime: reduced ? 0 : 200 }}
          onInit={(ref) => onInit(ref.instance)}
        >
          <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
            <MapContent
              onPinTap={onPinTap}
              selectedId={selected?.id ?? null}
              atmos={atmos}
              introRef={introRef}
              onReady={() => {
                introRef.current.ready = true
                introRef.current.onReady()
              }}
            />
          </TransformComponent>
          {/* focus mode: darkens the map around the open location, follows it through pans/zooms */}
          <Spotlight poi={selected} />
          {/* screen-space atmosphere: above the map, below the controls and sheet.
              The intro's veil sits under the clouds; a ?poi= deep link flies in instead of the intro. */}
          {atmos && !focus && <Intro introRef={introRef} />}
          {/* data-tilt wrappers carry the depth-tilt offset (Tilt.tsx), separate from Clouds' own transforms */}
          {atmos && (
            <div data-tilt="clouds" className="atmos-tilt">
              <Clouds introRef={introRef} />
            </div>
          )}
          {atmos && <ScreenAtmos />}
          {atmos && <Tilt shellRef={shellRef} />}
          <div ref={ripples} aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" />
          <Controls panelOpen={desktop && selected !== null} />
          <SmoothWheel />
        </TransformWrapper>
      </div>

      {/* outside the touch-none root, so the sheet's body can still scroll natively */}
      <PoiSheet poi={selected} desktop={desktop} reduced={reduced} onClose={closePoi} onStep={step} />
    </>
  )
}
