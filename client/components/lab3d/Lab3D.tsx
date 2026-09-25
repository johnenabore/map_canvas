"use client"
import dynamic from "next/dynamic"

// three.js needs the browser: the whole scene is client-only and loads as its own chunk
const Scene = dynamic(() => import("./Scene"), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 grid place-items-center bg-[#412511] font-serif text-[#e5d2b3]">Loading the map…</div>
  ),
})

export default function Lab3D() {
  return <Scene />
}
