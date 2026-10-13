import { describe, expect, it } from 'vitest'
import { allowDetail, screenLine, toneOf } from './screen'
import type { EventRow, VehiclePublic } from '../../lib/types'

const TAN: VehiclePublic = {
  plate_norm: 'SBA1234G', plate_display: 'SBA 1234 G', owner_name: 'Tan Wei Ming', org_unit: 'HQ Coy',
  pass_type: 'permanent', status: 'active', valid_from: '2026-01-01', valid_until: '2026-12-31',
}

describe('the line under PROCEED (gate-allowed.png)', () => {
  it('names the owner, unit, pass and validity', () => {
    expect(allowDetail(TAN, '2026-09-24')).toBe('Tan Wei Ming · HQ Coy · Permanent pass · valid to 31 Dec 2026')
  })

  it('a visitor whose pass ends today', () => {
    const priya = { ...TAN, owner_name: 'Priya Nair', org_unit: null, pass_type: 'visitor' as const, valid_until: '2026-09-24' }
    expect(allowDetail(priya, '2026-09-24')).toBe('Priya Nair · Visitor pass · valid today')
  })

  it('leaves out what the row does not have', () => {
    expect(allowDetail({ ...TAN, org_unit: null, valid_until: null }, '2026-09-24')).toBe('Tan Wei Ming · Permanent pass')
  })

  it('with no list row to hand, says only what is known', () => {
    expect(allowDetail(null, '2026-09-24')).toBe('On the approved list')
  })
})

const ev = (o: Partial<EventRow>): EventRow => ({
  id: 'e', ts: '2026-10-13T01:00:00Z', device_id: 'cam-a', site: 'gate1', lane: 'A',
  plate_raw: 'SBA1234G', plate_norm: 'SBA1234G', plate_kind: 'civilian', confidence: 0.95, checksum_ok: true,
  repaired_from: null, vehicle_id: null, decision: 'allow', reason: null, image_path: null, engine: 't',
  latency_ms: 100, read_count: 1, last_read_at: '2026-10-13T01:00:00Z', source: 'camera', ...o,
})
const TODAY = '2026-10-13'

describe('the three screens (owner, 13 Oct 2026)', () => {
  it('green is an allowed vehicle', () => {
    expect(toneOf(ev({ decision: 'allow' }))).toBe('allow')
  })

  it('red is a foreign plate, and nothing else', () => {
    expect(toneOf(ev({ decision: 'deny', reason: 'foreign' }))).toBe('deny')
    for (const reason of ['not_on_list', 'expired', 'suspended'] as const) {
      expect(toneOf(ev({ decision: 'deny', reason }))).toBe('check')
    }
  })

  it('orange is every check', () => {
    expect(toneOf(ev({ decision: 'check', reason: 'low_confidence' }))).toBe('check')
  })
})

describe('the one line', () => {
  it('red names the rule', () => {
    expect(screenLine(ev({ decision: 'deny', reason: 'foreign', plate_norm: 'JHA1234' }), null, TODAY))
      .toBe('Foreign plate · only Singapore plates are admitted')
  })

  it('a corrected read shows what the camera actually read', () => {
    const e = ev({ decision: 'check', reason: 'ambiguous', plate_norm: 'SBA1234G', repaired_from: 'SBA12346' })
    expect(screenLine(e, TAN, TODAY)).toBe('Camera read SBA 12346 · check the plate')
  })

  it('a Singapore car that is not allowed says why', () => {
    expect(screenLine(ev({ decision: 'deny', reason: 'not_on_list' }), null, TODAY)).toBe('Not on the approved list')
    expect(screenLine(ev({ decision: 'deny', reason: 'suspended' }), TAN, TODAY)).toBe('Tan Wei Ming · pass suspended')
    expect(screenLine(ev({ decision: 'deny', reason: 'expired' }), { ...TAN, valid_until: '2026-10-01' }, TODAY))
      .toBe('Tan Wei Ming · pass ended 1 Oct 2026')
    expect(screenLine(ev({ decision: 'deny', reason: 'expired' }), { ...TAN, valid_from: '2026-11-01' }, TODAY))
      .toBe('Tan Wei Ming · pass starts 1 Nov 2026')
  })

  it('an unsure read asks the guard to look', () => {
    expect(screenLine(ev({ decision: 'check', reason: 'low_confidence' }), null, TODAY)).toBe('Unclear read · check the plate')
    expect(screenLine(ev({ decision: 'check', reason: 'invalid_pattern' }), null, TODAY)).toBe('Plate not recognised · check the plate')
  })
})
