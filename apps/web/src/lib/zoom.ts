/**
 * zoom.ts — the camera's own zoom at point A, set in the ?dev=1 panel (CLAUDE.md §11,
 * Camera at A). Pure: the range the camera reports, and a value clamped to it.
 *
 * Chrome on Android exposes the rear camera's zoom as a MediaStreamTrack capability. Unlike
 * shrinking the lane ROI, which only crops, the camera zooms on the sensor (and switches to
 * a telephoto lens where the phone has one), so a distant plate gets more real pixels.
 */

export interface ZoomRange {
  min: number
  max: number
  step: number
}

/** `track.getCapabilities().zoom`, or null when the camera offers no usable zoom. */
export function zoomRange(cap: unknown): ZoomRange | null {
  if (!cap || typeof cap !== 'object') return null
  const { min, max, step } = cap as { min?: unknown; max?: unknown; step?: unknown }
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) return null
  if (!(max > min)) return null
  const s = typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : 0.1
  return { min, max, step: s }
}

/** Inside the range and on its steps. */
export function clampZoom(value: number, r: ZoomRange): number {
  if (!Number.isFinite(value)) return r.min
  const v = Math.min(r.max, Math.max(r.min, value))
  const snapped = r.min + Math.round((v - r.min) / r.step) * r.step
  return Math.min(r.max, Math.round(snapped * 1000) / 1000)
}

/** A stored zoom, or null for none or anything that is not a positive number. */
export function parseZoom(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}
