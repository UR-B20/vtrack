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
 * Unset in M0 — there is no engine yet. The display treats "unset" as "not deployed"
 * and shows a muted pill, rather than reporting an outage that is really an absence.
 */
export const ENGINE_URL = (import.meta.env.VITE_ENGINE_URL as string | undefined) || null

/** Set once the engine writes heartbeats (M3). Until then `devices.last_seen_at` is
 *  always null, so a staleness rule would pin the OFFLINE banner on for all of M0. */
export const HEARTBEATS_ENABLED = false
