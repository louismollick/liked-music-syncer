import { existsSync } from 'node:fs'
import path from 'node:path'

interface ExiftoolPathOptions {
  isDev: boolean
  cwd: string
  resourcesPath: string
}

export function resolveExiftoolPath({
  isDev,
  cwd,
  resourcesPath,
}: ExiftoolPathOptions): string {
  const executable = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool'
  const bundledCandidate = isDev
    ? path.join(cwd, 'resources', 'bin', executable)
    : path.join(resourcesPath, 'bin', executable)

  return existsSync(bundledCandidate) ? bundledCandidate : executable
}
