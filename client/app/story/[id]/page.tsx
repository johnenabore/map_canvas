import Link from "next/link"

export default async function Story({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <main className="p-6">
      <h1 className="text-2xl font-bold">Story {id}</h1>
      <Link href="/map" className="underline">Back to map</Link>
    </main>
  )
}