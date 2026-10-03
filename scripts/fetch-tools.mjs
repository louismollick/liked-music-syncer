import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

/**
 * Downloads the tools bundled into resources/bin, each pinned and checksummed:
 * the bgutil PO token provider (yt-dlp plugin + server) and rclone for the
 * target architecture. yt-dlp is not bundled: the app downloads and updates it
 * at runtime. FFmpeg uses current static macOS builds from OSXExperts and evermeet;
 * ffmpeg-static still distributes FFmpeg 6.0 on Apple Silicon.
 *
 * Set LMS_TOOLS_ARCH=x64|arm64 to fetch tools for another macOS architecture.
 */

const BGUTIL_VERSION = '2.0.1'
const BGUTIL_PLUGIN = {
  url: `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip`,
  sha256: '6fc9d757578949ba3cad2f561f57dfbc16142dbf8d485fe1bf9f0733f23bf9e3',
}
const BGUTIL_SOURCE = {
  url: `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/${BGUTIL_VERSION}.tar.gz`,
  sha256: 'bae71b7971fa22376af57edca8d3487724ac9a8ada56d1cccf07a547b4b9b62c',
}
const RCLONE_VERSION = '1.75.0'
const RCLONE_SHA256 = {
  'osx-arm64':
    '35e8f2a666ce789b29111db0dd843ddabc0d59c6b609d07bcaae5d1a07cba6f8',
  'osx-amd64':
    '19edbb8e5e73096eb66e92a42abbc5c34bfa8981ea3986a53872c7eef85a22f4',
  'linux-amd64':
    'aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa',
}

// ARM binary checksum: https://www.osxexperts.net/. Archives are pinned too.
const FFMPEG = {
  arm64: {
    version: '9.0',
    url: 'https://www.osxexperts.net/ffmpeg9arm.zip',
    archiveSha256:
      'd0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9',
    binarySha256:
      '591260c945d0eef150e3bf82b0ef988bd36a9cecc18ff05d6679617159f0a95e',
  },
  x64: {
    version: '9.0.2',
    url: 'https://evermeet.cx/ffmpeg/ffmpeg-9.0.2.zip',
    archiveSha256:
      '4acc0be580f9b2788029eb7bd4d645ff87968911b0a62aeeb3940d42d54558d5',
    binarySha256:
      'a45b462cf91ed89148ae218c4577e30896485d7a6792c3673bcf5f823fa01b63',
  },
}

const repositoryRoot = process.cwd()
const binDirectory = path.resolve(repositoryRoot, 'resources/bin')
const pluginDirectory = path.join(binDirectory, 'yt-dlp-plugins')
const providerRootDirectory = path.join(
  binDirectory,
  'bgutil-ytdlp-pot-provider'
)
const providerServerDirectory = path.join(providerRootDirectory, 'server')

async function download(url, target, sha256) {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Failed to download ${url}: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== sha256)
    throw new Error(`Checksum mismatch for ${url}: ${digest}`)
  await writeFile(target, bytes)
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})`)
}

function rcloneTarget() {
  const arch = process.env.LMS_TOOLS_ARCH ?? process.arch
  const platform = process.platform === 'darwin' ? 'osx' : 'linux'
  return `${platform}-${arch === 'arm64' ? 'arm64' : 'amd64'}`
}

const temp = path.join(os.tmpdir(), `liked-music-syncer-tools-${Date.now()}`)
await mkdir(temp, { recursive: true })
await mkdir(pluginDirectory, { recursive: true })

console.log(`Downloading bgutil provider plugin ${BGUTIL_VERSION}...`)
await download(
  BGUTIL_PLUGIN.url,
  path.join(pluginDirectory, 'bgutil-ytdlp-pot-provider.zip'),
  BGUTIL_PLUGIN.sha256
)

console.log(`Downloading bgutil provider source ${BGUTIL_VERSION}...`)
const sourceArchive = path.join(temp, 'bgutil.tar.gz')
await download(BGUTIL_SOURCE.url, sourceArchive, BGUTIL_SOURCE.sha256)
run('tar', ['-xzf', sourceArchive, '-C', temp], repositoryRoot)
await rm(providerRootDirectory, { force: true, recursive: true })
await mkdir(providerRootDirectory, { recursive: true })
await cp(
  path.join(temp, `bgutil-ytdlp-pot-provider-${BGUTIL_VERSION}`, 'server'),
  providerServerDirectory,
  { recursive: true }
)
console.log('Building bgutil provider server...')
run('npm', ['ci'], providerServerDirectory)
run('npx', ['tsc'], providerServerDirectory)
run('npm', ['prune', '--omit=dev'], providerServerDirectory)

const target = rcloneTarget()
const rcloneName = `rclone-v${RCLONE_VERSION}-${target}`
console.log(`Downloading ${rcloneName}...`)
const rcloneZip = path.join(temp, `${rcloneName}.zip`)
await download(
  `https://downloads.rclone.org/v${RCLONE_VERSION}/${rcloneName}.zip`,
  rcloneZip,
  RCLONE_SHA256[target]
)
run('unzip', ['-q', '-o', rcloneZip, '-d', temp], repositoryRoot)
await cp(
  path.join(temp, rcloneName, 'rclone'),
  path.join(binDirectory, 'rclone')
)
await chmod(path.join(binDirectory, 'rclone'), 0o755)

let ffmpegDescription = 'system FFmpeg (development on non-macOS only)'
if (process.platform === 'darwin') {
  const arch = process.env.LMS_TOOLS_ARCH ?? process.arch
  const ffmpeg = FFMPEG[arch]
  if (!ffmpeg) throw new Error(`Unsupported FFmpeg architecture: ${arch}`)
  const archive = path.join(temp, 'ffmpeg.zip')
  const extracted = path.join(temp, 'ffmpeg')
  await mkdir(extracted)
  console.log(`Downloading FFmpeg ${ffmpeg.version} (${arch})...`)
  await download(ffmpeg.url, archive, ffmpeg.archiveSha256)
  run('unzip', ['-q', '-o', archive, '-d', extracted], repositoryRoot)
  const binary = path.join(extracted, 'ffmpeg')
  const digest = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex')
  if (digest !== ffmpeg.binarySha256)
    throw new Error(`FFmpeg binary checksum mismatch: ${digest}`)
  await cp(binary, path.join(binDirectory, 'ffmpeg'))
  await chmod(path.join(binDirectory, 'ffmpeg'), 0o755)
  ffmpegDescription = `${ffmpeg.version} (${arch}): ffmpeg`
}

await writeFile(
  path.join(binDirectory, 'README.txt'),
  `Bundled tooling for liked-music-syncer (generated by pnpm tools:fetch).

- bgutil PO token provider ${BGUTIL_VERSION}: yt-dlp-plugins/ and bgutil-ytdlp-pot-provider/server/
- rclone ${RCLONE_VERSION} (${target}): rclone
- ffmpeg ${ffmpegDescription}
- yt-dlp: downloaded by the app at runtime into its data folder
`,
  'utf8'
)
await rm(temp, { recursive: true, force: true })
console.log(`Prepared ${binDirectory}`)
