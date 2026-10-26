/**
 * events.ts — the admin Events page's rules (CLAUDE.md §6.3). Pure.
 *
 * The history is shown the way the guard saw it: by screen (green PROCEED, orange VERIFY,
 * red DO NOT ALLOW — routes/display/screen.ts), not by the engine's decision, so "orange"
 * here finds exactly the cars that were orange at the gate.
 */

import type { EventRow } from '../../lib/types'
import type { Tone } from '../display/screen'

export type Range = 'today' | '7d' | '30d' | 'all'
export type ScreenFilter = 'all' | Tone

export const PAGE_SIZE = 100

export interface GuardActionLite { action: string; ts: string }
export type EventWithActions = EventRow & { guard_actions?: GuardActionLite[] | null }

/** Where the history starts, as an ISO instant, or null for all of it. "Today" is today at
 *  the gate (Singapore, UTC+8, no daylight saving), whatever the admin's own timezone. */
export function sinceIso(range: Range, now: Date = new Date()): string | null {
  if (range === 'all') return null
  const gateDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
  const midnight = new Date(`${gateDate}T00:00:00+08:00`)
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29
  return new Date(midnight.getTime() - days * 86_400_000).toISOString()
}

/**
 * The PostgREST filter for one screen colour. Red is only a foreign plate; orange is every
 * check and every other deny (screen.ts toneOf).
 */
export function screenFilter(screen: ScreenFilter):
  | { kind: 'none' }
  | { kind: 'eq'; decision: 'allow' }
  | { kind: 'foreign' }
  | { kind: 'or'; expr: string } {
  switch (screen) {
    case 'all': return { kind: 'none' }
    case 'allow': return { kind: 'eq', decision: 'allow' }
    case 'deny': return { kind: 'foreign' }
    case 'check': return { kind: 'or', expr: 'decision.eq.check,and(decision.eq.deny,reason.neq.foreign)' }
  }
}

/** When the guard pressed OK on this event, or null. */
export function okAt(e: Pick<EventWithActions, 'guard_actions'>): string | null {
  const oks = (e.guard_actions ?? []).filter((a) => a.action === 'confirmed').map((a) => a.ts).sort()
  return oks[0] ?? null
}

/** '26 Oct 14:02:07' in gate time. */
export function eventTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Singapore' })
  const time = d.toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Singapore' })
  return `${day} ${time}`
}
