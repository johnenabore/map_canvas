"use client"
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type Ref } from "react"
import { KeepScale } from "react-zoom-pan-pinch"
import { DISCOVER, LVL4, MAP } from "@/lib/map"
import { ATMOS_DIR } from "./Atmosphere"
import { ART, ART_PALETTE, STAMP_ART, type ArtAnim, type ArtGlyph } from "./discoveryArt"
import {
  DISCOVERIES,
  closeDiscovery,
  getOpenDiscovery,
  openDiscovery,
  useFound,
  useOpenDiscovery,
  type Discovery,
  type OpenCard,
} from "./discoveryStore"

const TAP_PX = 8 // tap vs drag, the same guard as the pins
const TAP_MS = 300
const ANIM_S: Record<ArtAnim, number> = { bob: DISCOVER.bobS, coil: DISCOVER.coilS, flame: DISCOVER.flameS }

// size of a discovery's art box: width in % of the map width, height in % of the map height
function artBox(d: Discovery) {
  const g: ArtGlyph = ART[d.kind]
  const w = DISCOVER.size * (g.w / 64) * d.scale
  return { w, h: w * (g.h / g.w) * (MAP.w / MAP.h) }
}

// campfire smoke: a few of the volcano's wisps, small and quicker
const WISPS = [0, 1, 2].map((i) => {
  const [min, max] = DISCOVER.smokeS
  const seconds = min + ((max - min) * i) / 2
  return { seconds, delay: -(i / 3) * seconds, tex: [2, 4, 6][i], variant: (i % 2) + 1 }
})

// One glyph: each part is its own <svg> over the whole box. Animated parts are plain CSS transform
// animations on that outer <svg> (a CSS box, so the compositor runs them on their own layer; transforms on
// elements inside an svg would repaint instead).
function Glyph({ g }: { g: ArtGlyph }) {
  return (
    <>
      {g.parts.map((p, i) => (
        <svg
          key={i}
          viewBox={`0 0 ${g.w} ${g.h}`}
          aria-hidden
          className={p.anim ? `disc-part disc-anim disc-anim-${p.anim}` : "disc-part"}
          style={
            p.anim
              ? { transformOrigin: p.origin, animationDuration: `${ANIM_S[p.anim]}s`, animationDelay: p.delay ? `${p.delay}s` : undefined }
              : undefined
          }
        >
          {p.paths.map(([fill, d], j) => (
            <path key={j} fill={ART_PALETTE[fill]} d={d} />
          ))}
        </svg>
      ))}
      {g.smoke && (
        <span
          aria-hidden
          className="atmos-smoke disc-smoke"
          style={{ left: `${g.smoke.x * 100}%`, top: `${g.smoke.y * 100}%`, width: `${g.smoke.w * 100}%` }}
        >
          {WISPS.map((w, i) => (
            <span
              key={i}
              className={`atmos-wisp atmos-wisp-${w.variant}`}
              style={{
                backgroundImage: `url(${ATMOS_DIR}/wisp-${w.tex}.webp)`,
                animationDuration: `${w.seconds}s`,
                animationDelay: `${w.delay.toFixed(2)}s`,
              }}
            />
          ))}
        </span>
      )}
    </>
  )
}

function DiscoveryButton({ d, found }: { d: Discovery; found: boolean }) {
  const start = useRef<{ x: number; y: number } | null>(null)
  const { w, h } = artBox(d)
  const orient = [d.rotation ? `rotate(${d.rotation}deg)` : "", d.flip ? "scaleX(-1)" : ""].join(" ").trim()
  return (
    <button
      type="button"
      data-id={d.id}
      className="disc"
      style={{ left: `${d.x}%`, top: `${d.y}%`, width: `${w}%`, height: `${h}%` }}
      aria-label={found ? `${d.name} (found)` : d.name}
      onPointerDown={(e) => (start.current = { x: e.clientX, y: e.clientY })}
      onClick={(e) => {
        const s = start.current
        start.current = null
        // finger moved = it was a drag, not a tap (keyboard clicks have detail 0 and no pointer)
        if (e.detail !== 0 && s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_PX) return
        if (getOpenDiscovery()?.id === d.id) {
          closeDiscovery() // tapping it again puts the card away
          return
        }
        navigator.vibrate?.(10)
        openDiscovery(d.id, e.detail === 0)
      }}
    >
      {/* stamp-in (MapContent) animates this wrapper; orientation sits on the one inside */}
      <span className="disc-stamp">
        <span className="disc-art" style={orient ? { transform: orient } : undefined}>
          <Glyph g={ART[d.kind]} />
        </span>
      </span>
    </button>
  )
}

// Map-space layer of discoveries: above the detail tier, below the pins. MapContent shows it from LVL4
// (data-discoveries on .map; display:none below), stamps them in and fades them out. Each one is a button
// with a label, so they're in the tab order whenever they're visible.
export function DiscoveryLayer({ ref }: { ref?: Ref<HTMLDivElement> }) {
  const found = useFound()
  return (
    <div
      ref={ref}
      className="layer disc-layer"
      style={
        {
          // invisible hit margin: at least minTargetPx on screen at LVL4 (css px here are x LVL4 on screen)
          "--disc-min": `${(DISCOVER.minTargetPx / LVL4).toFixed(2)}px`,
          transitionDuration: `${DISCOVER.fadeOutMs}ms`,
        } as CSSProperties
      }
    >
      {DISCOVERIES.map((d) => (
        <DiscoveryButton key={d.id} d={d} found={found.includes(d.id)} />
      ))}
    </div>
  )
}

