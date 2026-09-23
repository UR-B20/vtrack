/**
 * grab.ts — pixels out of the <video>: the 64×36 grey thumbnail presence.ts reads, and the
 * full-resolution ROI crop the engine is sent. `toGrey` is pure and tested; the rest is a
 * thin layer over canvas.
 */

import { fitJpeg, type Encode, type FittedFrame, type Rect } from '../../lib/frame'
import { SAMPLE_H, SAMPLE_W } from '../../lib/presence'

/** RGBA → luma (Rec. 601), one byte per pixel. */
export function toGrey(rgba: ArrayLike<number>): Uint8Array {
  const n = Math.floor(rgba.length / 4)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    out[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!)
  }
  return out
}

let thumb: HTMLCanvasElement | null = null

/** The ROI, squashed to 64×36 grey. */
export function sampleRoi(video: HTMLVideoElement, rect: Rect): Uint8Array | null {
  if (!video.videoWidth || rect.width <= 0 || rect.height <= 0) return null
  thumb ??= Object.assign(document.createElement('canvas'), { width: SAMPLE_W, height: SAMPLE_H })
  const ctx = thumb.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, SAMPLE_W, SAMPLE_H)
  return toGrey(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data)
}

/**
 * The ROI at full camera resolution, as the JPEG the engine is sent (§6.2: quality 0.85,
 * ≤ 400 KB). Drawn ONCE, at this instant; every size/quality attempt re-encodes this same
 * picture rather than whatever the camera shows a moment later.
 */
export async function cropJpeg(video: HTMLVideoElement, rect: Rect): Promise<FittedFrame | null> {
  const still = document.createElement('canvas')
  still.width = rect.width
  still.height = rect.height
  still.getContext('2d')!.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  const out = document.createElement('canvas')
  const encode: Encode = (w, h, q) => {
    out.width = w
    out.height = h
    out.getContext('2d')!.drawImage(still, 0, 0, w, h)
    return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', q))
  }
  return fitJpeg(rect.width, rect.height, encode)
}

/** ?dev=1: save the exact bytes that were sent, for the gate benchmark (M2 Stage C). */
export function downloadFrame(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** v20260923-143206: one vehicle's frames sort together, and across reloads. */
export function vehicleTag(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `v${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}
