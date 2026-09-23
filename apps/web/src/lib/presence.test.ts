import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG, SAMPLE_CELLS, SAMPLE_H, SAMPLE_W, changedFraction, initialPresence, normalise,
  outcomeOf, reduce, type Action, type Effect, type Outcome, type PresenceState,
} from './presence'
import type { RecogniseResult } from './engine'

// ── scenes: 64×36 grey thumbnails of the lane ROI ──────────────────────────────────────

/** The empty lane: tarmac with some texture. */
const EMPTY = Array.from({ length: SAMPLE_CELLS }, (_, i) => 80 + ((i * 37) % 60))

/** A vehicle: a block of the ROI replaced by its own pattern. */
function withBlock(base: number[], x0: number, y0: number, w: number, h: number, value: (i: number) => number) {
  const out = base.slice()
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out[y * SAMPLE_W + x] = value(x + y * 7)
  return out
}
const CAR_A = withBlock(EMPTY, 12, 6, 40, 26, (i) => 25 + (i % 11))            // dark car
const CAR_B = withBlock(EMPTY, 10, 5, 44, 28, (i) => 190 + ((i * 3) % 40))     // white van
const CAR_A_CREPT = withBlock(EMPTY, 13, 6, 40, 26, (i) => 25 + (i % 11))      // 1 cell forward
const BIKE = withBlock(EMPTY, 28, 10, 8, 20, () => 220)                        // ~7 % of the ROI
const BRIGHTER = (scene: number[]) => scene.map((v) => Math.min(255, v * 1.4))
/** Floodlights on: a pool of light over part of the lane, not a vehicle. */
const FLOODLIT = withBlock(EMPTY, 0, 20, 64, 16, (i) => 200 + (i % 20))

const T = 250 // ms between samples (about 4 Hz)

class Rig {
  state: PresenceState
  now = 0
  captures: { session: number; n: number; at: number }[] = []
  effects: Effect[] = []

  constructor(state = initialPresence()) {
    this.state = state
  }

  private apply(a: Action) {
    const step = reduce(this.state, a, DEFAULT_CONFIG)
    this.state = step.state
    for (const e of step.effects) {
      this.effects.push(e)
      if (e.type === 'capture') this.captures.push({ session: e.session, n: e.n, at: this.now })
    }
  }

  /** Feed `scene` for `ms`. If `answer` is given, every capture is answered at once. */
  hold(scene: number[], ms: number, answer?: Outcome) {
    const end = this.now + ms
    while (this.now < end) {
      const before = this.captures.length
      this.apply({ type: 'sample', grey: scene, now: this.now })
      if (answer && this.captures.length > before) {
        const c = this.captures[this.captures.length - 1]!
        this.apply({ type: 'result', session: c.session, outcome: answer, now: this.now })
      }
      this.now += T
    }
    return this
  }

  answer(outcome: Outcome) {
    const c = this.captures[this.captures.length - 1]!
    this.apply({ type: 'result', session: c.session, outcome, now: this.now })
    return this
  }

  send(a: Action) {
    this.apply(a)
    return this
  }

  sessionsStarted() {
    return new Set(this.captures.map((c) => c.session)).size
  }
}

/** A rig whose lane is calibrated empty. */
const calibrated = () => new Rig().hold(EMPTY, 2_500)

// ── the picture maths ─────────────────────────────────────────────────────────────────

describe('the picture maths', () => {
  it('ignores a change of exposure across the whole picture', () => {
    expect(changedFraction(normalise(EMPTY), normalise(BRIGHTER(EMPTY)), DEFAULT_CONFIG.cellT)).toBe(0)
  })

  it('sees a motorcycle, which covers only a small part of the ROI', () => {
    const f = changedFraction(normalise(EMPTY), normalise(BIKE), DEFAULT_CONFIG.cellT)
    expect(f).toBeGreaterThan(DEFAULT_CONFIG.presenceFrac)
    expect(f).toBeLessThan(0.15)
  })

  it('samples are 64 × 36', () => {
    expect(SAMPLE_CELLS).toBe(SAMPLE_W * SAMPLE_H)
    expect(EMPTY).toHaveLength(2304)
  })
})

