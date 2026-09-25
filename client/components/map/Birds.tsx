"use client"
import { useEffect, useRef, useState, type RefObject } from "react"
import { AMBIENT } from "@/lib/map"
import { useReducedMotion } from "@/lib/useReducedMotion"
import type { IntroLink } from "./Intro"

type Bird = { x: number; y: number; size: number; flap: number; delay: number }
type Flock = {
  id: number
  top: number     // % of the map
  tilt: number    // deg
  dir: 1 | -1     // 1 = left -> right
  arc: 1 | 2 | 3  // which y-track keyframes
  seconds: number // crossing time
  delay: number   // s before it sets off (the second flock of a pair trails a little)
  birds: Bird[]
}

const UPPER: [number, number] = [12, 40] // flock heights (top %), one flock in each band
const LOWER: [number, number] = [45, 72]

const rand = (a: number, b: number) => a + Math.random() * (b - a)

// one flock: a loose V (leader in front, the rest trailing back to alternating sides), jittered
function makeFlock(id: number, dir: 1 | -1, band: [number, number], delay: number, baseSeconds: number): Flock {
  const n = Math.round(rand(AMBIENT.birds.count[0], AMBIENT.birds.count[1]))
  const birds = Array.from({ length: n }, (_, i) => {
    const rank = Math.ceil(i / 2)
    const side = i % 2 ? -1 : 1
    return {
      x: 72 - rank * 17 + rand(-5, 5),
      y: 42 + side * rank * 13 + rand(-6, 6),
      size: rand(0.8, 1.1),
      flap: rand(0.45, 0.7),
      delay: -rand(0, 0.7),
    }
  })
  return {
    id,
    top: rand(band[0], band[1]),
    tilt: rand(-6, 6),
    dir,
    arc: (1 + Math.floor(Math.random() * 3)) as 1 | 2 | 3,
    seconds: baseSeconds * rand(0.9, 1.1), // ±10% so they don't pass exactly mid-map
    delay,
    birds,
  }
}

// a departure = two flocks crossing paths: opposite directions, one high and one low
function makeDeparture(nextId: () => number): Flock[] {
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1
  const upperFirst = Math.random() < 0.5
  const base = rand(AMBIENT.birds.flightS[0], AMBIENT.birds.flightS[1])
  return [
    makeFlock(nextId(), dir, upperFirst ? UPPER : LOWER, 0, base),
    makeFlock(nextId(), dir === 1 ? -1 : 1, upperFirst ? LOWER : UPPER, rand(0, 1.5), base),
  ]
}

// ink gull silhouette (the body is at 50% / 65%, the flap's transform-origin)
function BirdShape() {
  return (
    <svg viewBox="0 0 24 10" className="block h-full w-full" aria-hidden>
      <path d="M0 5.5C3 1.5 7 1 12 5.2C17 1 21 1.5 24 5.5C20.5 3.6 16.5 4 12 8C7.5 4 3.5 3.6 0 5.5Z" fill="#3f1d0e" />
    </svg>
  )
}

// Every ~AMBIENT.birds.everyS two flocks cross the map in opposite directions, in map space (they move
// with the map), above the cloud shadows and below the pins; the screen-space clouds stay above them.
// Each flock is mounted for its flight and removed from the DOM when its own crossing ends. The path
// is two nested full-map tracks: x crosses linearly, y arcs with ease-in-out, so together they trace
// a smooth curve; both are transform-only compositor animations, and each bird flaps with its own
// scaleY loop (an HTML wrapper, not an SVG child, so the flap is composited too). React state changes
// only when a departure launches or a flock finishes, never per frame.
export default function Birds({ introRef }: { introRef: RefObject<IntroLink> }) {
  const reduced = useReducedMotion()
  const [flocks, setFlocks] = useState<Flock[]>([])
  const ids = useRef(0)

  useEffect(() => {
    if (reduced) return
    let timer = 0
    const wait = () => {
      timer = window.setTimeout(depart, rand(AMBIENT.birds.everyS[0], AMBIENT.birds.everyS[1]) * 1000)
    }
    const depart = () => {
      // never during the intro and not into a hidden tab: look again shortly
      if (introRef.current.playing || document.hidden) {
        timer = window.setTimeout(depart, 2000)
        return
      }
      const pair = makeDeparture(() => ++ids.current)
      // skip the departure if earlier flocks are still up (e.g. paused while the user keeps panning)
      setFlocks((f) => (f.length + pair.length > AMBIENT.birds.maxFlocks ? f : [...f, ...pair]))
      wait()
    }
    wait()
    return () => clearTimeout(timer)
  }, [reduced, introRef])

  if (flocks.length === 0) return null
  return (
    <div aria-hidden className="layer atmos-birds">
      {flocks.map((f) => {
        const timing = { animationDuration: `${f.seconds.toFixed(2)}s`, animationDelay: `${f.delay.toFixed(2)}s` }
        return (
          // static: tilt + direction (mirroring also turns the birds to face the way they fly)
          <div key={f.id} className="atmos-birds-track" style={{ transform: `rotate(${f.tilt.toFixed(1)}deg) scaleX(${f.dir})` }}>
            <div
              className="atmos-birds-track atmos-birds-x"
              style={timing}
              onAnimationEnd={(e) => {
                if (e.target === e.currentTarget) setFlocks((all) => all.filter((x) => x.id !== f.id))
              }}
            >
              <div className={`atmos-birds-track atmos-birds-y atmos-birds-arc-${f.arc}`} style={timing}>
                <div className="atmos-flock" style={{ top: `${f.top.toFixed(1)}%` }}>
                  {f.birds.map((b, i) => (
                    <div
                      key={i}
                      className="atmos-bird"
                      style={{
                        left: `${b.x.toFixed(1)}%`,
                        top: `${b.y.toFixed(1)}%`,
                        width: `${(16 * b.size).toFixed(1)}%`,
                        animationDuration: `${b.flap.toFixed(2)}s`,
                        animationDelay: `${b.delay.toFixed(2)}s`,
                      }}
                    >
                      <BirdShape />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
