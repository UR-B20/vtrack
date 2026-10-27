import { describe, expect, it } from 'vitest'
import { thresholdRows, uptime } from './settings'

describe('thresholdRows', () => {
  it('names every threshold, its Render variable and its value', () => {
    const rows = thresholdRows({ conf_decide: 0.85, conf_check: 0.6, dedupe_s: 15 })
    expect(rows.find((r) => r.key === 'conf_decide')).toMatchObject({ env: 'CONF_DECIDE', value: '0.85' })
    expect(rows.find((r) => r.key === 'dedupe_s')?.value).toBe('15 s')
    expect(rows.find((r) => r.key === 'detector_conf')?.value).toBe('—')     // not reported
  })

  it('has rows even when the engine cannot be reached', () => {
    expect(thresholdRows(undefined).every((r) => r.value === '—')).toBe(true)
  })
})

describe('uptime', () => {
  it('reads like a duration', () => {
    expect(uptime(8)).toBe('8 s')
    expect(uptime(42 * 60)).toBe('42 min')
    expect(uptime(5 * 3600 + 12 * 60)).toBe('5 h 12 min')
    expect(uptime(3 * 86_400 + 4 * 3600)).toBe('3 d 4 h')
    expect(uptime(null)).toBe('—')
  })
})
