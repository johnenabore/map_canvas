import { useSyncExternalStore } from "react"
import DATA from "@/data/discoveries.json"
import { DISCOVER } from "@/lib/map"
import type { DiscoveryKind } from "./discoveryArt"

// a deep-zoom discovery (data/discoveries.json): x/y = centre of the art, % of the map
export type Discovery = {
  id: string
  kind: DiscoveryKind
  x: number
  y: number
  rotation: number // degrees
  scale: number    // x DISCOVER.size
  flip: boolean    // mirror horizontally
  name: string
  lore: string     // one line, shown on the card
}
export const DISCOVERIES = DATA as Discovery[]

// Two small stores shared by the discovery layer, the card and the counter chip; both change only when
// someone taps a discovery (never per frame). Found ids persist in localStorage, and other tabs stay in step.
export type OpenCard = {
  id: string
  first: boolean    // found just now: the card gets the ink stamp and the counter bumps
  keyboard: boolean // opened from the keyboard: the card doesn't time out
  seq: number       // new on every open, so the card restarts its timer and animations
}

const NONE: readonly string[] = []
let found: readonly string[] | null = null // read lazily, after hydration
let open: OpenCard | null = null
let seq = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

const onStorage = (e: StorageEvent) => {
  if (e.key !== DISCOVER.storageKey && e.key !== null) return
  found = null
  emit()
}
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  if (listeners.size === 1) window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) window.removeEventListener("storage", onStorage)
  }
}

function readFound(): readonly string[] {
  if (found) return found
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DISCOVER.storageKey) ?? "[]")
    found = Array.isArray(raw) ? DISCOVERIES.filter((d) => raw.includes(d.id)).map((d) => d.id) : []
  } catch {
    found = [] // storage blocked or garbled: start fresh
  }
  return found
}

export const useFound = () => useSyncExternalStore(subscribe, readFound, () => NONE)
export const getOpenDiscovery = () => open
export const useOpenDiscovery = () => useSyncExternalStore(subscribe, getOpenDiscovery, () => null)

export function openDiscovery(id: string, keyboard: boolean) {
  const list = readFound()
  const first = !list.includes(id)
  if (first) {
    found = [...list, id]
    try {
      localStorage.setItem(DISCOVER.storageKey, JSON.stringify(found))
    } catch {
      // storage blocked: remembered for this visit only
    }
  }
  open = { id, first, keyboard, seq: ++seq }
  emit()
}

export function closeDiscovery() {
  if (!open) return
  open = null
  emit()
}
