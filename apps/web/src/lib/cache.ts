/**
 * cache.ts — the offline copy of the approved list.
 *
 * §6.1: a full `vehicles_public` snapshot in IndexedDB, refreshed every 5 minutes while
 * online, so MANUAL MODE can search the list with the network down. The snapshot carries
 * its own sync time because the guard is told how old the copy is — gate-standby.png
 * reads "LIST SYNCED 14:01 · 412 VEHICLES", gate-offline.png "LIST CACHED 14:01".
 */

import { get, set } from 'idb-keyval'
import type { VehiclePublic } from './types'
import { normalise } from './plates'
import { supabase } from './supabase'

const ROWS_KEY = 'vtrack:vehicles'
const META_KEY = 'vtrack:vehicles_meta'

/** §6.1: "refreshed every 5 min while online". */
export const REFRESH_MS = 5 * 60 * 1000

interface CacheMeta {
  /** Local epoch ms of the last successful refresh. */
  syncedAt: number
  count: number
}

export interface CachedList {
  rows: VehiclePublic[]
  /** null when the list has never been fetched — the UI says so rather than inventing a time. */
  syncedAt: number | null
  count: number
}

export async function loadVehicles(): Promise<CachedList> {
  try {
    const [rows, meta] = await Promise.all([
      get<VehiclePublic[]>(ROWS_KEY),
      get<CacheMeta>(META_KEY),
    ])
    return { rows: rows ?? [], syncedAt: meta?.syncedAt ?? null, count: meta?.count ?? rows?.length ?? 0 }
  } catch {
    // A private window or blocked storage must not take the display down.
    return { rows: [], syncedAt: null, count: 0 }
  }
}

export async function saveVehicles(rows: VehiclePublic[]): Promise<CachedList> {
  const meta: CacheMeta = { syncedAt: Date.now(), count: rows.length }
  try {
    // Rows first: the meta must never claim a sync that did not land.
    await set(ROWS_KEY, rows)
    await set(META_KEY, meta)
  } catch {
    /* best effort — an unwritable cache still leaves the in-memory list usable */
  }
  return { rows, syncedAt: meta.syncedAt, count: meta.count }
}

/** Pull the whole list from `vehicles_public` and cache it. Returns null if offline. */
export async function refreshVehicles(): Promise<CachedList | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('vehicles_public')
    .select('plate_norm, plate_display, owner_name, org_unit, pass_type, status, valid_from, valid_until')
    .order('plate_norm')
  if (error || !data) return null
  return saveVehicles(data as VehiclePublic[])
}

/**
 * Search the cached list by plate or by name.
 *
 * Plate matching runs on the normalised string, so "SNB 95" finds SNB9538E — the guard
 * types what is painted on the car, spaces and all, and does not have to know how we
 * store it.
 */
export function searchVehicles(rows: VehiclePublic[], query: string, limit = 8): VehiclePublic[] {
  const q = query.trim()
  if (!q) return []
  const plateQuery = normalise(q)
  const textQuery = q.toLowerCase()

  const scored = rows
    .map((row) => {
      const plate = normalise(row.plate_norm)
      if (plateQuery && plate.startsWith(plateQuery)) return { row, rank: 0 }
      if (plateQuery && plate.includes(plateQuery)) return { row, rank: 1 }
      if (row.owner_name.toLowerCase().includes(textQuery)) return { row, rank: 2 }
      if ((row.org_unit ?? '').toLowerCase().includes(textQuery)) return { row, rank: 3 }
      return null
    })
    .filter((x): x is { row: VehiclePublic; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank || a.row.plate_norm.localeCompare(b.row.plate_norm))

  return scored.slice(0, limit).map((s) => s.row)
}

/** Exact lookup, for resolving the owner line on an ALLOW without a round trip. */
export function findVehicle(rows: VehiclePublic[], plateNorm: string | null): VehiclePublic | null {
  if (!plateNorm) return null
  const key = normalise(plateNorm)
  return rows.find((r) => normalise(r.plate_norm) === key) ?? null
}
