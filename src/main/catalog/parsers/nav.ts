import { CatalogShapeError } from '../types'

export type Json = Record<string, unknown>
export type Path = readonly (string | number)[]

export function object(value: unknown): Json | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null
}

export function array(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null
}

export function nav(value: unknown, path: Path): unknown {
  let current = value
  for (const key of path) {
    current =
      typeof key === 'number' ? array(current)?.[key] : object(current)?.[key]
    if (current === undefined) return undefined
  }
  return current
}

export function requiredObject(
  value: unknown,
  path: Path,
  label: string
): Json {
  const found = object(nav(value, path))
  if (!found) throw new CatalogShapeError(`Missing ${label}`)
  return found
}

export function requiredArray(
  value: unknown,
  path: Path,
  label: string
): unknown[] {
  const found = array(nav(value, path))
  if (!found) throw new CatalogShapeError(`Missing ${label}`)
  return found
}

export function string(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null
}

export function at(value: unknown, path: Path): string | null {
  return string(nav(value, path))
}

export function text(value: unknown): string | null {
  const simple = at(value, ['simpleText'])
  if (simple) return simple
  const runs = array(nav(value, ['runs']))
  return runs
    ? runs.map((run) => at(run, ['text']) ?? '').join('') || null
    : null
}

export function firstRun(value: unknown): string | null {
  return at(value, ['runs', 0, 'text']) ?? at(value, ['simpleText'])
}

export function thumbnail(value: unknown): string | null {
  const candidates = [
    ['musicThumbnailRenderer', 'thumbnail', 'thumbnails'],
    ['thumbnail', 'thumbnails'],
    ['thumbnails'],
  ] as const
  for (const path of candidates) {
    const images = array(nav(value, path))
    if (images?.length) return at(images[images.length - 1], ['url'])
  }
  return null
}

export function duration(value: string | null): number | null {
  if (!value || !/^\d+(?::\d+)+$/.test(value)) return null
  return value
    .split(':')
    .reduce((seconds, part) => seconds * 60 + Number(part), 0)
}

export function year(value: string | null): number | null {
  return value && /^\d{4}$/.test(value) ? Number(value) : null
}

export function walk(value: unknown, visit: (node: Json) => void): void {
  const seen = new Set<object>()
  const traverse = (current: unknown): void => {
    if (current === null || typeof current !== 'object' || seen.has(current))
      return
    seen.add(current)
    if (Array.isArray(current)) {
      for (const item of current) traverse(item)
    } else {
      const node = current as Json
      visit(node)
      for (const item of Object.values(node)) traverse(item)
    }
  }
  traverse(value)
}
