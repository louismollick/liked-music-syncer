import { existsSync } from 'node:fs'
import path from 'node:path'
import ffmpegStaticPath from 'ffmpeg-static'

interface FfmpegPathOptions {
  isDev: boolean
  cwd: string
  resourcesPath: string
  dependencyPath?: string | null
}

function unpackedAsarPath(candidate: string): string {
  return candidate.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`
  )
}

export function resolveFfmpegPath({
  isDev,
  cwd,
  resourcesPath,
  dependencyPath = ffmpegStaticPath,
}: FfmpegPathOptions): string {
  const bundledCandidate = isDev
    ? path.join(cwd, 'resources/bin', 'ffmpeg')
    : path.join(resourcesPath, 'bin', 'ffmpeg')

  const candidates = [bundledCandidate]
  if (dependencyPath) {
    candidates.push(unpackedAsarPath(dependencyPath), dependencyPath)
  }

  return candidates.find((candidate) => existsSync(candidate)) ?? 'ffmpeg'
}
