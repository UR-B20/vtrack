import { describe, it, expect } from 'vitest'
import { reduce, initialState, clearAt, stageEvent, HOLD, RAIL_SIZE } from './displayMachine'
import type { MachineState, Action } from './displayMachine'
import type { Decision, EventRow } from '../../lib/types'

/** A server timestamp `skewMs` away from the local clock, to prove the timers ignore it. */
const serverTs = (localMs: number, skewMs = 0) => new Date(localMs + skewMs).toISOString()

let seq = 0
function ev(o: Partial<EventRow> & { id?: string } = {}, localMs = 0, skewMs = 0): EventRow {
  seq += 1
  return {
    id: o.id ?? `e${seq}`,
    ts: serverTs(localMs, skewMs),
    device_id: 'cam-a', site: 'gate1', lane: 'A',
    plate_raw: null, plate_norm: 'SBA1234G', plate_kind: 'civilian',
    confidence: 0.97, checksum_ok: true, repaired_from: null,
    vehicle_id: null, decision: 'allow', reason: null,
    image_path: null, engine: 'test', latency_ms: 100,
    read_count: 1, last_read_at: serverTs(localMs, skewMs), source: 'camera',
    ...o,
  }
}

/** Run a sequence of actions from a starting state, collecting every effect. */
function run(actions: Action[], from: MachineState = initialState) {
  let state = from
  const effects = []
  for (const a of actions) {
    const step = reduce(state, a)
    state = step.state
    effects.push(...step.effects)
  }
  return { state, effects }
}

describe('hydrate — rail only, never the stage, never a chime', () => {
  it('does not stage a stale allow, however recent', () => {
    const stale = ev({ decision: 'allow' }, 0)
    const { state, effects } = run([{ type: 'hydrate', events: [stale] }])
    expect(state.stageId).toBeNull()
    expect(state.stageSince).toBeNull()
    expect(state.rail).toHaveLength(1)
    expect(effects).toEqual([])
  })

  it('does not stage a one-second-old allow either — there is no recency exception', () => {
    const fresh = ev({ decision: 'allow' }, Date.now() - 1000)
    const { state, effects } = run([{ type: 'hydrate', events: [fresh] }])
    expect(state.stageId).toBeNull()
    expect(effects).toEqual([])
  })

  it('a tick after hydrate cannot resurrect a stage', () => {
    const { state } = run([
      { type: 'hydrate', events: [ev({ decision: 'allow' }, 0)] },
      { type: 'tick', now: 10_000 },
      { type: 'tick', now: 10_000_000 },
    ])
    expect(state.stageId).toBeNull()
  })

  it('a live event after hydrate does stage and does chime', () => {
    const { state, effects } = run([
      { type: 'hydrate', events: [ev({ decision: 'deny' }, 0)] },
      { type: 'event', event: ev({ decision: 'allow' }, 1000), now: 1000 },
    ])
    expect(state.stageId).not.toBeNull()
    expect(effects).toEqual([{ type: 'sound', decision: 'allow' }])
  })

  it('re-hydrating mid-vehicle refreshes the rail without restaging or re-chiming', () => {
    const live = ev({ id: 'live', decision: 'deny' }, 1000)
    const before = run([{ type: 'event', event: live, now: 1000 }]).state
    const { state, effects } = run([{ type: 'hydrate', events: [live] }], before)
    // Reconnect backfill is unconditional: the component re-subscribes and re-dispatches.
    expect(state.stageId).toBeNull()
    expect(effects).toEqual([])
  })

  it('sorts the rail newest first and caps it at five', () => {
    const events = Array.from({ length: 8 }, (_, i) => ev({ id: `e${i}` }, i * 1000))
    const { state } = run([{ type: 'hydrate', events }])
    expect(state.rail).toHaveLength(RAIL_SIZE)
    expect(state.rail.map((e) => e.id)).toEqual(['e7', 'e6', 'e5', 'e4', 'e3'])
  })
})

describe('a vehicle arriving', () => {
  it('takes the stage and chimes its decision', () => {
    for (const d of ['allow', 'deny', 'check'] as Decision[]) {
      const { state, effects } = run([{ type: 'event', event: ev({ decision: d }, 0), now: 0 }])
      expect(stageEvent(state)?.decision).toBe(d)
      expect(effects).toEqual([{ type: 'sound', decision: d }])
    }
  })

  it('is the top of the rail as well as the stage', () => {
    const e = ev({}, 0)
    const { state } = run([{ type: 'event', event: e, now: 0 }])
    expect(state.rail[0]?.id).toBe(e.id)
    expect(state.stageId).toBe(e.id)
  })
})

