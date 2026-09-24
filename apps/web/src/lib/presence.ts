/**
 * presence.ts — when the camera at point A sends a frame (CLAUDE.md §6.2). Pure.
 *
 * Every vehicle STOPS at the guard, so motion alone would read it once and then go quiet
 * while it sits there unread. The machine therefore tracks two things in the lane ROI:
 *
 *   present — the lane differs from a reference picture of it EMPTY (the background);
 *   moving  — this sample differs from the previous one.
 *
 * and turns them into "send a frame now" effects:
 *
 *   lane empty ──vehicle──▶ SESSION: first frame once it is still (or after 1 s), a burst at
 *   2 frames/s for 3 s, then 1 frame every 2 s — until a CONFIDENT allow/deny comes back or
 *   12 frames have gone. The session ends when the lane has been empty for 3 s.
 *
 * Input is a 64×36 grey thumbnail of the ROI, about four a second. Like displayMachine.ts
 * this is a reducer over values — no canvas, no clock, no React — and every rule below has a
 * test in presence.test.ts.
 *
 * ── Decisions worth knowing before changing anything ──
 *
 * 1. EACH SAMPLE IS DIVIDED BY ITS OWN MEAN, and a cell counts as changed only past a
 *    relative threshold. The tablet's auto-exposure, headlights sweeping the lane and dusk
 *    change the whole picture's brightness; none of them is a vehicle.
 * 2. PRESENT IS A FRACTION OF CELLS, not a mean difference. A motorcycle covers a small part
 *    of the ROI; averaged over the whole ROI it would vanish.
 * 3. NOTHING IS SENT UNTIL THE LANE HAS BEEN SEEN EMPTY. On start the machine is
 *    `calibrating`: the first still scene becomes the background. A background from an
 *    earlier run of the page is used when it exists, so a reload with a car in the lane
 *    still reads that car. (With no stored background, a car there at the very first start
 *    becomes the background: TAP reads it.)
 * 4. A QUEUED CAR GETS ITS OWN SESSION. Traffic can be nose to tail, so the lane may never
 *    be empty between two vehicles. Each time the lane settles, the still picture is kept;
 *    movement followed by a new still picture that differs from it — with a vehicle still
 *    in the lane — is a different vehicle, and starts a new session, whether or not the
 *    last one had finished. A car creeping forward a little does not; a car leaving into an
 *    empty lane does not.
 * 4a. ...AND A LOOKALIKE IS TOLD APART BY ITS PLATE (24 Sep 2026). Two cars of the same model
 *    and colour, or a printed plate swapped for another in the same hand, differ only in
 *    the plate: far less of the ROI than decision 4 needs. So when a vehicle is done and the
 *    lane settles again after moving, with anything visibly changed, ONE frame is sent to
 *    re-read it. The same plate (or none) is the same vehicle; a different plate is a new
 *    one, and that frame was its first. The re-read counts towards the vehicle's 12, and
 *    carries `seen` — the plate already answered for since the lane was last empty — so
 *    the engine never writes the same car again (dedupe.py `seen_plate`).
 * 5. LIGHTING GUARD. "Present" for 60 s with no plate ever seen re-baselines: floodlights
 *    switching on at dusk would otherwise look like a vehicle that never leaves.
 * 6. ONE FRAME IN FLIGHT, and a failed send does not count towards the 12: a mobile-data
 *    drop must not use up the vehicle's frames. Failures have their own cap.
 */

import type { RecogniseResult } from './engine'

export const SAMPLE_W = 64
export const SAMPLE_H = 36
export const SAMPLE_CELLS = SAMPLE_W * SAMPLE_H

