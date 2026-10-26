import { describe, expect, it } from 'vitest'
import { ago, seenState, takesToken } from './devices'

const NOW = Date.parse('2026-10-26T08:00:00Z')
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

describe('seenState', () => {
  it('a camera is online within 30 s of its last report', () => {
    expect(seenState({ role: 'capture', last_seen_at: at(12) }, NOW)).toBe('online')
    expect(seenState({ role: 'capture', last_seen_at: at(31) }, NOW)).toBe('offline')
    expect(seenState({ role: 'capture', last_seen_at: null }, NOW)).toBe('never')
  })

  it('the engine reports every 10 minutes, so it gets longer', () => {
    expect(seenState({ role: 'engine', last_seen_at: at(11 * 60) }, NOW)).toBe('online')
    expect(seenState({ role: 'engine', last_seen_at: at(26 * 60) }, NOW)).toBe('offline')
  })

  it('the display never reports — it only listens', () => {
    expect(seenState({ role: 'display', last_seen_at: null }, NOW)).toBe('not_reported')
  })
})

describe('ago', () => {
  it('reads like a person would say it', () => {
    expect(ago(at(12), NOW)).toBe('12 s ago')
    expect(ago(at(4 * 60), NOW)).toBe('4 min ago')
    expect(ago(at(3 * 3600), NOW)).toBe('3 h ago')
    expect(ago(at(2 * 86_400), NOW)).toBe('2 d ago')
    expect(ago(null, NOW)).toBe('—')
  })
})

describe('takesToken', () => {
  it('only the camera', () => {
    expect(takesToken({ role: 'capture' })).toBe(true)
    expect(takesToken({ role: 'display' })).toBe(false)
    expect(takesToken({ role: 'engine' })).toBe(false)
  })
})
