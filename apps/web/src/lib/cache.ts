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
  /**
   * Why the last refresh did not land, or null if it did.
   *
   * This exists because an empty approved list is the one failure the guard must never
   * have to guess at. Manual mode is the fallback that makes demo day safe (brief §2,
   * position 2); a manual mode that silently finds nothing is worse than one that says
   * it has no list, because it looks like the vehicle is not approved.
   */
  syncError: string | null
}

export async function loadVehicles(): Promise<CachedList> {
  try {
    const [rows, meta] = await Promise.all([
      get<VehiclePublic[]>(ROWS_KEY),
      get<CacheMeta>(META_KEY),
    ])
    return {
      rows: rows ?? [],
      syncedAt: meta?.syncedAt ?? null,
      count: meta?.count ?? rows?.length ?? 0,
      syncError: null,
    }
  } catch {
    // A private window or blocked storage must not take the display down.
    return { rows: [], syncedAt: null, count: 0, syncError: 'this browser is blocking local storage' }
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
  return { rows, syncedAt: meta.syncedAt, count: meta.count, syncError: null }
}

/**
 * Pull the whole list from `vehicles_public` and cache it.
 *
 * Always returns a usable CachedList: on failure the previously cached rows are kept and
 * `syncError` says what went wrong, so the screen can tell the guard the list is stale
 * rather than quietly showing an empty one. The three failure modes are deliberately
 * distinguished — not configured, refused/unreachable, and reachable but empty — because
 * they have completely different fixes.
 */
/**
 * Turn a PostgREST or transport error into something a guard at a gate can act on.
 * "TypeError: Failed to fetch" is true and useless; the cause is nearly always one of
 * four things, and each has a different fix.
 */
function describeError(error: { code?: string; message: string }): string {
  const m = error.message ?? ''
  if (/failed to fetch|networkerror|load failed/i.test(m)) {
    return 'cannot reach Supabase — check VITE_SUPABASE_URL, the network, and that the project is not paused'
  }
  if (error.code === 'PGRST301' || /jwt|api key|apikey/i.test(m)) {
    return 'Supabase rejected the key — check VITE_SUPABASE_ANON_KEY'
  }
  if (error.code === '42P01' || /does not exist|could not find the table/i.test(m)) {
    return 'vehicles_public does not exist — run supabase/migrations/0002_policies.sql'
  }
  if (error.code === '42501' || /permission denied/i.test(m)) {
    return 'permission denied on vehicles_public — re-run supabase/migrations/0002_policies.sql'
  }
  return [error.code, m].filter(Boolean).join(' · ') || 'the vehicle list could not be read'
}

export async function refreshVehicles(): Promise<CachedList> {
  const cached = await loadVehicles()

  if (!supabase) {
    return { ...cached, syncError: 'not configured — set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in apps/web/.env' }
  }

  // supabase-js resolves with an `error` for anything PostgREST answered, but THROWS for
  // a transport failure — DNS, TLS, CORS, a dead project. Both have to be caught here:
  // an uncaught rejection would leave the cache silently untouched, which is the failure
  // mode this whole function exists to make visible.
  let data: unknown[] | null = null
  let error: { code?: string; message: string } | null = null
  try {
    const result = await supabase
      .from('vehicles_public')
      .select('plate_norm, plate_display, owner_name, org_unit, pass_type, status, valid_from, valid_until')
      .order('plate_norm')
    data = result.data
    error = result.error
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    console.warn('[vtrack] could not reach Supabase to refresh the vehicle list:', message, thrown)
    return {
      ...cached,
      syncError: `cannot reach Supabase (${message}) — check VITE_SUPABASE_URL and that the project is awake`,
    }
  }

  if (error) {
    console.warn('[vtrack] could not refresh the vehicle list:', error.message, error)
    return { ...cached, syncError: describeError(error) }
  }

  if (!data || data.length === 0) {
    // Reachable and permitted, but nothing there. Almost always seed.sql not run, or
    // run against a different project than the one this build points at.
    console.warn('[vtrack] vehicles_public returned 0 rows — has supabase/seed.sql been run on this project?')
    const saved = await saveVehicles([])
    return { ...saved, syncError: 'the approved list is empty — run supabase/seed.sql' }
  }

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
