import type { RendererApi } from '../shared/ipc'

declare global {
  interface Window {
    lms: RendererApi
  }
}
