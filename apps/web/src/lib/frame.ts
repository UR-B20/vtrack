/**
 * frame.ts — turning a camera frame into something the engine accepts, and putting its
 * answer back on the screen. Pure: the canvas is passed in as an `encode` function, so this
 * runs (and is tested) without a browser.
 */

/** The engine accepts ≤ 400 KiB (images.py). Aim under 400 000 bytes so a frame passes on
 *  either reading of "400 KB". */
export const MAX_FRAME_BYTES = 400_000
/** The engine refuses anything narrower (images.py MIN_WIDTH). */
export const MIN_FRAME_WIDTH = 320

/** §6.2: quality 0.85 at full resolution first. */
export const QUALITIES = [0.85, 0.75, 0.65, 0.55] as const
export const SCALES = [1, 0.8, 0.64, 0.5] as const

/** Draw the frame at width × height and JPEG-encode it at `quality` (0–1). */
export type Encode = (width: number, height: number, quality: number) => Promise<Blob | null>

export interface FittedFrame {
  blob: Blob
  width: number
  height: number
  quality: number
}

/**
 * The best JPEG under the limit. Quality steps down before resolution does, because the OCR
 * needs pixels on the characters more than it needs clean compression. Never narrower than
 * the engine accepts; null if nothing fits (in practice only for an enormous, noisy frame).
 */
export async function fitJpeg(srcWidth: number, srcHeight: number, encode: Encode): Promise<FittedFrame | null> {
  for (const scale of SCALES) {
    const width = Math.round(srcWidth * scale)
    const height = Math.round(srcHeight * scale)
    if (width < MIN_FRAME_WIDTH) break
    for (const quality of QUALITIES) {
      const blob = await encode(width, height, quality)
      if (blob && blob.size <= MAX_FRAME_BYTES) return { blob, width, height, quality }
    }
  }
  return null
}

export interface Size {
  width: number
  height: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a box in the SENT image's pixels lands on a <video> showing the whole frame
 * letterboxed (object-fit: contain). The sent image may be scaled down from the camera's
 * resolution, but never cropped, so its aspect ratio is the video's and one scale factor
 * maps it. Clamped to the view, so a box at the edge of the frame never draws off-screen.
 */
export function mapBox(bbox: readonly [number, number, number, number], sent: Size, view: Size): Box | null {
  if (sent.width <= 0 || sent.height <= 0 || view.width <= 0 || view.height <= 0) return null
  const scale = Math.min(view.width / sent.width, view.height / sent.height)
  const offX = (view.width - sent.width * scale) / 2
  const offY = (view.height - sent.height * scale) / 2
  const [x1, y1, x2, y2] = bbox
  const left = Math.max(0, offX + Math.min(x1, x2) * scale)
  const top = Math.max(0, offY + Math.min(y1, y2) * scale)
  const right = Math.min(view.width, offX + Math.max(x1, x2) * scale)
  const bottom = Math.min(view.height, offY + Math.max(y1, y2) * scale)
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}
