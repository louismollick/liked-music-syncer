import { useLayoutEffect, useState } from 'react'

/** Distance from the top of the scroll container to `target`, for virtualizer scrollMargin. */
export function useScrollMargin(
  target: React.RefObject<HTMLElement | null>,
  container: React.RefObject<HTMLElement | null>,
  key: unknown = null
): number {
  const [margin, setMargin] = useState(0)
  useLayoutEffect(() => {
    void key
    const update = () => {
      if (!target.current || !container.current) return
      const t = target.current.getBoundingClientRect().top
      const c = container.current.getBoundingClientRect().top
      setMargin(Math.round(t - c + container.current.scrollTop))
    }
    update()
    const observer = new ResizeObserver(update)
    if (container.current) observer.observe(container.current)
    if (target.current?.parentElement)
      observer.observe(target.current.parentElement)
    return () => observer.disconnect()
  }, [key, target, container])
  return margin
}
