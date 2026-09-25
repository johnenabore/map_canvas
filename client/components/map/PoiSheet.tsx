"use client"
import Link from "next/link"
import type { POI } from "@/lib/map"

export default function PoiSheet({ poi, onClose }: { poi: POI | null; onClose: () => void }) {
  return (
    <div
      className={`fixed inset-x-0 bottom-0 z-10 rounded-t-2xl bg-[#f4efcf] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-[#3f1d0e] shadow-2xl transition-transform duration-300 motion-reduce:transition-none ${
        poi ? "translate-y-0" : "translate-y-full"
      }`}
    >
      {poi && (
        <>
          <h2 className="text-xl font-bold">{poi.name}</h2>
          <p className="mt-1">{poi.blurb}</p>
          <div className="mt-4 flex gap-2">
            <Link href={`/story/${poi.storyId}`} className="rounded bg-[#3f1d0e] px-4 py-2 text-[#f4efcf]">
              Read story
            </Link>
            <button onClick={onClose} className="px-4 py-2">Close</button>
          </div>
        </>
      )}
    </div>
  )
}