export interface PresenceConfig {
  /** A cell has changed when its mean-normalised brightness differs by more than this. */
  cellT: number
  /** Present: at least this fraction of cells differ from the empty-lane background. */
  presenceFrac: number
  /** Moving: at least this fraction of cells differ from the previous sample. */
  motionFrac: number
  /** Still this long at start → that scene is the empty lane. */
  calibrateStillMs: number
  /** Not present for this long → the vehicle has gone; the session ends (§6.2: 3 s). */
  emptyHoldMs: number
  /** The first frame goes when the vehicle is still, or this long after it arrived. */
  firstFrameMaxWaitMs: number
  /** §6.2: a burst at 2 frames/s for 3 s... */
  burstMs: number
  burstEveryMs: number
  /** ...then one frame every 2 s while there is no confident answer. */
  slowEveryMs: number
  /** §6.2: at most 12 frames per vehicle. */
  maxFrames: number
  /** Failed sends do not count towards maxFrames; they have their own cap. */
  maxFailures: number
  /** Present this long with no plate ever seen → re-baseline (lighting guard). */
  lightingMs: number
  /** How fast the background follows an empty, still lane (0–1 per sample). */
  bgAlpha: number
  /** A queued car must be still this long before it starts a new session. */
  rearmStillMs: number
  /** A frame in flight longer than this is treated as failed. */
  inFlightTimeoutMs: number
  /** Decision 4a: a done vehicle is re-read when the settled lane differs by more than this.
   *  Small: a plate is about 1 % of the ROI's cells. */
  recheckFrac: number
}

export const DEFAULT_CONFIG: PresenceConfig = {
  cellT: 0.12,
  presenceFrac: 0.06,
  motionFrac: 0.03,
  calibrateStillMs: 2_000,
  emptyHoldMs: 3_000,
  firstFrameMaxWaitMs: 1_000,
  burstMs: 3_000,
  burstEveryMs: 500,
  slowEveryMs: 2_000,
  maxFrames: 12,
  maxFailures: 12,
  lightingMs: 60_000,
  bgAlpha: 0.05,
  rearmStillMs: 500,
  inFlightTimeoutMs: 15_000,
  recheckFrac: 0.005,
}

export type Lane = 'calibrating' | 'empty' | 'present'

/** What came back for one frame, as far as sending more is concerned. */
export type Outcome =
  /** allow or deny, not VERIFY, not REPAIRED: stop sending. */
  | 'confident'
  /** a decision that is not confident (check, verify, repaired): keep sending. */
  | 'unsure'
  /** plates were seen but not read (edge, size, several): keep sending. */
  | 'rejected'
  | 'no_plate'
  /** the request failed: it does not count towards maxFrames. */
  | 'failed'

export interface Session {
  id: number
  startedAt: number
  /** Frames sent and not failed — what maxFrames caps. */
  sent: number
  failures: number
  firstSentAt: number | null
  lastSentAt: number | null
  done: 'confident' | 'cap' | 'failures' | null
  /** A done vehicle's re-read (decision 4a) is in flight. */
  rechecking: boolean
}

export interface PresenceState {
  lane: Lane
  auto: boolean
  background: Float32Array | null
  prev: Float32Array | null
  stillSince: number | null
  presentSince: number | null
  /** When the lane last stopped looking present, while a vehicle was there. */
  absentSince: number | null
  session: Session | null
  nextSessionId: number
  /** The session whose frame is in flight, and since when. */
  inFlight: { session: number; since: number } | null
  /** The lane's last still picture, and whether it has moved since (decision 4). */
  settled: Float32Array | null
  movedSinceSettled: boolean
  plateSeenAt: number | null
  /** The plate of the last confident answer since the lane was last empty (decision 4a). */
  seen: string | null
  /** Numbers every capture effect, so the component sends each exactly once. */
  nextCaptureId: number
  /** For the ?dev=1 overlay. */
  presenceLevel: number
  motionLevel: number
}

export type Action =
  | { type: 'sample'; grey: ArrayLike<number>; now: number }
  /** `plate`: the plate_norm the engine answered with, if any. */
  | { type: 'result'; session: number; outcome: Outcome; plate?: string | null; now: number }
  /** The operator says the lane is empty now. */
  | { type: 'calibrate' }
  /** The ROI moved: the background no longer describes it. */
  | { type: 'reset' }
  /** Start over with a background stored by an earlier run for this ROI (or none). */
  | { type: 'restore'; background: Float32Array | null }
  | { type: 'auto'; on: boolean }