// The discovery moment: a small parchment card above the discovery (below it when there's no room),
// kept at screen size by KeepScale and nudged sideways to stay on screen. Closes on a tap elsewhere, Esc,
// tapping the discovery again, zooming out below LVL4, or after DISCOVER.cardMs (paused while hovered or
// focused; no timeout when opened from the keyboard). A first find gets the ink stamp.
function Card({ d, open }: { d: Discovery; open: OpenCard }) {
  const anchor = useRef<HTMLDivElement>(null)
  const pos = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const box = artBox(d)

  // placement, before paint: above the art if it fits under the top of the map view, else below; then
  // shift sideways to stay inside it (screen px: KeepScale keeps the card at 1:1)
  useLayoutEffect(() => {
    const a = anchor.current
    const p = pos.current
    const btn = document.querySelector(`.disc[data-id="${d.id}"]`)
    const view = a?.closest(".map-shell")?.getBoundingClientRect()
    if (!a || !p || !btn || !view) return
    const art = btn.getBoundingClientRect()
    if (art.top - p.offsetHeight - 16 < view.top + 8) {
      a.style.top = `${d.y + box.h / 2}%`
      p.dataset.side = "below"
    }
    const r = p.getBoundingClientRect()
    const dx = Math.max(view.left + 8 - r.left, Math.min(0, view.right - 8 - r.right))
    if (dx) p.style.setProperty("--dx", `${dx.toFixed(0)}px`)
  }, [d.id, d.y, box.h])

  useEffect(() => {
    const el = card.current
    if (!el) return
    let timer = 0
    let held = false
    const arm = () => {
      clearTimeout(timer)
      if (!open.keyboard && !held) timer = window.setTimeout(closeDiscovery, DISCOVER.cardMs)
    }
    const hold = (on: boolean) => () => {
      held = on
      arm()
    }
    const enter = hold(true)
    const leave = hold(false)
    // a real tap anywhere else closes it (drags and pinches don't); taps on discoveries are theirs to handle
    let down: { x: number; y: number; t: number } | null = null
    const onDown = (e: PointerEvent) => {
      down = e.isPrimary ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null
    }
    const onUp = (e: PointerEvent) => {
      const s = down
      down = null
      if (!s || Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_PX || e.timeStamp - s.t > TAP_MS) return
      if ((e.target as Element | null)?.closest?.(".disc-card, .disc")) return
      closeDiscovery()
    }
    // Esc closes the card first (before an open location sheet), handing focus back to the discovery
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopImmediatePropagation()
      const btn = document.querySelector<HTMLElement>(`.disc[data-id="${d.id}"]`)
      if (el.contains(document.activeElement) || document.activeElement === btn) btn?.focus({ preventScroll: true })
      closeDiscovery()
    }
    arm()
    el.addEventListener("pointerenter", enter)
    el.addEventListener("pointerleave", leave)
    el.addEventListener("focusin", enter)
    el.addEventListener("focusout", leave)
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("pointerup", onUp, true)
    window.addEventListener("keydown", onKey, true)
    return () => {
      clearTimeout(timer)
      el.removeEventListener("pointerenter", enter)
      el.removeEventListener("pointerleave", leave)
      el.removeEventListener("focusin", enter)
      el.removeEventListener("focusout", leave)
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("pointerup", onUp, true)
      window.removeEventListener("keydown", onKey, true)
    }
  }, [d.id, open.keyboard])

  return (
    <div ref={anchor} className="disc-card-anchor" style={{ left: `${d.x}%`, top: `${d.y - box.h / 2}%` }}>
      <KeepScale>
        <div ref={pos} className="disc-card-pos">
          <div ref={card} className="disc-card" role="group" aria-label={`Discovered: ${d.name}`}>
            {open.first && (
              <span className="disc-card-stamp" aria-hidden>
                <Glyph g={STAMP_ART} />
              </span>
            )}
            <p className="disc-card-title">
              <span className="disc-card-kicker">Discovered:</span> {d.name}
            </p>
            <p className="disc-card-lore">{d.lore}</p>
          </div>
        </div>
      </KeepScale>
    </div>
  )
}

// rendered in .map after the pins, so the card sits above them; the live region announces every find
export function DiscoveryCard() {
  const open = useOpenDiscovery()
  const d = open ? DISCOVERIES.find((x) => x.id === open.id) : undefined
  return (
    <>
      <p role="status" className="sr-only">
        {d ? `Discovered: ${d.name}. ${d.lore}${open?.first ? " New find." : ""}` : ""}
      </p>
      {d && open && <Card key={open.seq} d={d} open={open} />}
    </>
  )
}

// screen-space corner chip: hidden until the first find, bumps on each new one
export function DiscoveryCounter() {
  const found = useFound()
  const open = useOpenDiscovery()
  const n = found.length
  const bump = open?.first && found.at(-1) === open.id
  return (
    <div className="disc-counter" data-on={n > 0 || undefined} aria-hidden={n === 0 || undefined}>
      <span key={n} className={bump ? "disc-counter-chip bump" : "disc-counter-chip"}>
        <span className="disc-counter-icon" aria-hidden>
          <Glyph g={STAMP_ART} />
        </span>
        Discoveries {n}/{DISCOVERIES.length}
      </span>
    </div>
  )
}
