"use client"
import { useEffect, useRef, useState } from "react"
import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch"
import { MAP, type POI } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import MapContent from "./MapContent"
import Controls from "./Controls"
import PoiSheet from "./PoiSheet"
import SmoothWheel from "./SmoothWheel"
import Clouds from "./Clouds"
import { ScreenAtmos } from "./Atmosphere"
import Intro, { createIntroLink, type IntroLink } from "./Intro"
import Tilt from "./Tilt"

// atmos=false (?atmos=0) renders no atmosphere layers or hooks at all, for A/B perf checks
export default function MapShell({ focus, atmos = true }: { focus?: string; atmos?: boolean }) {
  const [selected, setSelected] = useState<POI | null>(null)
  const reduced = useReducedMotion()
  // links MapContent's warm-up, the intro and the clouds without any React state
  const introRef = useRef<IntroLink>(createIntroLink())
  const shellRef = useRef<HTMLDivElement>(null)

  // .tab-hidden pauses all ambient animation while the tab isn't visible (like .moving, set by MapContent)
  useEffect(() => {
    const root = shellRef.current
    if (!root) return
    const sync = () => root.classList.toggle("tab-hidden", document.hidden)
    sync()
    document.addEventListener("visibilitychange", sync)
    return () => document.removeEventListener("visibilitychange", sync)
  }, [])

  return (
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
        onInit={(ref) => {
          // deep link: /map?poi=pass -> fly to that pin
          if (focus) setTimeout(() => ref.zoomToElement(`poi-${focus}`, 3.5, reduced ? 0 : 600), 50)
        }}
      >
        <TransformComponent wrapperStyle={{ width: "100%", height: "100%" }}>
          <MapContent
            onSelect={setSelected}
            atmos={atmos}
            introRef={introRef}
            onReady={() => {
              introRef.current.ready = true
              introRef.current.onReady()
            }}
          />
        </TransformComponent>
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
        <Controls />
        <SmoothWheel />
      </TransformWrapper>

      <PoiSheet poi={selected} onClose={() => setSelected(null)} />
    </div>
  )
}