describe('the same event again (dedupe, §5.3)', () => {
  const first = ev({ id: 'x', decision: 'check', confidence: 0.58, read_count: 1 }, 0)

  it('updates in place: no new rail entry, no re-entry, no chime', () => {
    const start = run([{ type: 'event', event: first, now: 0 }])
    const update = { ...first, read_count: 2, confidence: 0.71, last_read_at: serverTs(3000) }
    const { state, effects } = run([{ type: 'event', event: update, now: 3000 }], start.state)

    expect(state.rail).toHaveLength(1)
    expect(state.rail[0]?.read_count).toBe(2)
    expect(state.rail[0]?.confidence).toBe(0.71)
    expect(state.stageId).toBe('x')
    expect(state.stageSince).toBe(0)          // it never left, so its time on screen keeps running
    expect(state.stageLastReadLocal).toBe(3000)  // but the hold window restarts
    expect(effects).toEqual([])
  })

  it('chimes when a check upgrades to allow, and swaps the stage', () => {
    const start = run([{ type: 'event', event: first, now: 0 }])
    const upgraded = { ...first, decision: 'allow' as Decision, confidence: 0.96, read_count: 3 }
    const { state, effects } = run([{ type: 'event', event: upgraded, now: 4000 }], start.state)
    expect(stageEvent(state)?.decision).toBe('allow')
    expect(effects).toEqual([{ type: 'sound', decision: 'allow' }])
  })

  it('does not move the row up the rail — its clock is its ts, which has not changed', () => {
    const older = ev({ id: 'old' }, 0)
    const newer = ev({ id: 'new' }, 5000)
    const start = run([
      { type: 'event', event: older, now: 0 },
      { type: 'event', event: newer, now: 5000 },
    ])
    expect(start.state.rail.map((e) => e.id)).toEqual(['new', 'old'])

    // 'old' gets re-read while 'new' is on the stage: last_read_at advances, ts does not.
    const reread = { ...older, read_count: 2, last_read_at: serverTs(12_000) }
    const { state, effects } = run([{ type: 'event', event: reread, now: 12_000 }], start.state)
    expect(state.rail.map((e) => e.id)).toEqual(['new', 'old'])
    expect(state.rail[1]?.ts).toBe(older.ts)
    expect(state.stageId).toBe('new')
    expect(effects).toEqual([])
  })
})

describe('a second vehicle', () => {
  it('replaces the stage and pushes the first down the rail', () => {
    const a = ev({ id: 'a', decision: 'allow' }, 0)
    const b = ev({ id: 'b', decision: 'deny' }, 2000)
    const { state, effects } = run([
      { type: 'event', event: a, now: 0 },
      { type: 'event', event: b, now: 2000 },
    ])
    expect(state.stageId).toBe('b')
    expect(state.stageSince).toBe(2000)
    expect(state.rail.map((e) => e.id)).toEqual(['b', 'a'])
    expect(effects).toEqual([
      { type: 'sound', decision: 'allow' },
      { type: 'sound', decision: 'deny' },
    ])
  })

  it('an out-of-order insert goes to the rail, never the stage', () => {
    const b = ev({ id: 'b' }, 5000)
    const late = ev({ id: 'late' }, 1000)     // buffered retry, older ts
    const { state, effects } = run([
      { type: 'event', event: b, now: 5000 },
      { type: 'event', event: late, now: 6000 },
    ])
    expect(state.stageId).toBe('b')
    expect(state.stageSince).toBe(5000)
    expect(state.rail.map((e) => e.id)).toEqual(['b', 'late'])
    expect(effects).toHaveLength(1)           // only b chimed
  })
})

