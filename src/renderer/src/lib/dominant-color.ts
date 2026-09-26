import { useEffect, useState } from 'react'

/** Average colour of an image (for artwork-tinted headers). */
export function useDominantColor(src: string | null): string | null {
  const [color, setColor] = useState<string | null>(null)
  useEffect(() => {
    setColor(null)
    if (!src) return
    let cancelled = false
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      if (cancelled) return
      try {
        const canvas = document.createElement('canvas')
        canvas.width = 16
        canvas.height = 16
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(image, 0, 0, 16, 16)
        const { data } = context.getImageData(0, 0, 16, 16)
        let r = 0
        let g = 0
        let b = 0
        let weight = 0
        for (let i = 0; i < data.length; i += 4) {
          const max = Math.max(data[i], data[i + 1], data[i + 2])
          const min = Math.min(data[i], data[i + 1], data[i + 2])
          // Favour saturated pixels so greys don't wash the tint out.
          const w = 1 + (max - min) / 32
          r += data[i] * w
          g += data[i + 1] * w
          b += data[i + 2] * w
          weight += w
        }
        setColor(
          `${Math.round(r / weight)}, ${Math.round(g / weight)}, ${Math.round(b / weight)}`
        )
      } catch {
        setColor(null)
      }
    }
    image.src = src
    return () => {
      cancelled = true
    }
  }, [src])
  return color
}
