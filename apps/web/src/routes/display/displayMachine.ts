/**
 * displayMachine.ts — the gate display's state machine (CLAUDE.md §6.1, brief §4.5).
 *
 *   STANDBY ──event──▶ ALLOW | DENY | CHECK ──hold expires | next vehicle | guard acts──▶ STANDBY
 *                            ▲ │ UPDATE on the same event (dedupe) re-renders in place
 *
 * Pure: a reducer over values, returning the next state plus the effects the component
 * should perform (today: chimes). No I/O, no clock reads, no React. Every rule below
 * has a test in displayMachine.test.ts.
 *
 * ── Two decisions worth knowing before you change anything ──
 *
 * 1. TIMERS RUN ON THE LOCAL CLOCK, NOT THE SERVER'S.
 *    `ts` and `last_read_at` come from Postgres `now()`; the tick's `now` is the
 *    browser's. Comparing them directly means a tablet whose clock is 15 s fast clears
 *    a DENY on the first tick — and the gate tablets run on mobile data with no NTP
 *    guarantee. So the hold window is measured from `stageLastReadLocal`: the moment
 *    *we received* the read. An UPDATE arriving is itself the evidence that the car is
 *    still being read, which is a better signal than a timestamp we cannot trust.
 *    Server timestamps are used only for text the guard reads as a clock (rail times).
 *
 * 2. `hydrate` NEVER STAGES AND NEVER CHIMES.
 *    §6.1 loads the last five events into the rail on connect. If that could also take
 *    the stage, every reload, reconnect and PWA resume would flash a full-screen green
 *    with the allow chime for a vehicle that left hours ago — the confident wrong green
 *    that §1 and brief §2 (position 5) exist to prevent. gate-standby.png is the
 *    intended look: the last read sits in the rail, the stage says "Waiting for vehicle".
 */

import type { Decision, EventRow } from '../../lib/types'

/** Hold/clear windows from §6.1. Milliseconds. */
export const HOLD = {
  /** allow clears this long after the last read... */
  allowAfterLastRead: 5_000,
  /** ...but never before it has been on screen this long. */
  allowMinOnScreen: 8_000,
  /** deny and check hold until the guard acts, the next vehicle arrives, or this. */
  denyCheckAfterLastRead: 15_000,
} as const

export const RAIL_SIZE = 5

export interface MachineState {
  /** Most recent first, capped at RAIL_SIZE. Includes the stage event when there is one. */
  rail: EventRow[]
  /**
   * The event on the stage, or null in standby. Drives the stage only — the rail's
   * highlight is "most recent" (index 0), which is why it survives into standby
   * (gate-standby.png still highlights the 14:32:06 read).
   */
  stageId: string | null
  /** Local ms when this event first took the stage. Feeds allowMinOnScreen. */
  stageSince: number | null
  /** Local ms of the most recent read for the staged event. Feeds every hold window. */
  stageLastReadLocal: number | null
}

export type Action =
  /** Rail backfill on connect or reconnect. Rail only, always. */
  | { type: 'hydrate'; events: EventRow[] }
  /** A Realtime INSERT or UPDATE. The same shape handles both. */
  | { type: 'event'; event: EventRow; now: number }
  /** Drives the hold/clear windows. */
  | { type: 'tick'; now: number }
  /** The guard pressed LET THROUGH / TURNED AWAY — clears deny and check at once. */
  | { type: 'guard_action' }

export type Effect = { type: 'sound'; decision: Decision }

export interface Step {
  state: MachineState
  effects: Effect[]
}

export const initialState: MachineState = {
  rail: [], stageId: null, stageSince: null, stageLastReadLocal: null,
}

/** Ordering key: `ts`, with the id as a stable tiebreak for same-millisecond inserts.
 *  Deliberately not `last_read_at` — that keeps moving while a car sits at the guard,
 *  which would make a row climb the rail long after it was read. */
function isNewer(a: EventRow, b: EventRow): boolean {
  return a.ts > b.ts || (a.ts === b.ts && a.id > b.id)
}

function sortRail(events: EventRow[]): EventRow[] {
  return [...events]
    .sort((a, b) => (isNewer(a, b) ? -1 : a.id === b.id ? 0 : 1))
    .slice(0, RAIL_SIZE)
}

/** Replace by id if present (keeping its position), otherwise prepend, then re-sort. */
function upsertRail(rail: EventRow[], event: EventRow): EventRow[] {
  const i = rail.findIndex((e) => e.id === event.id)
  if (i >= 0) {
    const next = [...rail]
    next[i] = event
    return next
  }
  return sortRail([event, ...rail])
}

/** The local ms at which the staged event should clear, or null if nothing is staged. */
export function clearAt(state: MachineState): number | null {
  if (state.stageId === null || state.stageLastReadLocal === null) return null
  const staged = state.rail.find((e) => e.id === state.stageId)
  if (!staged) return null

  if (staged.decision === 'allow') {
    return Math.max(
      state.stageLastReadLocal + HOLD.allowAfterLastRead,
      (state.stageSince ?? state.stageLastReadLocal) + HOLD.allowMinOnScreen,
    )
  }
  // deny and check hold longer — the guard has to act, or the car has to leave.
  return state.stageLastReadLocal + HOLD.denyCheckAfterLastRead
}

/** The event currently on the stage, or null in standby. */
export function stageEvent(state: MachineState): EventRow | null {
  if (state.stageId === null) return null
  return state.rail.find((e) => e.id === state.stageId) ?? null
}

export function reduce(state: MachineState, action: Action): Step {
  switch (action.type) {
    case 'hydrate': {
      // Rail only. See note 2 at the top of this file.
      return {
        state: { ...initialState, rail: sortRail(action.events) },
        effects: [],
      }
    }

    case 'event': {
      const { event, now } = action
      const current = stageEvent(state)

      // Same event again: a dedupe update (§5.3). Re-render in place — no re-entry, no
      // repeated chime, and the hold window restarts because the car is still being read.
      if (current && event.id === current.id) {
        return {
          state: {
            ...state,
            rail: upsertRail(state.rail, event),
            stageLastReadLocal: now,
          },
          // A check that has become an allow is the upgrade the guard needs to hear.
          effects: event.decision !== current.decision ? [{ type: 'sound', decision: event.decision }] : [],
        }
      }

      // Older than what is on the stage (a buffered retry landing late): rail only.
      if (current && !isNewer(event, current)) {
        return { state: { ...state, rail: upsertRail(state.rail, event) }, effects: [] }
      }

      // A new vehicle takes the stage; the previous one stays in the rail.
      return {
        state: {
          rail: upsertRail(state.rail, event),
          stageId: event.id,
          stageSince: now,
          stageLastReadLocal: now,
        },
        effects: [{ type: 'sound', decision: event.decision }],
      }
    }

    case 'tick': {
      const due = clearAt(state)
      if (due === null || action.now < due) return { state, effects: [] }
      return { state: { ...state, stageId: null, stageSince: null, stageLastReadLocal: null }, effects: [] }
    }

    case 'guard_action': {
      // §6.1: deny/check hold "until a guard action". Allow is not actionable, so a
      // stray action must not cut its minimum time on screen short.
      const staged = stageEvent(state)
      if (!staged || staged.decision === 'allow') return { state, effects: [] }
      return { state: { ...state, stageId: null, stageSince: null, stageLastReadLocal: null }, effects: [] }
    }
  }
}