describe('hold and clear', () => {
  it('allow stays at least 8 s even though its read was 5 s ago', () => {
    const start = run([{ type: 'event', event: ev({ decision: 'allow' }, 0), now: 0 }])
    expect(clearAt(start.state)).toBe(HOLD.allowMinOnScreen)
    expect(reduce(start.state, { type: 'tick', now: 7_999 }).state.stageId).not.toBeNull()
    expect(reduce(start.state, { type: 'tick', now: 8_000 }).state.stageId).toBeNull()
  })

  it('allow clears 5 s after the last read once it has had its 8 s', () => {
    const e = ev({ id: 'x', decision: 'allow' }, 0)
    const start = run([
      { type: 'event', event: e, now: 0 },
      { type: 'event', event: { ...e, read_count: 2 }, now: 6_000 },   // still being read at 6 s
    ])
    expect(clearAt(start.state)).toBe(11_000)                          // 6 000 + 5 000
    expect(reduce(start.state, { type: 'tick', now: 10_999 }).state.stageId).not.toBeNull()
    expect(reduce(start.state, { type: 'tick', now: 11_000 }).state.stageId).toBeNull()
  })

  it.each(['deny', 'check'] as Decision[])('%s holds for 15 s after the last read', (d) => {
    const start = run([{ type: 'event', event: ev({ decision: d }, 0), now: 0 }])
    expect(clearAt(start.state)).toBe(HOLD.denyCheckAfterLastRead)
    expect(reduce(start.state, { type: 'tick', now: 14_999 }).state.stageId).not.toBeNull()
    expect(reduce(start.state, { type: 'tick', now: 15_000 }).state.stageId).toBeNull()
  })

  it('a car that keeps being read keeps its result on screen', () => {
    let state = run([{ type: 'event', event: ev({ id: 'x', decision: 'deny' }, 0), now: 0 }]).state
    for (let t = 3_000; t <= 60_000; t += 3_000) {
      state = reduce(state, { type: 'event', event: ev({ id: 'x', decision: 'deny' }, 0), now: t }).state
      state = reduce(state, { type: 'tick', now: t }).state
      expect(state.stageId).toBe('x')
    }
    // Then it drives off and the reads stop.
    expect(reduce(state, { type: 'tick', now: 60_000 + 15_000 }).state.stageId).toBeNull()
  })

  it('clearing leaves the rail intact — standby still shows the last read', () => {
    const start = run([{ type: 'event', event: ev({ decision: 'allow' }, 0), now: 0 }])
    const cleared = reduce(start.state, { type: 'tick', now: 20_000 }).state
    expect(cleared.stageId).toBeNull()
    expect(cleared.rail).toHaveLength(1)
  })

  it('ticking in standby is a no-op', () => {
    expect(clearAt(initialState)).toBeNull()
    const { state, effects } = run([{ type: 'tick', now: 999_999 }])
    expect(state).toEqual(initialState)
    expect(effects).toEqual([])
  })
})

describe('clock skew — the timers must ignore the server clock entirely', () => {
  for (const skew of [-60_000, 0, 60_000]) {
    it(`deny still holds exactly 15 s with a ${skew / 1000}s skew`, () => {
      // Server timestamps are an hour out in either direction; the reducer must not care.
      const e = ev({ decision: 'deny' }, 0, skew)
      const start = run([{ type: 'event', event: e, now: 0 }])
      expect(reduce(start.state, { type: 'tick', now: 14_900 }).state.stageId).not.toBeNull()
      expect(reduce(start.state, { type: 'tick', now: 15_100 }).state.stageId).toBeNull()
    })

    it(`allow still gets its 8 s with a ${skew / 1000}s skew`, () => {
      const e = ev({ decision: 'allow' }, 0, skew)
      const start = run([{ type: 'event', event: e, now: 0 }])
      expect(reduce(start.state, { type: 'tick', now: 7_900 }).state.stageId).not.toBeNull()
      expect(reduce(start.state, { type: 'tick', now: 8_100 }).state.stageId).toBeNull()
    })
  }

  it('a server timestamp far in the future does not pin the stage forever', () => {
    const e = ev({ decision: 'check' }, 0, 86_400_000)   // last_read_at a day ahead
    const start = run([{ type: 'event', event: e, now: 0 }])
    expect(reduce(start.state, { type: 'tick', now: 15_001 }).state.stageId).toBeNull()
  })
})

describe('guard actions', () => {
  it.each(['deny', 'check'] as Decision[])('clear a %s immediately', (d) => {
    const start = run([{ type: 'event', event: ev({ decision: d }, 0), now: 0 }])
    const { state } = run([{ type: 'guard_action' }], start.state)
    expect(state.stageId).toBeNull()
    expect(state.rail).toHaveLength(1)      // the audit trail stays on screen
  })

  it('do not cut an allow short', () => {
    const start = run([{ type: 'event', event: ev({ decision: 'allow' }, 0), now: 0 }])
    const { state } = run([{ type: 'guard_action' }], start.state)
    expect(state.stageId).not.toBeNull()
  })

  it('are a no-op in standby', () => {
    expect(run([{ type: 'guard_action' }]).state).toEqual(initialState)
  })
})

describe('purity', () => {
  it('never mutates the state it is given', () => {
    const before = run([{ type: 'event', event: ev({ id: 'a' }, 0), now: 0 }]).state
    const snapshot = JSON.parse(JSON.stringify(before))
    reduce(before, { type: 'event', event: ev({ id: 'b' }, 1000), now: 1000 })
    reduce(before, { type: 'tick', now: 99_999 })
    reduce(before, { type: 'guard_action' })
    expect(before).toEqual(snapshot)
  })
})
