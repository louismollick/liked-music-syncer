import { electronAPI } from '@electron-toolkit/preload'
import type { ElectronApi } from '@shared/contracts'
import { contextBridge, ipcRenderer } from 'electron'

const api: ElectronApi = {
  auth: {
    getSnapshot: () => ipcRenderer.invoke('auth:getSnapshot'),
    refresh: (scope, reason) =>
      ipcRenderer.invoke('auth:refresh', scope, reason),
    selectSource: (sourceId) =>
      ipcRenderer.invoke('auth:selectSource', sourceId),
    selectAccount: (accountKey) =>
      ipcRenderer.invoke('auth:selectAccount', accountKey),
    loadAccountCounts: () => ipcRenderer.invoke('auth:loadAccountCounts'),
    openSignIn: () => ipcRenderer.invoke('auth:openSignIn'),
    subscribe: (listener) => {
      const wrapped = (
        _event: unknown,
        snapshot: Parameters<typeof listener>[0]
      ) => listener(snapshot)
      ipcRenderer.on('auth:snapshot', wrapped)
      return () => ipcRenderer.removeListener('auth:snapshot', wrapped)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (input) => ipcRenderer.invoke('settings:update', input),
    testBinaries: () => ipcRenderer.invoke('settings:testBinaries'),
    testRemote: () => ipcRenderer.invoke('settings:testRemote'),
    pickOutputDirectory: () =>
      ipcRenderer.invoke('settings:pickOutputDirectory'),
  },
  sync: {
    startLikedSongsSync: () => ipcRenderer.invoke('sync:startLikedSongsSync'),
    startLibraryReprocess: () =>
      ipcRenderer.invoke('sync:startLibraryReprocess'),
    reprocessArtists: (artistIds) =>
      ipcRenderer.invoke('sync:reprocessArtists', artistIds),
    refreshFavoriteArtists: (artistIds) =>
      ipcRenderer.invoke('sync:refreshFavoriteArtists', artistIds),
    retryFailedTracks: (jobId) =>
      ipcRenderer.invoke('sync:retryFailedTracks', jobId),
    clearFailures: () => ipcRenderer.invoke('sync:clearFailures'),
    cancel: (jobId) => ipcRenderer.invoke('sync:cancel', jobId),
    clearSyncData: () => ipcRenderer.invoke('sync:clearSyncData'),
    syncMissingToRemote: () => ipcRenderer.invoke('sync:syncMissingToRemote'),
    doctor: () => ipcRenderer.invoke('sync:doctor'),
    getSnapshot: () => ipcRenderer.invoke('sync:getSnapshot'),
    subscribe: (listener) => {
      const wrapped = (_event: unknown, snapshot: unknown) => {
        listener(snapshot as Parameters<typeof listener>[0])
      }
      ipcRenderer.on('sync:snapshot', wrapped)
      return () => {
        ipcRenderer.removeListener('sync:snapshot', wrapped)
      }
    },
  },
  library: {
    refreshIndex: () => ipcRenderer.invoke('library:refreshIndex'),
    refreshArtists: () => ipcRenderer.invoke('library:refreshArtists'),
    listArtists: () => ipcRenderer.invoke('library:listArtists'),
    refreshArtistImages: () =>
      ipcRenderer.invoke('library:refreshArtistImages'),
    clearArtistImageCache: () =>
      ipcRenderer.invoke('library:clearArtistImageCache'),
    subscribeArtists: (listener) => {
      const wrapped = () => {
        listener()
      }
      ipcRenderer.on('library:artistsUpdated', wrapped)
      return () => {
        ipcRenderer.removeListener('library:artistsUpdated', wrapped)
      }
    },
    subscribeArtistPhotos: (listener) => {
      const wrapped = (_event: unknown, update: unknown) => {
        listener(update as Parameters<typeof listener>[0])
      }
      ipcRenderer.on('library:artistPhotoUpdated', wrapped)
      return () => {
        ipcRenderer.removeListener('library:artistPhotoUpdated', wrapped)
      }
    },
    subscribeAlbumArtwork: (listener) => {
      const wrapped = (_event: unknown, update: unknown) => {
        listener(update as Parameters<typeof listener>[0])
      }
      ipcRenderer.on('library:albumArtworkUpdated', wrapped)
      return () => {
        ipcRenderer.removeListener('library:albumArtworkUpdated', wrapped)
      }
    },
    subscribeInventory: (listener) => {
      const wrapped = () => {
        listener()
      }
      ipcRenderer.on('library:inventoryUpdated', wrapped)
      return () => {
        ipcRenderer.removeListener('library:inventoryUpdated', wrapped)
      }
    },
    setArtistFavorite: (artistId, isFavorite) =>
      ipcRenderer.invoke('library:setArtistFavorite', artistId, isFavorite),
    listTracks: (filter) => ipcRenderer.invoke('library:listTracks', filter),
    getTrack: (trackId) => ipcRenderer.invoke('library:getTrack', trackId),
    getDriftSummary: () => ipcRenderer.invoke('library:getDriftSummary'),
    listRoots: () => ipcRenderer.invoke('library:listRoots'),
    getAlbumArtwork: (albumKeys) =>
      ipcRenderer.invoke('library:getAlbumArtwork', albumKeys),
  },
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error preload fallback assignment
  window.electron = electronAPI
  // @ts-expect-error preload fallback assignment
  window.api = api
}
