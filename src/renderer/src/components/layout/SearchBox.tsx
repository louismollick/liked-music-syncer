import { Search } from 'lucide-react'
import { useAppState } from '../../lib/app-state'

/** Small search box in the top-right corner; opens the command palette. */
export function SearchBox() {
  const { setPaletteOpen } = useAppState()
  return (
    <button
      type="button"
      onClick={() => setPaletteOpen(true)}
      className="absolute top-4 right-5 z-30 h-7 w-44 rounded-md border border-line bg-side/80 backdrop-blur flex items-center gap-2 px-2 text-[12px] text-zinc-500 hover:text-zinc-300 hover:border-white/20 no-drag"
    >
      <Search className="w-3.5 h-3.5" strokeWidth={2} />
      Search
      <span className="ml-auto text-[10px] text-zinc-600">⌘K</span>
    </button>
  )
}
