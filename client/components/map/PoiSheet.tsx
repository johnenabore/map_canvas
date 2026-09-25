"use client"
import Link from "next/link"
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { SHEET, type POI } from "@/lib/map"

type Snap = "peek" | "half" | "full"

const KIND_LABEL: Record<POI["kind"], string> = { region: "Region", city: "City", landmark: "Landmark" }
const SPRING = "transform 0.38s cubic-bezier(0.2, 1.1, 0.3, 1)" // gentle overshoot
const LOCK_PX = 8        // movement before a drag picks a direction
const SWIPE_PX = 60      // horizontal distance that switches location
const FLICK_MS = 150     // projection window for flick velocity
const CLOSE_PX = 60      // how far past peek (projected) a downward swipe closes

type Drag = {
  id: number
  x0: number
  y0: number
  sheetY0: number
  mode: "v" | "h" | null
  fromBody: boolean
  samples: { y: number; t: number }[]
}

// Location sheet. Phones: a bottom sheet with peek / half / full snaps, dragged with pointer events and
// translate3d written straight to the DOM (React state only changes when a snap settles); a flick's
// velocity picks the snap, swiping down from peek closes. Desktop (>= 1024px, fine pointer): a 380px
// side panel. Both: role="dialog" labelled by the name, focus moves in on open and back to the pin on
// close, Esc closes, prev/next buttons plus a horizontal swipe (touch/pen) switch location.
export default function PoiSheet({
  poi,
  desktop,
  reduced,
  onClose,
  onStep,
}: {
  poi: POI | null
  desktop: boolean
  reduced: boolean
  onClose: () => void
  onStep: (dir: 1 | -1) => void
}) {
  const sheet = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const drag = useRef<Drag | null>(null)
  const wasOpen = useRef(false)
  const y = useRef(0) // current translateY (phone)
  const [snap, setSnap] = useState<Snap>("half")

  // keep showing the last location while the sheet slides away
  const [last, setLast] = useState<POI | null>(poi)
  if (poi && poi !== last) setLast(poi)
  // every open starts at half
  if (!poi && snap !== "half") setSnap("half")
  const shown = poi ?? last
  const open = poi !== null

  // ---- phone geometry (px): translateY for each snap; the sheet is SHEET.full of the viewport tall
  const metrics = () => {
    const vh = window.innerHeight
    const h = sheet.current?.offsetHeight ?? vh * SHEET.full
    return {
      closed: h + 24,
      peek: h - SHEET.peekPx,
      half: h - vh * SHEET.half,
      full: 0,
    }
  }
  const setY = (to: number, animate: boolean) => {
    const el = sheet.current
    if (!el) return
    y.current = to
    el.style.transition = animate && !reduced ? SPRING : "none"
    el.style.transform = `translate3d(0,${to.toFixed(1)}px,0)`
  }
  const goTo = (s: Snap) => {
    setY(metrics()[s], true)
    setSnap(s)
  }

  // open / close / layout switch: position the sheet, move focus in and back out
  useLayoutEffect(() => {
    const el = sheet.current
    if (!el) return
    if (desktop) {
      // the side panel slides with CSS (data-open); drop any phone transform
      el.style.transform = ""
      el.style.transition = ""
    } else if (open && !wasOpen.current) {
      setY(metrics().closed, false)
      void el.offsetHeight // commit the start position so the slide-in animates
      setY(metrics().half, true)
    } else if (!open) {
      setY(metrics().closed, wasOpen.current)
    } else {
      setY(metrics()[snap], false) // layout switched while open
    }
    if (open && !wasOpen.current) title.current?.focus({ preventScroll: true })
    if (!open && wasOpen.current && last) {
      document.querySelector<HTMLElement>(`#poi-${last.id} button`)?.focus({ preventScroll: true })
    }
    wasOpen.current = open
    // position follows open/layout changes only; snaps move via goTo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, desktop])

  // prev/next while open: announce the new location by moving focus to its name
  useEffect(() => {
    if (open) title.current?.focus({ preventScroll: true })
  }, [open, poi?.id])

  // Esc closes; the viewport height changing re-applies the current snap (phone)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    const onResize = () => {
      if (!desktop && !drag.current) setY(metrics()[snap], false)
    }
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", onResize)
    return () => {
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, desktop, snap, onClose])

  // ---- gestures
  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!open || (e.pointerType === "mouse" && e.button !== 0)) return
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      sheetY0: y.current,
      mode: null,
      fromBody: !!body.current?.contains(e.target as Node),
      samples: [{ y: e.clientY, t: e.timeStamp }],
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (!d.mode) {
      if (Math.hypot(dx, dy) < LOCK_PX) return
      if (Math.abs(dx) > Math.abs(dy)) {
        // horizontal: switch location (touch/pen only; a mouse selecting text shouldn't)
        if (e.pointerType === "mouse") return void (drag.current = null)
        d.mode = "h"
      } else {
        // vertical: the panel scrolls natively on desktop, and so does the body at full
        if (desktop || (d.fromBody && snap === "full")) return void (drag.current = null)
        d.mode = "v"
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    }
    if (d.mode === "v") {
      const m = metrics()
      // follow the finger, with a little resistance above full
      const raw = d.sheetY0 + dy
      setY(raw < m.full ? m.full + (raw - m.full) * 0.3 : Math.min(raw, m.closed), false)
      d.samples.push({ y: e.clientY, t: e.timeStamp })
      if (d.samples.length > 6) d.samples.shift()
    }
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || e.pointerId !== d.id || !d.mode) return
    if (d.mode === "h") {
      const dx = e.clientX - d.x0
      if (Math.abs(dx) > SWIPE_PX) onStep(dx < 0 ? 1 : -1) // swipe left = next
      return
    }
    // flick: project the release velocity forward, then take the nearest snap
    const first = d.samples[0]
    const lastS = d.samples[d.samples.length - 1]
    const v = lastS.t > first.t ? (lastS.y - first.y) / (lastS.t - first.t) : 0 // px per ms, + = down
    const m = metrics()
    const projected = y.current + v * FLICK_MS
    if (snap === "peek" && projected > m.peek + CLOSE_PX) {
      onClose()
      return
    }
    const snaps: Snap[] = ["full", "half", "peek"]
    goTo(snaps.reduce((best, s) => (Math.abs(m[s] - projected) < Math.abs(m[best] - projected) ? s : best)))
  }

  const onPointerCancel = () => {
    const d = drag.current
    drag.current = null
    if (d?.mode === "v") goTo(snap)
  }

  const titleId = shown ? `poi-sheet-${shown.id}` : undefined
  const iconBtn =
    "grid h-11 w-11 shrink-0 place-items-center rounded-full text-xl text-[#3f1d0e] hover:bg-[#e5d2b3] focus-visible:outline-2 focus-visible:outline-[#3f1d0e]"

  return (
    <section
      ref={sheet}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      inert={!open}
      data-open={open || undefined}
      data-desktop={desktop || undefined}
      data-snap={desktop ? undefined : snap}
      className="poi-sheet"
      style={desktop ? { width: SHEET.panelPx } : { height: `${SHEET.full * 100}dvh` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      {shown && (
        <>
          <header className="poi-sheet-head px-5 pb-3 pt-2">
            {!desktop && <div aria-hidden className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-[#9b8066]/60" />}
            <div className="flex items-start gap-1">
              <div className="min-w-0 flex-1 pt-1">
                <h2 ref={title} id={titleId} tabIndex={-1} className="truncate text-xl font-bold outline-none">
                  {shown.name}
                </h2>
                <p className="mt-0.5 text-xs font-semibold uppercase tracking-wider text-[#9b8066]">
                  {KIND_LABEL[shown.kind]}
                </p>
                <p className="mt-1 truncate">{shown.blurb}</p>
              </div>
              <button className={iconBtn} aria-label="Previous location" onClick={() => onStep(-1)}>
                ‹
              </button>
              <button className={iconBtn} aria-label="Next location" onClick={() => onStep(1)}>
                ›
              </button>
              <button className={iconBtn} aria-label="Close" onClick={onClose}>
                ×
              </button>
            </div>
          </header>
          <div ref={body} className="poi-sheet-body px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            <p className="leading-relaxed">{shown.lore}</p>
            <h3 className="mt-5 text-sm font-bold uppercase tracking-wider text-[#9b8066]">Chapters</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {shown.chapters.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
            <Link
              href={`/story/${shown.storyId}`}
              className="mt-5 inline-block rounded bg-[#3f1d0e] px-4 py-2.5 font-semibold text-[#f4efcf]"
            >
              Read story
            </Link>
            {shown.characters && shown.characters.length > 0 && (
              <>
                <h3 className="mt-6 text-sm font-bold uppercase tracking-wider text-[#9b8066]">Characters</h3>
                <ul className="mt-2 space-y-1">
                  {shown.characters.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
