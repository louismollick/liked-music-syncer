import { spawnSync } from 'node:child_process'
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const BGUTIL_VERSION = '1.3.2'
const BGUTIL_PLUGIN_URL = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip`
const BGUTIL_SOURCE_URL = `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz`

const repositoryRoot = process.cwd()
const binDirectory = path.resolve(repositoryRoot, 'resources/bin')
const pluginDirectory = path.join(binDirectory, 'yt-dlp-plugins')
const providerRootDirectory = path.join(
  binDirectory,
  'bgutil-ytdlp-pot-provider'
)
const providerServerDirectory = path.join(providerRootDirectory, 'server')

async function downloadFile(url, targetPath) {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(
      `Failed to download ${url}: ${response.status} ${response.statusText}`
    )
  }

  const arrayBuffer = await response.arrayBuffer()
  await writeFile(targetPath, Buffer.from(arrayBuffer))
}

function runOrThrow(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })

  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit code ${result.status ?? 'unknown'}`
    )
  }
}

const tempDirectory = await rm(
  path.join(os.tmpdir(), 'liked-music-syncer-tools'),
  {
    force: true,
    recursive: true,
  }
).then(async () => {
  const tempRoot = path.join(
    os.tmpdir(),
    `liked-music-syncer-tools-${Date.now()}`
  )
  await mkdir(tempRoot, { recursive: true })
  return tempRoot
})

await mkdir(binDirectory, { recursive: true })
await mkdir(pluginDirectory, { recursive: true })

const pluginZipPath = path.join(
  pluginDirectory,
  'bgutil-ytdlp-pot-provider.zip'
)
const sourceArchivePath = path.join(
  tempDirectory,
  `bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}.tar.gz`
)

console.log(`Downloading bgutil provider plugin ${BGUTIL_VERSION}...`)
await downloadFile(BGUTIL_PLUGIN_URL, pluginZipPath)

console.log(`Downloading bgutil provider source ${BGUTIL_VERSION}...`)
await downloadFile(BGUTIL_SOURCE_URL, sourceArchivePath)

runOrThrow(
  'tar',
  ['-xzf', sourceArchivePath, '-C', tempDirectory],
  repositoryRoot
)

const extractedRootDirectory = path.join(
  tempDirectory,
  `bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}`
)
const extractedServerDirectory = path.join(extractedRootDirectory, 'server')

await rm(providerRootDirectory, { force: true, recursive: true })
await mkdir(providerRootDirectory, { recursive: true })
await cp(extractedServerDirectory, providerServerDirectory, { recursive: true })

console.log('Installing bgutil provider dependencies...')
runOrThrow('npm', ['ci'], providerServerDirectory)

console.log('Building bgutil provider server...')
runOrThrow('npx', ['tsc'], providerServerDirectory)

console.log('Pruning bgutil provider dev dependencies...')
runOrThrow('npm', ['prune', '--omit=dev'], providerServerDirectory)

const readmeContents = `Bundled tooling for liked-music-syncer.

- ffmpeg -> installed by pnpm through the pinned ffmpeg-static dependency
- yt-dlp plugin zip -> resources/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip
- bgutil provider server -> resources/bin/bgutil-ytdlp-pot-provider/server/build/main.js

Pinned bgutil version: ${BGUTIL_VERSION}

Packaged builds bundle these exact paths.
`

await writeFile(path.join(binDirectory, 'README.txt'), readmeContents, 'utf8')

console.log(`Prepared ${binDirectory}. pnpm provides ffmpeg-static separately.`)
