import { describe, expect, it } from 'vitest'
import type { RecogniseResult } from '../../lib/engine'
import { readView } from './readView'

const base: RecogniseResult = {
  event_id: 'e1', decision: 'allow', reason: null, plate_norm: 'SBA1234G', plate_display: 'SBA 1234 G',
  confidence: 0.97, checksum_ok: true, repaired_from: null, flags: { verify: false },
  bbox: [1, 2, 3, 4], latency_ms: 180, deduped: false,
}

describe('readView', () => {
  it('allow: word, plate, confidence — and nothing about the owner', () => {
    const v = readView(base)
    expect(v).toMatchObject({ tone: 'allow', word: 'ALLOWED', plate: 'SBA 1234 G', confidence: '0.97', detail: null })
    expect(JSON.stringify(v)).not.toMatch(/Tan|HQ Coy|permanent/)
  })

  it('deny carries its reason', () => {
    expect(readView({ ...base, decision: 'deny', reason: 'expired' })).toMatchObject({ tone: 'deny', word: 'DENIED', detail: 'Pass expired' })
  })

  it('check carries its reason and the repair', () => {
    const v = readView({ ...base, decision: 'check', reason: 'low_confidence', repaired_from: 'SNB953BE', plate_display: undefined, plate_norm: 'SNB9538E' })
    expect(v).toMatchObject({ tone: 'check', word: 'CHECK', plate: 'SNB 9538 E', detail: 'Read not confident enough', repaired: true })
  })

  it('flags verify between the thresholds', () => {
    expect(readView({ ...base, flags: { verify: true } }).verify).toBe(true)
  })

  it('no plate is its own neutral state, never amber', () => {
    const v = readView({ ...base, decision: null, reason: null, plate_norm: null, event_id: null })
    expect(v).toMatchObject({ tone: 'none', word: 'NO PLATE IN VIEW', plate: null })
  })

  it('says why plates that were seen were not read, still never amber', () => {
    const none = { ...base, decision: null, reason: null, plate_norm: null, event_id: null }
    expect(readView({ ...none, rejected: 'multiple_plates' })).toMatchObject({ tone: 'none', word: 'TWO PLATES IN THE LANE BOX' })
    expect(readView({ ...none, rejected: 'edge' }).word).toBe('PLATE AT THE EDGE')
    expect(readView({ ...none, rejected: 'size' }).word).toBe('PLATE NOT AT THE STOP LINE')
  })
})
