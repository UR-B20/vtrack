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

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** How a `src`-sized picture sits in a `view` with object-fit: contain. */
export function containFit(src: Size, view: Size): { scale: number; offX: number; offY: number } | null {
  if (src.width <= 0 || src.height <= 0 || view.width <= 0 || view.height <= 0) return null
  const scale = Math.min(view.width / src.width, view.height / src.height)
  return { scale, offX: (view.width - src.width * scale) / 2, offY: (view.height - src.height * scale) / 2 }
}

/** Where a rectangle in CAMERA pixels (the lane ROI) sits on the letterboxed <video>. */
export function rectToView(rect: Rect, camera: Size, view: Size): Box | null {
  const fit = containFit(camera, view)
  if (!fit) return null
  return {
    left: fit.offX + rect.x * fit.scale,
    top: fit.offY + rect.y * fit.scale,
    width: rect.width * fit.scale,
    height: rect.height * fit.scale,
  }
}

/**
 * Where a box in the SENT image's pixels lands on the <video> (object-fit: contain).
 *
 * The sent image is the lane ROI (`crop`, in camera pixels), possibly scaled down by
 * fitJpeg. So: undo the fit scale, add the ROI's offset in the camera frame, then place the
 * camera frame in the view. Clamped to the view, so a box at an edge never draws off-screen.
 */
export function mapCropBox(
  bbox: readonly [number, number, number, number], sent: Size, crop: Rect, camera: Size, view: Size,
): Box | null {
  if (sent.width <= 0 || sent.height <= 0 || crop.width <= 0 || crop.height <= 0) return null
  const fit = containFit(camera, view)
  if (!fit) return null
  const sx = crop.width / sent.width
  const sy = crop.height / sent.height
  const [x1, y1, x2, y2] = bbox
  const toX = (x: number) => fit.offX + (crop.x + x * sx) * fit.scale
  const toY = (y: number) => fit.offY + (crop.y + y * sy) * fit.scale
  const left = Math.max(0, toX(Math.min(x1, x2)))
  const top = Math.max(0, toY(Math.min(y1, y2)))
  const right = Math.min(view.width, toX(Math.max(x1, x2)))
  const bottom = Math.min(view.height, toY(Math.max(y1, y2)))
  if (right <= left || bottom <= top) return null
  return { left, top, width: right - left, height: bottom - top }
}

/** The whole frame was sent (TAP with no ROI): the crop is the frame itself. */
export function mapBox(bbox: readonly [number, number, number, number], sent: Size, view: Size): Box | null {
  return mapCropBox(bbox, sent, { x: 0, y: 0, width: sent.width, height: sent.height }, sent, view)
}
