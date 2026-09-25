"use client"
import { useMediaQuery } from "./useMediaQuery"

// false on the server so hydration matches, then the real value on the client
export function useReducedMotion() {
  return useMediaQuery("(prefers-reduced-motion: reduce)")
}
