"use client"
import { useSyncExternalStore } from "react"

// iOS 13+ adds a static requestPermission() that isn't in the DOM typings
type OrientationEventCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> }

// Motion permission for the depth tilt, shared by Tilt (which listens for orientation events) and
// Controls (which shows the "Enable motion" button). Changes a handful of times per page, never per frame.
export type TiltPermission =
  | "unknown"    // not determined, or tilt is off (reduced motion, ?atmos=0): no button
  | "not-needed" // no permission API (Android, desktop): no button
  | "prompt"     // iOS, not granted yet: show "Enable motion"
  | "granted"
  | "denied"     // declined now or before (remembered in localStorage): don't ask again

const STORAGE_KEY = "protheka-motion"
let permission: TiltPermission = "unknown"
let lastError = ""
const listeners = new Set<() => void>()

export function setTiltPermission(p: TiltPermission) {
  if (p === permission) return
  permission = p
  listeners.forEach((l) => l())
}
export const getTiltPermission = () => permission
export const tiltPermissionError = () => lastError
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export function useTiltPermission() {
  return useSyncExternalStore(subscribe, getTiltPermission, () => "unknown" as const)
}

export const needsMotionPermission = () =>
  typeof (window.DeviceOrientationEvent as OrientationEventCtor | undefined)?.requestPermission === "function"

export function storedMotionChoice(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ""
  } catch {
    return "" // storage blocked
  }
}

// Call straight from a click handler. iOS only shows the prompt while the tap's user activation is live,
// so requestPermission() runs first, synchronously, with nothing awaited before it.
export function requestMotionPermission() {
  const Ctor = window.DeviceOrientationEvent as OrientationEventCtor | undefined
  const request = Ctor?.requestPermission?.()
  if (!request) return
  request.then(
    (state) => {
      try {
        localStorage.setItem(STORAGE_KEY, state)
      } catch {
        // storage blocked: we just won't remember it
      }
      setTiltPermission(state === "granted" ? "granted" : "denied")
    },
    (err: unknown) => {
      // e.g. NotAllowedError (no user activation): keep the button so it can be tried again
      lastError = String(err)
      setTiltPermission("prompt")
    },
  )
}
