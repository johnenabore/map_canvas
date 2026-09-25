import MapShell from "@/components/map/MapShell"

export default async function MapPage({
  searchParams,
}: { searchParams: Promise<{ poi?: string; atmos?: string }> }) {
  const { poi, atmos } = await searchParams
  // ?atmos=0 disables all atmosphere layers (perf A/B)
  return <MapShell focus={poi} atmos={atmos !== "0"} />
}