// ── calibration ───────────────────────────────────────────────────────────────────────

describe('calibration: nothing is sent until the lane has been seen empty', () => {
  it('takes the first still scene as the empty lane, and sends nothing meanwhile', () => {
    const r = new Rig().hold(EMPTY, 1_500)
    expect(r.state.lane).toBe('calibrating')
    r.hold(EMPTY, 1_000)
    expect(r.state.lane).toBe('empty')
    expect(r.captures).toHaveLength(0)
  })

  it('a reload with a car in the lane reads it, from the stored background', () => {
    const stored = normalise(EMPTY)
    const r = new Rig(initialPresence(stored)).hold(CAR_A, 1_000)
    expect(r.state.lane).toBe('present')
    expect(r.captures.length).toBeGreaterThan(0)
  })

  it('with no stored background, a car there at the very first start is taken as the lane', () => {
    // Documented limit (presence.ts, decision 3): that car is read with TAP.
    const r = new Rig().hold(CAR_A, 4_000)
    expect(r.state.lane).toBe('empty')
    expect(r.captures).toHaveLength(0)
  })

  it('the operator can re-calibrate on the scene now in view', () => {
    const r = calibrated().hold(FLOODLIT, 500)
    r.send({ type: 'calibrate' })
    expect(r.state.lane).toBe('empty')
    r.hold(FLOODLIT, 1_000)
    expect(r.state.lane).toBe('empty')
  })

  it('restores a stored background for this ROI, keeping session numbers unique', () => {
    const r = calibrated().hold(CAR_A, 1_000, 'confident')
    const used = r.state.nextSessionId
    r.send({ type: 'restore', background: normalise(EMPTY) })
    expect(r.state.lane).toBe('empty')
    expect(r.state.nextSessionId).toBe(used)
  })

  it('a stored background of the wrong size is ignored: calibrate instead', () => {
    expect(initialPresence(new Float32Array(10)).lane).toBe('calibrating')
  })

  it('moving the ROI starts calibration again', () => {
    const r = calibrated().send({ type: 'reset' })
    expect(r.state.lane).toBe('calibrating')
    expect(r.state.background).toBeNull()
  })
})

// ── a vehicle ─────────────────────────────────────────────────────────────────────────

