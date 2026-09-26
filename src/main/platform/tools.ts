import { existsSync } from 'node:fs'
import path from 'node:path'

/** Resolved locations of external tools and app directories. */
export interface ToolPaths {
  /** App data directory (Electron userData, or LMS_USER_DATA_DIR in dev). */
  userData: string
  /** Directory holding bundled resources/bin contents. */
  resourcesBin: string
  /** Electron binary used as a Node runtime (with ELECTRON_RUN_AS_NODE=1). */
  nodeRuntime: string
  ffmpeg: string
  rclone: string
}

export interface ResolveToolOptions {
  userData: string
  isPackaged: boolean
  resourcesPath: string
  appPath: string
  execPath: string
  ffmpegStaticPath: string | null
  platform?: NodeJS.Platform
}

export function resolveToolPaths(options: ResolveToolOptions): ToolPaths {
  const resourcesBin = options.isPackaged
    ? path.join(options.resourcesPath, 'bin')
    : path.join(options.appPath, 'resources', 'bin')
  const exe = (options.platform ?? process.platform) === 'win32' ? '.exe' : ''
  const bundledRclone = path.join(resourcesBin, `rclone${exe}`)
  const ffmpeg = options.ffmpegStaticPath
    ? options.isPackaged
      ? options.ffmpegStaticPath.replace('app.asar', 'app.asar.unpacked')
      : options.ffmpegStaticPath
    : 'ffmpeg'
  return {
    userData: options.userData,
    resourcesBin,
    nodeRuntime: options.execPath,
    ffmpeg,
    rclone: existsSync(bundledRclone) ? bundledRclone : `rclone${exe}`,
  }
}
