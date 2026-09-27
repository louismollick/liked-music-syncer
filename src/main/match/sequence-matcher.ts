/** Python difflib.SequenceMatcher's matching blocks and ratio, including autojunk. */
export function sequenceMatcherRatio(left: string, right: string): number {
  const a = Array.from(left)
  const b = Array.from(right)
  if (a.length + b.length === 0) return 1
  const b2j = new Map<string, number[]>()
  for (let j = 0; j < b.length; j++) {
    const indexes = b2j.get(b[j]) ?? []
    indexes.push(j)
    b2j.set(b[j], indexes)
  }
  if (b.length >= 200) {
    const popular = Math.floor(b.length / 100) + 1
    for (const [element, indexes] of b2j) {
      if (indexes.length > popular) b2j.delete(element)
    }
  }
  type Block = { a: number; b: number; size: number }
  function longest(alo: number, ahi: number, blo: number, bhi: number): Block {
    let besti = alo
    let bestj = blo
    let bestsize = 0
    let j2len = new Map<number, number>()
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>()
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) ?? 0) + 1
        newj2len.set(j, k)
        if (k > bestsize) {
          besti = i - k + 1
          bestj = j - k + 1
          bestsize = k
        }
      }
      j2len = newj2len
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--
      bestj--
      bestsize++
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    )
      bestsize++
    return { a: besti, b: bestj, size: bestsize }
  }
  const pending: [number, number, number, number][] = [
    [0, a.length, 0, b.length],
  ]
  const blocks: Block[] = []
  while (pending.length) {
    const [alo, ahi, blo, bhi] = pending.pop()!
    const match = longest(alo, ahi, blo, bhi)
    if (!match.size) continue
    blocks.push(match)
    if (alo < match.a && blo < match.b)
      pending.push([alo, match.a, blo, match.b])
    if (match.a + match.size < ahi && match.b + match.size < bhi)
      pending.push([match.a + match.size, ahi, match.b + match.size, bhi])
  }
  blocks.sort((x, y) => x.a - y.a || x.b - y.b)
  let matches = 0
  let previous: Block | null = null
  for (const block of blocks) {
    if (
      previous &&
      previous.a + previous.size === block.a &&
      previous.b + previous.size === block.b
    ) {
      previous.size += block.size
    } else {
      if (previous) matches += previous.size
      previous = { ...block }
    }
  }
  if (previous) matches += previous.size
  return (2 * matches) / (a.length + b.length)
}
