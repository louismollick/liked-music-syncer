import { readdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { ProcessError, run, runChecked } from '../platform/process'
import type { ToolPaths } from '../platform/tools'
import { POT_BASE_URL, type PotProvider } from './pot-provider'
import type { YtDlpBinary } from './ytdlp-binary'

export interface DownloadProgress {
  /** 0..1 fraction of bytes downloaded. */
  fraction: number
}

export interface AudioDownloader {
  /**
   * Downloads the best audio for a video into `workDir` and returns a path to
   * an AAC .m4a file inside `workDir`.
   */
  download(
    videoId: string,
    workDir: string,
    onProgress: (progress: DownloadProgress) => void,
    signal?: AbortSignal
  ): Promise<string>
}

const PERMANENT_PATTERNS = [
  /Video unavailable/i,
  /Private video/i,
  /has been removed/i,
  /not available in your country/i,
  /account associated with this video has been terminated/i,
  /Sign in to confirm your age/i,
  /members-only/i,
]

export function classifyYtDlpError(stderr: string): 'transient' | 'permanent' {
  return PERMANENT_PATTERNS.some((pattern) => pattern.test(stderr))
    ? 'permanent'
    : 'transient'
}

export function createAudioDownloader(deps: {
  tools: ToolPaths
  ytdlp: YtDlpBinary
  pot: PotProvider
}): AudioDownloader {
  return {
    async download(videoId, workDir, onProgress, signal) {
      const binary = await deps.ytdlp.ensure(signal)
      await deps.pot.ensureReady()
      const template = path.join(workDir, 'source.%(ext)s')
      const args = [
        '--no-config',
        '--no-playlist',
        '--no-warnings',
        '--newline',
        '--js-runtimes',
        `node:${deps.tools.nodeRuntime}`,
        '--plugin-dirs',
        deps.pot.pluginDir,
        '--extractor-args',
        `youtube:player_client=mweb;youtubepot-bgutilhttp:base_url=${POT_BASE_URL}`,
        '-f',
        'bestaudio/best',
        '--progress-template',
        'download:LMSPROGRESS %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s',
        '--print',
        'after_move:LMSFILE %(filepath)s|%(acodec)s',
        '-o',
        template,
        `https://music.youtube.com/watch?v=${videoId}`,
      ]
      let downloaded: string | null = null
      let codec: string | null = null
      const result = await run(binary, args, {
        signal,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        onLine(line) {
          if (line.startsWith('LMSPROGRESS ')) {
            const [, done, total, estimate] = line.split(' ')
            const denominator = Number(total) || Number(estimate)
            const numerator = Number(done)
            if (denominator > 0 && Number.isFinite(numerator)) {
              onProgress({ fraction: Math.min(1, numerator / denominator) })
            }
          } else if (line.startsWith('LMSFILE ')) {
            const [file, acodec] = line.slice(8).split('|')
            downloaded = file
            codec = acodec ?? null
          }
        },
      })
      if (result.code !== 0 || !downloaded) {
        const tail = result.stderr.trim().split('\n').slice(-2).join(' | ')
        throw new ProcessError(
          `yt-dlp failed: ${tail || `exit ${result.code}`}`,
          result,
          classifyYtDlpError(result.stderr)
        )
      }
      onProgress({ fraction: 1 })
      return toM4a(deps.tools.ffmpeg, downloaded, codec, workDir, signal)
    },
  }
}

/** Remuxes AAC into .m4a, or encodes other codecs to AAC. */
export async function toM4a(
  ffmpeg: string,
  input: string,
  codec: string | null,
  workDir: string,
  signal?: AbortSignal
): Promise<string> {
  const output = path.join(workDir, 'audio.m4a')
  const isAac = codec?.startsWith('mp4a') || codec === 'aac'
  if (isAac && input.toLowerCase().endsWith('.m4a')) {
    await rename(input, output)
    return output
  }
  await runChecked(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-vn',
      '-map_metadata',
      '-1',
      '-c:a',
      isAac ? 'copy' : 'aac',
      ...(isAac ? [] : ['-b:a', '256k']),
      '-movflags',
      '+faststart',
      output,
    ],
    { signal }
  )
  await rm(input, { force: true })
  return output
}

export async function clearWorkDir(workDir: string): Promise<void> {
  const entries = await readdir(workDir).catch(() => [])
  await Promise.all(
    entries.map((entry) => rm(path.join(workDir, entry), { force: true }))
  )
}