describe('a vehicle arriving and stopping', () => {
  it('sends the first frame once it is still, then bursts at 2 frames/s for 3 s, then 1 every 2 s', () => {
    const r = calibrated()
    const arrived = r.now
    r.hold(CAR_A, 10_000, 'unsure')
    const at = r.captures.map((c) => c.at - arrived)
    expect(at[0]).toBe(250)                      // the second sample: the first one moved
    const gaps = at.slice(1).map((t, i) => t - at[i]!)
    // 2 frames/s for 3 s is six frames: five 500 ms gaps, then one every 2 s.
    expect(gaps.slice(0, 5)).toEqual([500, 500, 500, 500, 500])
    expect(gaps.slice(5, 8)).toEqual([2000, 2000, 2000])
  })

  it('waits at most 1 s for the vehicle to stop moving', () => {
    const r = calibrated()
    const arrived = r.now
    // Two very different pictures in turn: present, and never still.
    for (let i = 0; i < 8; i++) r.hold(i % 2 ? CAR_A : CAR_B, T)
    expect(r.captures[0]!.at - arrived).toBe(1_000)
  })

  it('stops on a confident answer', () => {
    const r = calibrated().hold(CAR_A, 20_000, 'confident')
    expect(r.captures).toHaveLength(1)
    expect(r.state.session?.done).toBe('confident')
  })

  it('never sends more than 12 frames for one vehicle', () => {
    const r = calibrated().hold(CAR_A, 60_000, 'unsure')
    expect(r.captures).toHaveLength(12)
    expect(r.state.session?.done).toBe('cap')
  })

  it('a repaired or VERIFY read keeps sending; a CHECK keeps sending', () => {
    const base: RecogniseResult = { event_id: 'e', decision: 'allow', reason: null, plate_norm: 'SNB9538E', latency_ms: 1, deduped: false }
    expect(outcomeOf(base)).toBe('confident')
    expect(outcomeOf({ ...base, decision: 'deny' })).toBe('confident')
    expect(outcomeOf({ ...base, repaired_from: 'SNB953BE' })).toBe('unsure')
    expect(outcomeOf({ ...base, flags: { verify: true } })).toBe('unsure')
    expect(outcomeOf({ ...base, decision: 'check' })).toBe('unsure')
    expect(outcomeOf({ ...base, decision: null, rejected: 'multiple_plates' })).toBe('rejected')
    expect(outcomeOf({ ...base, decision: null })).toBe('no_plate')
  })

  it('keeps one frame in flight at most', () => {
    const r = calibrated().hold(CAR_A, 5_000)   // never answered
    expect(r.captures).toHaveLength(1)
    r.answer('unsure').hold(CAR_A, 300)
    expect(r.captures).toHaveLength(2)
  })

  it('a failed send does not use up the vehicle\'s frames', () => {
    const r = calibrated().hold(CAR_A, 1_000, 'failed')
    expect(r.state.session?.sent).toBe(0)
    expect(r.state.session?.failures).toBeGreaterThan(0)
  })

  it('failures have their own cap', () => {
    const r = calibrated().hold(CAR_A, 60_000, 'failed')
    expect(r.state.session?.done).toBe('failures')
    expect(r.captures).toHaveLength(DEFAULT_CONFIG.maxFailures)
  })

  it('a frame stuck in flight is given up after 15 s', () => {
    const r = calibrated().hold(CAR_A, 16_000)
    expect(r.captures).toHaveLength(2)
  })

  it('a motorcycle is a vehicle', () => {
    const r = calibrated().hold(BIKE, 1_000)
    expect(r.state.lane).toBe('present')
    expect(r.captures).toHaveLength(1)
  })

  it('a change of exposure is not a vehicle', () => {
    const r = calibrated().hold(BRIGHTER(EMPTY), 5_000)
    expect(r.state.lane).toBe('empty')
    expect(r.captures).toHaveLength(0)
  })

  it('in TAP mode it tracks the lane but sends nothing', () => {
    const r = calibrated().send({ type: 'auto', on: false }).hold(CAR_A, 3_000)
    expect(r.state.lane).toBe('present')
    expect(r.captures).toHaveLength(0)
  })
})

// ── leaving ─────────────────────────────────────────────────────────────────────────

describe('the vehicle leaving', () => {
  it('ends the session after 3 s empty, not before', () => {
    const r = calibrated().hold(CAR_A, 2_000, 'confident').hold(EMPTY, 2_500)
    expect(r.state.lane).toBe('present')
    r.hold(EMPTY, 750)
    expect(r.state.lane).toBe('empty')
    expect(r.state.session).toBeNull()
  })

  it('the next vehicle after an empty lane gets its own session', () => {
    const r = calibrated().hold(CAR_A, 2_000, 'confident').hold(EMPTY, 4_000).hold(CAR_B, 2_000, 'confident')
    expect(r.sessionsStarted()).toBe(2)
  })

  it('a late answer for a vehicle that has gone changes nothing', () => {
    const r = calibrated().hold(CAR_A, 300)          // one frame in flight
    const first = r.captures[0]!.session
    r.hold(EMPTY, 4_000).hold(CAR_B, 300)
    r.send({ type: 'result', session: first, outcome: 'confident', now: r.now })
    expect(r.state.session?.done).toBeNull()
  })
})

// ── nose to tail ──────────────────────────────────────────────────────────────────────