export type Effect =
  /** Grab the current frame and send it for this session. `n` counts from 1; `id` is unique;
   *  `seen` goes to the engine as `seen_plate`. */
  | { type: 'capture'; id: number; session: number; n: number; seen: string | null }
  | { type: 'rebaselined'; why: 'lighting' | 'operator' }

export interface Step {
  state: PresenceState
  effects: Effect[]
}

export function initialPresence(background: Float32Array | null = null, auto = true): PresenceState {
  const bg = background && background.length === SAMPLE_CELLS ? background : null
  return {
    lane: bg ? 'empty' : 'calibrating',
    auto,
    background: bg,
    prev: null,
    stillSince: null,
    presentSince: null,
    absentSince: null,
    session: null,
    nextSessionId: 1,
    inFlight: null,
    settled: null,
    movedSinceSettled: false,
    plateSeenAt: null,
    seen: null,
    nextCaptureId: 1,
    presenceLevel: 0,
    motionLevel: 0,
  }
}

// ── the picture maths ─────────────────────────────────────────────────────────────────

/** Divide by the mean, damped so a near-black night frame does not amplify noise. */
export function normalise(grey: ArrayLike<number>): Float32Array {
  const n = grey.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += grey[i]!
  const mean = n ? sum / n : 0
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (grey[i]! + 16) / (mean + 16)
  return out
}

/** The fraction of cells whose normalised brightness differs by more than `cellT`. */
export function changedFraction(a: Float32Array, b: Float32Array, cellT: number): number {
  const n = Math.min(a.length, b.length)
  if (!n) return 0
  let changed = 0
  for (let i = 0; i < n; i++) if (Math.abs(a[i]! - b[i]!) > cellT) changed++
  return changed / n
}

function blend(bg: Float32Array, cur: Float32Array, alpha: number): Float32Array {
  const out = new Float32Array(bg.length)
  for (let i = 0; i < bg.length; i++) out[i] = bg[i]! + (cur[i]! - bg[i]!) * alpha
  return out
}

/** How an engine answer counts for sending more (§6.2: stop on a CONFIDENT allow/deny). */
export function outcomeOf(r: RecogniseResult): Outcome {
  if (!r.decision) return r.rejected ? 'rejected' : 'no_plate'
  const decided = r.decision === 'allow' || r.decision === 'deny'
  return decided && !r.flags?.verify && !r.repaired_from ? 'confident' : 'unsure'
}

// ── the reducer ─────────────────────────────────────────────────────────────────────

export function reduce(state: PresenceState, action: Action, cfg: PresenceConfig = DEFAULT_CONFIG): Step {
  switch (action.type) {
    case 'auto':
      return { state: { ...state, auto: action.on }, effects: [] }
    case 'reset':
      return { state: { ...initialPresence(null, state.auto), ...counters(state) }, effects: [] }
    case 'restore':
      return { state: { ...initialPresence(action.background, state.auto), ...counters(state) }, effects: [] }
    case 'calibrate': {
      if (!state.prev) return { state: { ...state, lane: 'calibrating', background: null }, effects: [] }
      return {
        state: clearVehicle({ ...state, background: state.prev.slice(), lane: 'empty' }),
        effects: [{ type: 'rebaselined', why: 'operator' }],
      }
    }
    case 'result':
      return onResult(state, action.session, action.outcome, action.plate ?? null, action.now, cfg)
    case 'sample':
      return onSample(state, normalise(action.grey), action.now, cfg)
  }
}

/** Numbers that stay unique across a reset, so an old answer never lands on a new session. */
function counters(s: PresenceState) {
  return { nextSessionId: s.nextSessionId, nextCaptureId: s.nextCaptureId }
}

