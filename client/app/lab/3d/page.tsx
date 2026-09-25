import type { Metadata } from "next"
import Lab3D from "@/components/lab3d/Lab3D"

export const metadata: Metadata = { title: "Protheka 3D (lab)" }

// isolated 3D spike of the map; see components/lab3d/Scene.tsx (tunables in LAB3D at the top)
export default function Lab3DPage() {
  return <Lab3D />
}
