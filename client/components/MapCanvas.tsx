"use client";

import { TransformWrapper, TransformComponent } from "react-zoom-pan-pinch";

// SVG viewBox is 903 x 672.75 -> keep that aspect ratio
const MAP_W = 903;
const MAP_H = 672.75;

export default function MapCanvas() {
  return (
    <div className="relative h-[80vh] w-full overflow-hidden rounded-lg border-4 border-[#3f1d0e] bg-[#412511]">
      <TransformWrapper
        initialScale={1}
        minScale={1}          // can't zoom out past "fit"
        maxScale={6}
        centerOnInit
        limitToBounds         // can't drag the map off-screen
        wheel={{ step: 0.15 }}
        doubleClick={{ mode: "zoomIn", step: 0.7 }}
        panning={{ velocityDisabled: false }} // inertia/glide after drag
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <TransformComponent
              wrapperStyle={{ width: "100%", height: "100%" }}
              contentStyle={{ width: "100%", height: "100%" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/maps/protheka.svg"
                alt="Map of Protheka"
                width={MAP_W}
                height={MAP_H}
                draggable={false}
                className="h-full w-full select-none object-contain cursor-grab active:cursor-grabbing"
              />

              {/* Optional: pins that move/scale with the map.
                  Position as % of the map so they stay locked in place. */}
              {/* <button
                className="absolute -translate-x-1/2 -translate-y-full"
                style={{ left: "42%", top: "37%" }}
                onClick={() => console.log("clicked city")}
              >📍</button> */}
            </TransformComponent>

            <div className="absolute right-3 bottom-3 flex flex-col gap-1">
              {[
                { label: "+", aria: "Zoom in", fn: () => zoomIn() },
                { label: "−", aria: "Zoom out", fn: () => zoomOut() },
                { label: "⟲", aria: "Reset view", fn: () => resetTransform() },
              ].map((b) => (
                <button
                  key={b.aria}
                  aria-label={b.aria}
                  onClick={b.fn}
                  className="h-9 w-9 rounded border-2 border-[#3f1d0e] bg-[#e5d2b3] text-lg font-bold text-[#3f1d0e] hover:bg-[#f4efcf] focus-visible:outline-2 focus-visible:outline-[#f4efcf]"
                >
                  {b.label}
                </button>
              ))}
            </div>
          </>
        )}
      </TransformWrapper>
    </div>
  );
}