import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ffmpegPath from 'ffmpeg-static'

export function tempDir(prefix = 'lms-test-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

/** Generates a short AAC .m4a with a sine tone. */
export function makeM4a(
  target: string,
  seconds = 0.5,
  frequency = 440
): string {
  execFileSync(
    ffmpegPath as unknown as string,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=${seconds}`,
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-y',
      target,
    ],
    { stdio: 'ignore' }
  )
  return target
}

/** A tiny valid JPEG (1x1 px). */
export const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64'
)
