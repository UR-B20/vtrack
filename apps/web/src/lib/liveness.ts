/**
 * liveness.ts — is camera A still reporting? (CLAUDE.md §6.1 OFFLINE banner). Pure.
 *
 * /capture sends a heartbeat every 10 s, which the engine writes to devices.last_seen_at.
 * That is a server timestamp; the phone's clock is its own, and on mobile data it can be
 * well off. So, as for the display's hold timers, staleness is measured on the local clock:
 * from when the phone last *saw the value change*. Only the very first reading compares
 * clocks, with a generous tolerance, to tell "fresh" from "hours old".
 */

/** §6.1: offline when the camera has not reported for this long. */
export const OFFLINE_AFTER_MS = 30_000
/** First reading only: how far the two clocks may disagree and still count as fresh. */
export const FIRST_READ_TOLERANCE_MS = 60_000

export interface Liveness {
  /** The last last_seen_at value read, as given. */
  seen: string | null
  /** Local ms at which that value was first read (or judged fresh), or null: never. */
  localSeenAt: number | null
}

export const unknownLiveness: Liveness = { seen: null, localSeenAt: null }

export function observe(prev: Liveness, seen: string | null, nowLocal: number, first: boolean): Liveness {
  if (!seen) return { seen: null, localSeenAt: prev.localSeenAt }
  if (seen === prev.seen) return prev
  if (!first) return { seen, localSeenAt: nowLocal }
  const at = Date.parse(seen)
  const fresh = !Number.isNaN(at) && Math.abs(nowLocal - at) <= FIRST_READ_TOLERANCE_MS
  return { seen, localSeenAt: fresh ? nowLocal : null }
}

export function cameraOffline(l: Liveness, nowLocal: number): boolean {
  return l.localSeenAt === null || nowLocal - l.localSeenAt > OFFLINE_AFTER_MS
}
