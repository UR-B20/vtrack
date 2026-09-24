import { describe, expect, it } from 'vitest'
import { allowDetail } from './SlabStage'
import type { VehiclePublic } from '../../lib/types'

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
