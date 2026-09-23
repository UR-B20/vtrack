/**
 * supabase.ts — the browser's Supabase client.
 *
 * Anon key only. The service key never leaves the engine's host secrets (CLAUDE.md §1),
 * and every read here goes through the RLS policies and the two _public views in
 * supabase/migrations/0002_policies.sql.
 *
 * The client is optional on purpose: /display must still boot and fall into MANUAL MODE
 * when the env is missing, rather than throwing a white screen at the guard.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && anonKey)

export const supabase: SupabaseClient | null = isConfigured
  ? createClient(url as string, anonKey as string, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null

/** Where this display is, per §6.1's `filter: 'site=eq.<SITE>'`. */
export const SITE = (import.meta.env.VITE_SITE as string | undefined) ?? 'gate1'
export const LANE = (import.meta.env.VITE_LANE as string | undefined) ?? 'A'
export const DEVICE_ID = (import.meta.env.VITE_DEVICE_ID as string | undefined) ?? 'display-b'

/** The capture node whose heartbeat drives the OFFLINE banner (§6.1). */
export const CAMERA_DEVICE_ID = 'cam-a'

/**
 * The VTrack Engine (§5.5): http://localhost:8000 in M1, public HTTPS from M2 — never a LAN
 * address (§1). Unset reads as "not set", a muted pill, rather than as an outage that is
 * really an absence. Health is always probed (useEngineHealth); a URL alone proves nothing.
 */
export const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL as string | undefined) || null

/** The OFFLINE banner's heartbeat rule turns on with M3 (§8). /capture sends heartbeats from
 *  M1, but on a laptop the camera page is opened and closed at will, and a banner that trips
 *  whenever that tab is shut would teach the guard to ignore it before it ever matters. */
export const HEARTBEATS_ENABLED = false
