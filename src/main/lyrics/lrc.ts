const timestamp = /^\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/
const metadata = /^\[[A-Za-z]{2,3}:[^\]]*\]$/

export function formatLrcLine(startMs: number, text: string): string {
  const minutes = Math.floor(startMs / 60000)
  const seconds = (startMs % 60000) / 1000
  let formatted = seconds.toFixed(2)
  // Python's float formatting uses half-even for exactly representable ties.
  if (Number.isInteger(seconds * 8) && (seconds * 100) % 1 === 0.5) {
    const lower = Math.floor(seconds * 100)
    formatted = ((lower + (lower % 2)) / 100).toFixed(2)
  }
  return `[${String(minutes).padStart(2, '0')}:${formatted.padStart(5, '0')}]${text}`
}

function timestampSeconds(token: string): number | null {
  const match = timestamp.exec(token)
  if (!match) return null
  const fraction = match[3] ?? ''
  return (
    Number(match[1]) * 60 +
    Number(match[2]) +
    (fraction ? Number(fraction) / 10 ** fraction.length : 0)
  )
}

export function isZeroTimestampOnlyLrc(text: string): boolean {
  const times: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    while (line.startsWith('[')) {
      const close = line.indexOf(']')
      if (close < 0) break
      const seconds = timestampSeconds(line.slice(0, close + 1))
      if (seconds === null) break
      times.push(seconds)
      line = line.slice(close + 1)
    }
  }
  return times.length > 0 && times.every((seconds) => seconds === 0)
}

export function stripLrc(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !metadata.test(line.trim()))
    .map((raw) => {
      let line = raw.trim()
      while (timestamp.test(line))
        line = line.replace(timestamp, '').trimStart()
      return line
    })
    .join('\n')
    .trim()
}