function clearVehicle(s: PresenceState): PresenceState {
  return {
    ...s, session: null, settled: null, movedSinceSettled: false, presentSince: null, absentSince: null, seen: null,
  }
}

function startSession(s: PresenceState, now: number): PresenceState {
  return {
    ...s,
    session: {
      id: s.nextSessionId, startedAt: now, sent: 0, failures: 0, firstSentAt: null, lastSentAt: null,
      done: null, rechecking: false,
    },
    nextSessionId: s.nextSessionId + 1,
    settled: null,
    movedSinceSettled: false,
  }
}

function finish(s: PresenceState, done: Session['done']): PresenceState {
  if (!s.session) return s
  return { ...s, session: { ...s.session, done } }
}

function onResult(
  s: PresenceState, session: number, outcome: Outcome, plate: string | null, now: number, cfg: PresenceConfig,
): Step {
  let next: PresenceState = s.inFlight?.session === session ? { ...s, inFlight: null } : s
  if (outcome === 'confident' || outcome === 'unsure' || outcome === 'rejected') next = { ...next, plateSeenAt: now }
  const cur = next.session
  // A late answer for a vehicle that has gone changes nothing else.
  if (!cur || cur.id !== session) return { state: next, effects: [] }
  if (cur.rechecking) return { state: onRecheck(next, cur, outcome, plate, now), effects: [] }
  if (cur.done) return { state: next, effects: [] }
  if (outcome === 'failed') {
    const failures = cur.failures + 1
    next = { ...next, session: { ...cur, sent: Math.max(0, cur.sent - 1), failures } }
    if (failures >= cfg.maxFailures) next = finish(next, 'failures')
    return { state: next, effects: [] }
  }
  if (outcome === 'confident') return { state: finish({ ...next, seen: plate ?? next.seen }, 'confident'), effects: [] }
  if (cur.sent >= cfg.maxFrames) return { state: finish(next, 'cap'), effects: [] }
  return { state: next, effects: [] }
}

/** Decision 4a: the answer to a done vehicle's re-read. */
function onRecheck(s: PresenceState, cur: Session, outcome: Outcome, plate: string | null, now: number): PresenceState {
  const settled: Session = { ...cur, rechecking: false }
  if (outcome === 'failed') return { ...s, session: { ...settled, sent: Math.max(0, cur.sent - 1) } }
  const decided = outcome === 'confident' || outcome === 'unsure'
  // The same plate, or no plate: still the vehicle that was answered for.
  if (!decided || !plate || plate === s.seen) return { ...s, session: settled }
  // A different plate: a different vehicle, and this frame was its first.
  const next = startSession({ ...s, presentSince: now }, now)
  next.session = { ...next.session!, sent: 1, firstSentAt: now, lastSentAt: now }
  return outcome === 'confident' ? finish({ ...next, seen: plate }, 'confident') : next
}

