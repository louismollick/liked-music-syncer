import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>()
)

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    ),
  },
}))

import { registerIpcHandlers } from '../src/main/ipc'

describe('artist favorite IPC', () => {
  beforeEach(() => {
    handlers.clear()
  })

  it('notifies the renderer after a favorite change is saved', async () => {
    const send = vi.fn()
    const setArtistFavorite = vi.fn().mockResolvedValue({
      ok: true,
      message: 'Artist saved as favorite.',
    })
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { send },
    }

    registerIpcHandlers(
      window as never,
      {} as never,
      {} as never,
      {} as never,
      { subscribe: vi.fn() } as never,
      { subscribeInventory: vi.fn() } as never,
      {
        subscribeArtistPhotoUpdates: vi.fn(),
        setArtistFavorite,
      } as never,
      {} as never,
      () => ''
    )

    const handler = handlers.get('library:setArtistFavorite')
    expect(handler).toBeDefined()

    await handler?.({}, 'artist-1', true)

    expect(setArtistFavorite).toHaveBeenCalledWith('artist-1', true)
    expect(send).toHaveBeenCalledWith('library:artistsUpdated')
    expect(setArtistFavorite.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]
    )
  })

  it('does not refresh the renderer when saving fails', async () => {
    const send = vi.fn()
    const window = {
      isDestroyed: () => false,
      once: vi.fn(),
      webContents: { send },
    }

    registerIpcHandlers(
      window as never,
      {} as never,
      {} as never,
      {} as never,
      { subscribe: vi.fn() } as never,
      { subscribeInventory: vi.fn() } as never,
      {
        subscribeArtistPhotoUpdates: vi.fn(),
        setArtistFavorite: vi.fn().mockResolvedValue({
          ok: false,
          message: 'Artist not found.',
        }),
      } as never,
      {} as never,
      () => ''
    )

    await handlers.get('library:setArtistFavorite')?.({}, 'missing', true)

    expect(send).not.toHaveBeenCalledWith('library:artistsUpdated')
  })
})
