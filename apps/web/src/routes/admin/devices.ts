/**
 * devices.ts — the admin Devices page's rules (CLAUDE.md §6.3, §11 Device tokens). Pure.
 */

export interface DeviceRow {
  id: string
  role: 'capture' | 'display' | 'engine'
  name: string | null
  site: string | null
  lane: string | null
  last_seen_at: string | null
  version: string | null
  token_rotated_at: string | null
}

/** The columns a signed-in browser may read — never token_hash (0004, 0005). */
export const DEVICE_COLUMNS = 'id, role, name, site, lane, last_seen_at, version, token_rotated_at'

export type Seen = 'online' | 'offline' | 'never' | 'not_reported'

/**
 * How recently a device must have reported to count as online. The camera page reports
 * every 10 s (the display's OFFLINE rule allows 30 s, §6.1); the engine touches its own row
 * every heartbeat_s, 10 minutes by default. The display sends nothing — it only listens.
 */
export const ONLINE_WITHIN_MS: Record<DeviceRow['role'], number | null> = {
  capture: 30_000,
  engine: 25 * 60_000,
  display: null,
}

export function seenState(row: Pick<DeviceRow, 'role' | 'last_seen_at'>, nowMs: number): Seen {
  const window = ONLINE_WITHIN_MS[row.role]
  if (window === null) return 'not_reported'
  if (!row.last_seen_at) return 'never'
  const at = Date.parse(row.last_seen_at)
  if (Number.isNaN(at)) return 'never'
  return nowMs - at <= window ? 'online' : 'offline'
}

/** "12 s ago", "4 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return '—'
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return '—'
  const s = Math.max(0, Math.round((nowMs - at) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `${Math.floor(s / 86_400)} d ago`
}

/** Only a camera uses a device token today: the display signs in (0004), the engine is the
 *  engine. */
export function takesToken(row: Pick<DeviceRow, 'role'>): boolean {
  return row.role === 'capture'
}
