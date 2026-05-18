import { ElectronAPI } from '@electron-toolkit/preload'
import type { ElectronApi } from '@shared/contracts'

declare global {
  interface Window {
    electron: ElectronAPI
    api: ElectronApi
  }
}
