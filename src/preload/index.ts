import { electronAPI } from '@electron-toolkit/preload'
import type { ElectronApi } from '@shared/contracts'
import { contextBridge, ipcRenderer } from 'electron'

const api: ElectronApi = {
  auth: {
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    captureBrowserAuth: (browser) =>
      ipcRenderer.invoke('auth:captureBrowserAuth', browser),
    disconnect: () => ipcRenderer.invoke('auth:disconnect'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (input) => ipcRenderer.invoke('settings:save', input),
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
    clearFailures: () => ipcRenderer.invoke('sync:clearFailures'),
    approveChanges: (approvalIds) =>
      ipcRenderer.invoke('sync:approveChanges', approvalIds),
    denyChanges: (approvalIds) =>
      ipcRenderer.invoke('sync:denyChanges', approvalIds),
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
    scanRoots: () => ipcRenderer.invoke('library:scanRoots'),
    getIndexStatus: () => ipcRenderer.invoke('library:getIndexStatus'),
    refreshIndex: () => ipcRenderer.invoke('library:refreshIndex'),
    refreshArtists: () => ipcRenderer.invoke('library:refreshArtists'),
    listArtists: () => ipcRenderer.invoke('library:listArtists'),
    refreshArtistImages: () =>
      ipcRenderer.invoke('library:refreshArtistImages'),
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
    subscribeIndexStatus: (listener) => {
      const wrapped = () => {
        listener()
      }
      ipcRenderer.on('library:indexStatusUpdated', wrapped)
      return () => {
        ipcRenderer.removeListener('library:indexStatusUpdated', wrapped)
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
