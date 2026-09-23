/** Row shapes mirroring supabase/migrations/0001_init.sql (CLAUDE.md §4). */

import type { PlateKind } from './plates'

export type Decision = 'allow' | 'deny' | 'check'

export type DenyReason =
  | 'not_on_list' | 'expired' | 'suspended'
  | 'unreadable' | 'low_confidence' | 'ambiguous' | 'invalid_pattern'

/** A row of `events`. Timestamps are ISO strings as PostgREST returns them. */
export interface EventRow {
  id: string
  ts: string
  device_id: string | null
  site: string | null
  lane: string | null
  plate_raw: string | null
  plate_norm: string | null
  plate_kind: PlateKind | null
  confidence: number | null
  checksum_ok: boolean | null
  repaired_from: string | null
  vehicle_id: string | null
  decision: Decision
  reason: DenyReason | null
  image_path: string | null
  engine: string | null
  latency_ms: number | null
  read_count: number
  last_read_at: string
  source: 'camera' | 'manual'
}

/** A row of the `vehicles_public` view — the only vehicle columns anon may read. */
export interface VehiclePublic {
  plate_norm: string
  plate_display: string
  owner_name: string
  org_unit: string | null
  pass_type: 'permanent' | 'visitor' | 'contractor'
  status: 'active' | 'suspended'
  valid_from: string | null
  valid_until: string | null
}

/** A row of `vehicles` — admin only, so it carries the columns the drawer edits. */
export interface Vehicle extends VehiclePublic {
  id: string
  vehicle_type: 'car' | 'motorcycle' | 'goods' | 'bus' | 'military' | 'other' | null
  notes: string | null
  created_at?: string
  updated_at?: string
}

export interface DevicePublic {
  id: string
  role: 'capture' | 'display' | 'engine'
  name: string | null
  site: string | null
  lane: string | null
  last_seen_at: string | null
  version: string | null
}

export type GuardActionKind = 'let_through' | 'turned_away' | 'manual_entry' | 'confirmed'

/** The words the gate display shows, per §3 and the canvas. */
export const VERB: Record<Decision, string> = {
  allow: 'PROCEED',
  deny: 'DO NOT ALLOW',
  check: 'VERIFY MANUALLY',
}

/** The word the rail chips use (gate-allowed.png: ALLOWED / DENIED / CHECK). */
export const RAIL_WORD: Record<Decision, string> = {
  allow: 'ALLOWED',
  deny: 'DENIED',
  check: 'CHECK',
}

/** Headline for the reason line under the verb. */
export const REASON_TITLE: Record<DenyReason, string> = {
  not_on_list: 'Not on the list',
  expired: 'Pass expired',
  suspended: 'Pass suspended',
  unreadable: 'Plate could not be read',
  low_confidence: 'Read not confident enough',
  ambiguous: 'More than one possible plate',
  invalid_pattern: 'Not a recognisable plate',
}