describe('queued cars: the lane is never empty between them', () => {
  it('a new car pulling in within half a second starts a new session', () => {
    const r = calibrated().hold(CAR_A, 2_000, 'confident')
    // Car A pulls away and car B rolls straight in: moving pictures, never the empty lane.
    r.hold(CAR_A_CREPT, T).hold(CAR_B, T).hold(CAR_A, T).hold(CAR_B, T)
    r.hold(CAR_B, 2_000, 'confident')
    expect(r.sessionsStarted()).toBe(2)
    expect(r.state.session?.done).toBe('confident')
  })

  it('the same car creeping forward does not', () => {
    const r = calibrated().hold(CAR_A, 2_000, 'confident')
    r.hold(CAR_A_CREPT, T).hold(CAR_A, T).hold(CAR_A_CREPT, 2_000, 'confident')
    expect(r.sessionsStarted()).toBe(1)
  })

  it('a queued car pulling in while the first is still unresolved gets its own session', () => {
    // Car A is never read confidently; car B pulls in behind it before A's frames run out.
    const r = calibrated().hold(CAR_A, 4_000, 'unsure')
    const aFrames = r.captures.length
    expect(aFrames).toBeLessThan(12)
    r.hold(CAR_A_CREPT, T).hold(CAR_B, T).hold(CAR_A, T).hold(CAR_B, T)
    r.hold(CAR_B, 30_000, 'unsure')
    expect(r.sessionsStarted()).toBe(2)
    expect(r.captures.filter((c) => c.session === r.captures.at(-1)!.session)).toHaveLength(12)
  })

  it('a vehicle leaving into an empty lane does not start a session', () => {
    // Found by the browser test: after the cap, the car driving off looked like a change.
    const r = calibrated().hold(CAR_B, 40_000, 'unsure')
    expect(r.captures).toHaveLength(12)
    r.hold(CAR_A, T).hold(CAR_B, T).hold(EMPTY, 5_000, 'unsure')
    expect(r.captures).toHaveLength(12)
    expect(r.state.lane).toBe('empty')
  })

  it('a queued car after the 12-frame cap still gets its frames', () => {
    const r = calibrated().hold(CAR_A, 60_000, 'unsure')
    expect(r.captures).toHaveLength(12)
    r.hold(CAR_B, T).hold(CAR_A, T).hold(CAR_B, 2_000, 'confident')
    expect(r.sessionsStarted()).toBe(2)
  })
})

// ── lighting ──────────────────────────────────────────────────────────────────────────

describe('lighting guard', () => {
  it('floodlights coming on re-baseline after 60 s with no plate', () => {
    const r = calibrated().hold(FLOODLIT, 61_000, 'no_plate')
    expect(r.effects).toContainEqual({ type: 'rebaselined', why: 'lighting' })
    expect(r.state.lane).toBe('empty')
    expect(r.captures).toHaveLength(12)
    // ...and a real vehicle still registers against the new background.
    const before = r.captures.length
    r.hold(CAR_A, 1_000)
    expect(r.captures.length).toBeGreaterThan(before)
  })

  it('never re-baselines on a vehicle whose plate was seen', () => {
    const r = calibrated().hold(CAR_A, 90_000, 'confident')
    expect(r.effects.some((e) => e.type === 'rebaselined')).toBe(false)
    expect(r.state.lane).toBe('present')
  })

  it('a car that became the background is noticed when it leaves', () => {
    // A dirty plate is never read, so after 60 s the parked car is the background...
    const r = calibrated().hold(CAR_A, 61_000, 'no_plate')
    expect(r.state.lane).toBe('empty')
    // ...and the lane changing when it drives off is presence again: at most 12 frames of an
    // empty lane, then the lighting guard settles it.
    const before = r.captures.length
    r.hold(EMPTY, 3_000, 'no_plate')
    expect(r.state.lane).toBe('present')
    expect(r.captures.length - before).toBeGreaterThan(0)
    r.hold(EMPTY, 60_000, 'no_plate')
    expect(r.state.lane).toBe('empty')
    expect(r.captures.length - before).toBeLessThanOrEqual(12)
  })
})
