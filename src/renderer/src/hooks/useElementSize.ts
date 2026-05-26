import { type RefObject, useEffect, useState } from 'react'

interface ElementSize {
  width: number
  height: number
}

const EMPTY_SIZE: ElementSize = {
  width: 0,
  height: 0,
}

export function useElementSize<T extends HTMLElement>(
  ref: RefObject<T | null>
): ElementSize {
  const [size, setSize] = useState<ElementSize>(EMPTY_SIZE)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const updateSize = () => {
      const nextWidth = element.clientWidth
      const nextHeight = element.clientHeight

      setSize((current) =>
        nextWidth === 0 &&
        nextHeight === 0 &&
        (current.width > 0 || current.height > 0)
          ? current
          : current.width === nextWidth && current.height === nextHeight
            ? current
            : {
                width: nextWidth,
                height: nextHeight,
              }
      )
    }

    updateSize()

    const observer = new ResizeObserver(() => {
      updateSize()
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [ref])

  return size
}
