import { describe, it, expect } from 'vitest'
import { vehicleStatus, matchesFilter, daysBetween, todayAtGate, EXPIRING_DAYS } from './status'

const TODAY = '2026-09-09'
const v = (o: Partial<Parameters<typeof vehicleStatus>[0]> = {}) => ({
  status: 'active', valid_from: '2026-01-01', valid_until: '2026-12-31', ...o,
})

describe('vehicleStatus', () => {
  it('suspension wins over validity', () => {
    expect(vehicleStatus(v({ status: 'suspended' }), TODAY).kind).toBe('suspended')
    // Suspended AND expired is still reported as suspended — the reason the guard is
    // given must be the one that actually applies (§5.2 checks status first).
    expect(vehicleStatus(v({ status: 'suspended', valid_until: '2026-01-02' }), TODAY).kind).toBe('suspended')
    expect(vehicleStatus(v({ status: 'suspended' }), TODAY).allowed).toBe(false)
  })

  it('the last day of validity still lets the vehicle in', () => {
    const s = vehicleStatus(v({ valid_until: TODAY }), TODAY)
    expect(s.kind).toBe('expires_today')
    expect(s.label).toBe('EXPIRES TODAY')
    expect(s.daysLeft).toBe(0)
    expect(s.allowed).toBe(true)
  })

  it('the day after is expired', () => {
    const s = vehicleStatus(v({ valid_until: '2026-09-08' }), TODAY)
    expect(s.kind).toBe('expired')
    expect(s.allowed).toBe(false)
    expect(s.daysLeft).toBe(-1)
  })

  it('is not yet valid before valid_from', () => {
    const s = vehicleStatus(v({ valid_from: '2026-09-10' }), TODAY)
    expect(s.kind).toBe('not_yet_valid')
    expect(s.allowed).toBe(false)
  })

  it('labels the expiring window the way admin.png does', () => {
    expect(vehicleStatus(v({ valid_until: '2026-09-20' }), TODAY).label).toBe('EXPIRING 11 d')
  })

  it('draws the expiring boundary at exactly 30 days', () => {
    expect(vehicleStatus(v({ valid_until: '2026-10-09' }), TODAY).kind).toBe('expiring')  // 30 d
    expect(vehicleStatus(v({ valid_until: '2026-10-10' }), TODAY).kind).toBe('active')    // 31 d
    expect(EXPIRING_DAYS).toBe(30)
  })

  it('treats null dates as unbounded', () => {
    const s = vehicleStatus({ status: 'active', valid_from: null, valid_until: null }, TODAY)
    expect(s.kind).toBe('active')
    expect(s.daysLeft).toBeNull()
    expect(s.allowed).toBe(true)
  })
})

describe('the seeded rows produce exactly the badges in admin.png', () => {
  // seed.sql writes rows 5–7 relative to current_date, so these are the dates it
  // produces when the seed is run on TODAY.
  const seeded: [string, Parameters<typeof vehicleStatus>[0], string][] = [
    ['SBA1234G', v(), 'ACTIVE'],
    ['MID12345', v(), 'ACTIVE'],
    ['SNB9538E', v(), 'ACTIVE'],
    ['FBA2210T', v(), 'ACTIVE'],
    ['SGX4471M', v({ valid_until: '2026-09-20' }), 'EXPIRING 11 d'],
    ['SNB9502H', v({ valid_from: TODAY, valid_until: TODAY }), 'EXPIRES TODAY'],
    ['SNB9517R', v({ valid_from: '2026-06-01', valid_until: '2026-08-31' }), 'EXPIRED'],
    ['SLM3090J', v({ status: 'suspended' }), 'SUSPENDED'],
  ]

  it.each(seeded)('%s → %s', (_plate, row, label) => {
    expect(vehicleStatus(row, TODAY).label).toBe(label)
  })

  it('gives the counts the header and chips show', () => {
    const rows = seeded.map(([, row]) => row)
    expect(rows.filter((r) => vehicleStatus(r, TODAY).allowed).length).toBe(6)
    expect(rows.filter((r) => vehicleStatus(r, TODAY).kind === 'suspended').length).toBe(1)
    expect(rows.filter((r) => vehicleStatus(r, TODAY).kind === 'expired').length).toBe(1)
  })
})

describe('matchesFilter', () => {
  const row = (o: Record<string, unknown> = {}) => ({ ...v(), pass_type: 'permanent', ...o })

  it('All active keeps everything still good to enter today', () => {
    expect(matchesFilter(row(), 'all_active', TODAY)).toBe(true)
    expect(matchesFilter(row({ status: 'suspended' }), 'all_active', TODAY)).toBe(false)
    expect(matchesFilter(row({ valid_until: '2026-08-31' }), 'all_active', TODAY)).toBe(false)
    // Expiring today is still active today — this is the case a naive "< valid_until"
    // would wrongly hide from the guard.
    expect(matchesFilter(row({ valid_until: TODAY }), 'all_active', TODAY)).toBe(true)
  })

  it('Visitors is a pass type, not a status', () => {
    expect(matchesFilter(row({ pass_type: 'visitor' }), 'visitors', TODAY)).toBe(true)
    expect(matchesFilter(row({ pass_type: 'visitor', status: 'suspended' }), 'visitors', TODAY)).toBe(true)
    expect(matchesFilter(row({ pass_type: 'contractor' }), 'visitors', TODAY)).toBe(false)
  })

  it('Expiring covers the warning window including today, but not the already-expired', () => {
    expect(matchesFilter(row({ valid_until: '2026-09-20' }), 'expiring', TODAY)).toBe(true)
    expect(matchesFilter(row({ valid_until: TODAY }), 'expiring', TODAY)).toBe(true)
    expect(matchesFilter(row({ valid_until: '2026-08-31' }), 'expiring', TODAY)).toBe(false)
    expect(matchesFilter(row(), 'expiring', TODAY)).toBe(false)
  })

  it('Suspended is the status, never a lapsed date', () => {
    expect(matchesFilter(row({ status: 'suspended' }), 'suspended', TODAY)).toBe(true)
    expect(matchesFilter(row({ valid_until: '2026-08-31' }), 'suspended', TODAY)).toBe(false)
  })
})

describe('date helpers', () => {
  it('counts whole calendar days', () => {
    expect(daysBetween('2026-09-09', '2026-09-20')).toBe(11)
    expect(daysBetween('2026-09-09', '2026-09-09')).toBe(0)
    expect(daysBetween('2026-09-09', '2026-08-31')).toBe(-9)
  })

  it('crosses a month and a leap-year boundary correctly', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2)   // 2028 is a leap year
  })

  it('todayAtGate reads the calendar date in Singapore, not the browser', () => {
    // 23:30 UTC is already the next day at the gate (UTC+8).
    expect(todayAtGate(new Date('2026-09-09T23:30:00Z'))).toBe('2026-09-10')
    expect(todayAtGate(new Date('2026-09-09T12:00:00Z'))).toBe('2026-09-09')
  })
})
