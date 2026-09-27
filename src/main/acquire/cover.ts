import { runChecked } from '../platform/process'

/**
 * Square cover art, matching the old Pillow pipeline: trim a uniform border
 * (pixels within 18 of the average corner colour), center-crop to a square,
 * scale to `size` with Lanczos, JPEG quality ~92. Uses ffmpeg, so it needs no
 * native image library and works in tests.
 */

const TOLERANCE = 18
const ANALYSIS_SIZE = 256

interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export function uniformBorderBox(
  rgb: Uint8Array,
  width: number,
  height: number,
  tolerance = TOLERANCE
): Box | null {
  const pixel = (x: number, y: number) => {
    const offset = (y * width + x) * 3
    return [rgb[offset], rgb[offset + 1], rgb[offset + 2]]
  }
  const corners = [
    pixel(0, 0),
    pixel(width - 1, 0),
    pixel(0, height - 1),
    pixel(width - 1, height - 1),
  ]
  const background = [0, 1, 2].map((channel) =>
    Math.floor(corners.reduce((sum, c) => sum + c[channel], 0) / 4)
  )
  let left = width
  let top = height
  let right = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y)
      // Pillow's difference().convert('L') weights channels like luma.
      const diff =
        (Math.abs(r - background[0]) * 299 +
          Math.abs(g - background[1]) * 587 +
          Math.abs(b - background[2]) * 114) /
        1000
      if (diff > tolerance) {
        if (x < left) left = x
        if (x > right) right = x
        if (y < top) top = y
        if (y > bottom) bottom = y
      }
    }
  }
  if (right < 0) return null
  return { left, top, right: right + 1, bottom: bottom + 1 }
}

export async function makeSquareCover(
  ffmpeg: string,
  image: Uint8Array,
  size = 1200
): Promise<Uint8Array> {
  const probe = await runChecked(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vf',
      `scale=${ANALYSIS_SIZE}:${ANALYSIS_SIZE}:flags=area`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { input: Buffer.from(image), binaryStdout: true }
  )
  const box = uniformBorderBox(probe.stdoutBytes, ANALYSIS_SIZE, ANALYSIS_SIZE)
  // Express the crop as fractions of the source so ffmpeg can apply it at full resolution.
  const fx = box ? box.left / ANALYSIS_SIZE : 0
  const fy = box ? box.top / ANALYSIS_SIZE : 0
  const fw = box ? (box.right - box.left) / ANALYSIS_SIZE : 1
  const fh = box ? (box.bottom - box.top) / ANALYSIS_SIZE : 1
  const filters = [
    `crop=iw*${fw.toFixed(5)}:ih*${fh.toFixed(5)}:iw*${fx.toFixed(5)}:ih*${fy.toFixed(5)}`,
    "crop='min(iw,ih)':'min(iw,ih)'",
    `scale=${size}:${size}:flags=lanczos`,
  ]
  const result = await runChecked(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-vf',
      filters.join(','),
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-f',
      'mjpeg',
      'pipe:1',
    ],
    { input: Buffer.from(image), binaryStdout: true }
  )
  return new Uint8Array(result.stdoutBytes)
}
