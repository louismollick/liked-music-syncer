import type { CatalogAccount } from '../types'
import { at, firstRun, nav, thumbnail, walk } from './nav'

export function parseAccount(response: unknown): CatalogAccount | null {
  let header: unknown
  walk(response, (node) => {
    if (!header && node.activeAccountHeaderRenderer)
      header = node.activeAccountHeaderRenderer
  })
  if (!header) return null
  const name = firstRun(nav(header, ['accountName']))
  if (!name) return null
  let channelId: string | null = null
  walk(response, (node) => {
    const id = at(node, ['browseEndpoint', 'browseId'])
    if (!channelId && id?.startsWith('UC')) channelId = id
  })
  return {
    name,
    handle: firstRun(nav(header, ['channelHandle'])),
    channelId,
    photoUrl: thumbnail(nav(header, ['accountPhoto'])),
  }
}
