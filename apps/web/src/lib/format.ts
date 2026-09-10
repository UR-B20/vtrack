/** Small display formatters. Times are rendered in the gate's timezone, not the browser's. */

const GATE_TZ = 'Asia/Singapore'

/** 'HH:MM:SS' — the top-bar and rail clock. */
export function formatClock(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '--:--:--'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-GB', { hour12: false, timeZone: GATE_TZ })
}

/** 'HH:MM' — the "since 14:02" and "cached at 14:01" lines. */
export function formatShortClock(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '--:--'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '--:--'
  return d.toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: GATE_TZ })
}

/** '31 Dec 2026' — the allow line's "valid to". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/**
 * '0.8 s' — the trust line's "READ n.n s AGO".
 * Counts from a *local* millisecond stamp, never a server timestamp, so it cannot render
 * a negative or absurd age when the tablet's clock drifts. Clamped at zero.
 */
export function formatAge(sinceLocalMs: number | null, nowMs: number): string {
  if (sinceLocalMs === null) return '—'
  return `${Math.max(0, (nowMs - sinceLocalMs) / 1000).toFixed(1)} s`
}

/** '0.97' — confidence, always two decimals, or a dash when the engine sent none. */
export function formatConfidence(c: number | null | undefined): string {
  return c === null || c === undefined ? '—' : c.toFixed(2)
}

/** 'gate1' → 'GATE 1', 'A' → 'A'. Site ids are slugs; the guard reads a label. */
export function siteLabel(site: string): string {
  return site.toUpperCase().replace(/([A-Z])(\d)/g, '$1 $2')
}
