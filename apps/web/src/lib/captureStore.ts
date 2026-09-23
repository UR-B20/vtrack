/**
 * captureStore.ts — what /capture keeps in this tablet's storage between page loads: AUTO
 * or TAP, the presence tuning set at the gate, and the empty-lane background (so a reload
 * with a car already in the lane still reads it — presence.ts, decision 3). The lane ROI
 * itself is in roi.ts. Parsers are pure; storage failures degrade to defaults.
 */

import { DEFAULT_CONFIG, SAMPLE_CELLS, type PresenceConfig } from './presence'
import type { Roi } from './roi'

export type CaptureMode = 'auto' | 'tap'

/** The three thresholds tuned live at the gate (?dev=1); everything else stays default. */
export type Tuning = Pick<PresenceConfig, 'cellT' | 'presenceFrac' | 'motionFrac'>

export const TUNING_LIMITS: Record<keyof Tuning, [number, number]> = {
  cellT: [0.04, 0.4],
  presenceFrac: [0.01, 0.4],
  motionFrac: [0.005, 0.2],
}

export function parseTuning(raw: string | null): Tuning {
  const out: Tuning = { cellT: DEFAULT_CONFIG.cellT, presenceFrac: DEFAULT_CONFIG.presenceFrac, motionFrac: DEFAULT_CONFIG.motionFrac }
  if (!raw) return out
  try {
    const v = JSON.parse(raw) as Partial<Tuning>
    for (const k of Object.keys(TUNING_LIMITS) as (keyof Tuning)[]) {
      const n = v[k]
      const [lo, hi] = TUNING_LIMITS[k]
      if (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi) out[k] = n
    }
  } catch { /* defaults */ }
  return out
}

/** Which ROI, on which camera shape, a background describes. */
export function roiSignature(roi: Roi, aspect: number): string {
  return [roi.x, roi.y, roi.w, roi.h, aspect].map((n) => n.toFixed(3)).join(',')
}

export function parseBackground(raw: string | null, signature: string): Float32Array | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { sig?: unknown; values?: unknown }
    if (v.sig !== signature || !Array.isArray(v.values) || v.values.length !== SAMPLE_CELLS) return null
    if (!v.values.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    return Float32Array.from(v.values as number[])
  } catch {
    return null
  }
}

export function serialiseBackground(bg: Float32Array, signature: string): string {
  return JSON.stringify({ sig: signature, values: Array.from(bg, (n) => Math.round(n * 1000) / 1000) })
}

const KEY = {
  mode: 'vtrack:capture:mode',
  tuning: 'vtrack:capture:tuning',
  background: 'vtrack:capture:background',
  saveFrames: 'vtrack:capture:save-frames',
} as const

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* storage blocked: lasts until the page closes */ }
}

export const store = {
  mode: (): CaptureMode => (read(KEY.mode) === 'tap' ? 'tap' : 'auto'),
  setMode: (m: CaptureMode) => write(KEY.mode, m),
  tuning: (): Tuning => parseTuning(read(KEY.tuning)),
  setTuning: (t: Tuning) => write(KEY.tuning, JSON.stringify(t)),
  background: (signature: string) => parseBackground(read(KEY.background), signature),
  setBackground: (bg: Float32Array | null, signature: string) =>
    write(KEY.background, bg ? serialiseBackground(bg, signature) : null),
  saveFrames: () => read(KEY.saveFrames) === '1',
  setSaveFrames: (on: boolean) => write(KEY.saveFrames, on ? '1' : null),
}
