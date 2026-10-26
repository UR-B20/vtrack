import { describe, expect, it } from 'vitest'
import { eventTime, okAt, screenFilter, sinceIso } from './events'

describe('sinceIso', () => {
  // 01:30 on 26 Oct in Singapore is still 25 Oct in UTC: "today" must follow the gate.
  const now = new Date('2026-10-25T17:30:00Z')

  it('today starts at midnight at the gate', () => {
    expect(sinceIso('today', now)).toBe('2026-10-25T16:00:00.000Z')
  })

  it('7 and 30 days include today', () => {
    expect(sinceIso('7d', now)).toBe('2026-10-19T16:00:00.000Z')
    expect(sinceIso('30d', now)).toBe('2026-09-26T16:00:00.000Z')
  })

  it('all is unbounded', () => {
    expect(sinceIso('all', now)).toBeNull()
  })
})

describe('screenFilter', () => {
  it('matches the colours the guard saw', () => {
    expect(screenFilter('allow')).toEqual({ kind: 'eq', decision: 'allow' })
    expect(screenFilter('deny')).toEqual({ kind: 'foreign' })
    expect(screenFilter('check')).toEqual({ kind: 'or', expr: 'decision.eq.check,and(decision.eq.deny,reason.neq.foreign)' })
    expect(screenFilter('all')).toEqual({ kind: 'none' })
  })
})

describe('okAt', () => {
  it('is the first OK, ignoring anything else', () => {
    expect(okAt({ guard_actions: [
      { action: 'confirmed', ts: '2026-10-26T06:00:09Z' },
      { action: 'let_through', ts: '2026-10-26T06:00:01Z' },
      { action: 'confirmed', ts: '2026-10-26T06:00:05Z' },
    ] })).toBe('2026-10-26T06:00:05Z')
    expect(okAt({ guard_actions: [] })).toBeNull()
    expect(okAt({})).toBeNull()
  })
})

describe('eventTime', () => {
  it('is in gate time', () => {
    expect(eventTime('2026-10-25T17:30:07Z')).toBe('26 Oct 01:30:07')
  })
})
