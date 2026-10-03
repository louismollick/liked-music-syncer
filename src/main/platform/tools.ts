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
  platform?: NodeJS.Platform
}

export function resolveToolPaths(options: ResolveToolOptions): ToolPaths {
  const resourcesBin = options.isPackaged
    ? path.join(options.resourcesPath, 'bin')
    : path.join(options.appPath, 'resources', 'bin')
  const exe = (options.platform ?? process.platform) === 'win32' ? '.exe' : ''
  const bundledRclone = path.join(resourcesBin, `rclone${exe}`)
  const bundledFfmpeg = path.join(resourcesBin, `ffmpeg${exe}`)
  if (
    !existsSync(bundledFfmpeg) &&
    (options.isPackaged || (options.platform ?? process.platform) === 'darwin')
  )
    throw new Error(
      'Bundled FFmpeg is missing. Run pnpm tools:fetch before starting or building the app.'
    )
  const ffmpeg = existsSync(bundledFfmpeg) ? bundledFfmpeg : `ffmpeg${exe}`
  return {
    userData: options.userData,
    resourcesBin,
    nodeRuntime: options.execPath,
    ffmpeg,
    rclone: existsSync(bundledRclone) ? bundledRclone : `rclone${exe}`,
  }
}
