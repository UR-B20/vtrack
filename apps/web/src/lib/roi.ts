/**
 * roi.ts — the lane ROI: the part of the camera's picture the engine is sent (§6.2). Pure,
 * apart from the two storage helpers at the end.
 *
 * Stored as FRACTIONS of the camera frame, with the frame's aspect ratio, so it survives a
 * change of camera resolution; a change of aspect (the tablet rotated, another camera)
 * means it no longer describes the same part of the lane, and it is dropped.
 *
 * The engine refuses frames under 320 px wide (images.py), and the plate needs pixels on
 * its characters, so the ROI can never be narrower than 320 camera pixels, and the screen
 * warns below 640.
 */

import type { Rect, Size } from './frame'

export interface Roi {
  x: number
  y: number
  w: number
  h: number
}

/** The plate's width at the stop line, as fractions of the sent frame's width (§5.5 roi). */
export type PlateBand = [number, number]

export interface StoredRoi {
  roi: Roi
  aspect: number
  plateBand: PlateBand | null
}

export const MIN_ROI_PX = 320
export const WARN_ROI_PX = 640
const MIN_FRAC = 0.05
/** SET PLATE SIZE takes the last read's width ± this. */
export const BAND_SLACK = 0.3

export const DEFAULT_ROI: Roi = { x: 0.15, y: 0.3, w: 0.7, h: 0.55 }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Keep the ROI inside the frame and at least MIN_ROI_PX camera pixels wide. */
export function clampRoi(roi: Roi, camera: Size): Roi {
  const minW = camera.width > 0 ? Math.min(1, MIN_ROI_PX / camera.width) : MIN_FRAC
  const w = clamp(roi.w, Math.max(minW, MIN_FRAC), 1)
  const h = clamp(roi.h, MIN_FRAC, 1)
  return { x: clamp(roi.x, 0, 1 - w), y: clamp(roi.y, 0, 1 - h), w, h }
}

export function roiPixels(roi: Roi, camera: Size): Rect {
  const x = Math.round(roi.x * camera.width)
  const y = Math.round(roi.y * camera.height)
  return {
    x, y,
    width: Math.min(camera.width - x, Math.round(roi.w * camera.width)),
    height: Math.min(camera.height - y, Math.round(roi.h * camera.height)),
  }
}

export type RoiQuality = 'ok' | 'small' | 'too_small'

export function roiQuality(roi: Roi, camera: Size): RoiQuality {
  const px = roi.w * camera.width
  return px < MIN_ROI_PX ? 'too_small' : px < WARN_ROI_PX ? 'small' : 'ok'
}

export function moveRoi(roi: Roi, dx: number, dy: number, camera: Size): Roi {
  return clampRoi({ ...roi, x: roi.x + dx, y: roi.y + dy }, camera)
}

/** Drag the bottom-right corner. */
export function resizeRoi(roi: Roi, dw: number, dh: number, camera: Size): Roi {
  return clampRoi({ ...roi, w: Math.min(roi.w + dw, 1 - roi.x), h: Math.min(roi.h + dh, 1 - roi.y) }, camera)
}

/** The band SET PLATE SIZE stores, from a plate box and the width of the frame it was in. */
export function bandFromBox(bbox: readonly [number, number, number, number], frameWidth: number): PlateBand | null {
  if (frameWidth <= 0) return null
  const w = Math.abs(bbox[2] - bbox[0]) / frameWidth
  if (!(w > 0 && w <= 1)) return null
  const lo = Math.max(0.01, w * (1 - BAND_SLACK))
  const hi = Math.min(1, w * (1 + BAND_SLACK))
  return [Number(lo.toFixed(4)), Number(hi.toFixed(4))]
}

/** The `roi` form field for /recognise (engine pipeline.py band_from_roi). */
export function roiField(band: PlateBand | null): string | null {
  return band ? JSON.stringify({ plate_w: band }) : null
}

const ASPECT_TOLERANCE = 0.02

export function parseStoredRoi(raw: string | null, aspect: number): StoredRoi | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<StoredRoi>
    const r = v.roi
    const nums = r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n))
    if (!r || !nums || typeof v.aspect !== 'number') return null
    if (Math.abs(v.aspect - aspect) / aspect > ASPECT_TOLERANCE) return null
    const band = Array.isArray(v.plateBand) && v.plateBand.length === 2
      && v.plateBand.every((n) => typeof n === 'number') && v.plateBand[0] < v.plateBand[1]
      ? (v.plateBand as PlateBand) : null
    return { roi: r, aspect: v.aspect, plateBand: band }
  } catch {
    return null
  }
}

const ROI_KEY = 'vtrack:capture:roi'

export function loadRoi(aspect: number): StoredRoi | null {
  try {
    return parseStoredRoi(localStorage.getItem(ROI_KEY), aspect)
  } catch {
    return null
  }
}

export function saveRoi(stored: StoredRoi): void {
  try {
    localStorage.setItem(ROI_KEY, JSON.stringify(stored))
  } catch {
    /* storage blocked: the ROI lasts until the page closes */
  }
}