function onSample(s0: PresenceState, cur: Float32Array, now: number, cfg: PresenceConfig): Step {
  const effects: Effect[] = []
  let s: PresenceState = { ...s0 }
  let recheck = false

  // A frame stuck in flight must not freeze the lane.
  if (s.inFlight && now - s.inFlight.since >= cfg.inFlightTimeoutMs) {
    const stuck = s.inFlight.session
    s = onResult(s, stuck, 'failed', null, now, cfg).state
  }

  const motionLevel = s.prev ? changedFraction(cur, s.prev, cfg.cellT) : 0
  const moving = motionLevel > cfg.motionFrac
  s.motionLevel = motionLevel
  s.prev = cur
  s.stillSince = moving ? null : (s.stillSince ?? now)
  const stillFor = s.stillSince === null ? 0 : now - s.stillSince

  // ── calibrating: the first still scene is the empty lane ──
  if (s.lane === 'calibrating' || !s.background) {
    s.presenceLevel = 0
    if (stillFor >= cfg.calibrateStillMs) {
      s = { ...s, background: cur.slice(), lane: 'empty' }
    } else {
      s.lane = 'calibrating'
    }
    return { state: s, effects }
  }

  const presenceLevel = changedFraction(cur, s.background, cfg.cellT)
  s.presenceLevel = presenceLevel

  if (s.lane === 'empty') {
    if (presenceLevel > cfg.presenceFrac) {
      s = { ...s, lane: 'present', presentSince: now, absentSince: null }
      s = startSession(s, now)
    } else if (!moving) {
      s.background = blend(s.background, cur, cfg.bgAlpha)
    }
  } else {
    // ── present ──
    // Hysteresis: a vehicle half out of the ROI is still there.
    if (presenceLevel < cfg.presenceFrac / 2) {
      s.absentSince = s.absentSince ?? now
      if (now - s.absentSince >= cfg.emptyHoldMs) {
        return { state: clearVehicle({ ...s, lane: 'empty' }), effects }
      }
    } else {
      s.absentSince = null
    }

    // Lighting guard: long "present", never a plate, and nothing moving.
    const plateThisVisit = s.plateSeenAt !== null && s.presentSince !== null && s.plateSeenAt >= s.presentSince
    if (s.presentSince !== null && now - s.presentSince >= cfg.lightingMs && !plateThisVisit && !moving && !s.inFlight) {
      effects.push({ type: 'rebaselined', why: 'lighting' })
      return { state: clearVehicle({ ...s, background: cur.slice(), lane: 'empty' }), effects }
    }

    if (!s.session) s = startSession(s, now)

    // Decision 4: a different vehicle settling in the lane is a new session.
    if (moving) s.movedSinceSettled = true
    if (!moving && stillFor >= cfg.rearmStillMs) {
      const sess = s.session
      const handled = sess && (sess.done || sess.sent > 0)
      if (s.settled && s.movedSinceSettled && handled && presenceLevel > cfg.presenceFrac) {
        const change = changedFraction(cur, s.settled, cfg.cellT)
        if (change > cfg.presenceFrac) {
          s = startSession(s, now)
          s.presentSince = now
        } else if (sess.done && change > cfg.recheckFrac) {
          recheck = true      // decision 4a
        }
      }
      s.settled = cur
      s.movedSinceSettled = false
    }
  }

  // ── sending ──
  const sess = s.session
  if (recheck && s.auto && s.lane === 'present' && sess?.done && !s.inFlight && sess.sent < cfg.maxFrames) {
    const n = sess.sent + 1
    s.session = { ...sess, sent: n, lastSentAt: now, rechecking: true }
    s.inFlight = { session: sess.id, since: now }
    effects.push(capture(s, sess.id, n))
  } else if (s.auto && s.lane === 'present' && sess && !sess.done && !s.inFlight) {
    let due: boolean
    if (sess.firstSentAt === null) {
      due = !moving || now - sess.startedAt >= cfg.firstFrameMaxWaitMs
    } else {
      const every = now - sess.firstSentAt < cfg.burstMs ? cfg.burstEveryMs : cfg.slowEveryMs
      due = sess.lastSentAt === null || now - sess.lastSentAt >= every
    }
    if (due && sess.sent < cfg.maxFrames) {
      const n = sess.sent + 1
      s.session = { ...sess, sent: n, firstSentAt: sess.firstSentAt ?? now, lastSentAt: now }
      s.inFlight = { session: sess.id, since: now }
      effects.push(capture(s, sess.id, n))
    }
  }
  return { state: s, effects }
}

/** A capture effect, numbered from the state (which it advances). */
function capture(s: PresenceState, session: number, n: number): Effect {
  const id = s.nextCaptureId
  s.nextCaptureId = id + 1
  return { type: 'capture', id, session, n, seen: s.seen }
}

/** Frames sent for the current vehicle, for the chip ("3/12"). */
export function framesSent(s: PresenceState): number {
  return s.session?.sent ?? 0
}
