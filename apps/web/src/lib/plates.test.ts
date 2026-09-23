import { describe, it, expect } from 'vitest'
import { normalise, checksumLetter, classify, repair, formatPlate, diffPlates } from './plates'

/**
 * The first two blocks are the assertions written into CLAUDE.md §5.1 and the fixtures
 * in §9. They are the shared oracle between this port and the engine's plates.py — if
 * either drifts, these fail.
 */

describe('§5.1 — the assertions that must pass', () => {
  it('computes the published check letters', () => {
    expect(checksumLetter('SBS', '9889')).toBe('U')
    expect(checksumLetter('E', '23')).toBe('H')      // 1-letter prefix pads the first slot
    expect(checksumLetter('SG', '2017')).toBe('C')
    expect(checksumLetter('SNB', '9538')).toBe('E')
  })

  it('normalises a MID plate written either way round', () => {
    expect(classify('12345 MID')).toEqual({ kind: 'mid', canonical: 'MID12345', checksumOk: true })
  })

  it('repairs a single confusable when exactly one candidate validates', () => {
    expect(repair('SNB953BE')).toEqual(['SNB9538E'])   // B → 8
    expect(repair('SG2O17C')).toEqual(['SG2017C'])     // O → 0
  })

  it('refuses to repair what is not a confusable — 9 is not O, so this stays CHECK', () => {
    expect(repair('SBS988OU')).toEqual([])
  })
})

describe('§9 — fixtures', () => {
  const valid = ['SBA 1234 G', 'SNB 9538 E', 'FBA 2210 T', 'SNB 9517 R',
                 'SNB 9502 H', 'SGX 4471 M', 'SLM 3090 J', 'SKN 8821 R']

  it.each(valid)('%s is a valid civilian plate', (plate) => {
    const c = classify(plate)
    expect(c.kind).toBe('civilian')
    expect(c.checksumOk).toBe(true)
    expect(c.canonical).toBe(normalise(plate))
  })

  it.each([['MID 12345'], ['12345 MID']])('%s normalises to MID12345', (plate) => {
    expect(classify(plate)).toEqual({ kind: 'mid', canonical: 'MID12345', checksumOk: true })
  })

  it('JHA 1234 is foreign — no checksum, never repaired', () => {
    expect(classify('JHA 1234')).toEqual({ kind: 'foreign', canonical: 'JHA1234', checksumOk: true })
  })

  it.each([['SBA 1234 F'], ['SNB 9538 F']])('%s fails its checksum', (plate) => {
    const c = classify(plate)
    expect(c.kind).toBe('civilian')
    expect(c.checksumOk).toBe(false)
  })

  it('F is never a check letter', () => {
    for (let i = 0; i < 19; i++) expect('AZYXUTSRPMLKJHGEDCB'[i]).not.toBe('F')
  })
})

describe('normalise', () => {
  it('strips separators and upper-cases', () => {
    expect(normalise('sba 1234 g')).toBe('SBA1234G')
    expect(normalise(' s-b-a.1234/g ')).toBe('SBA1234G')
    expect(normalise('')).toBe('')
  })
})

describe('classify', () => {
  it('marks an unreadable pattern invalid', () => {
    expect(classify('SNB953BE').kind).toBe('invalid')   // two trailing letters
    expect(classify('!!!').kind).toBe('invalid')
    expect(classify('').kind).toBe('invalid')
  })

  it('strips leading zeros from a MID number', () => {
    expect(classify('MID 00123').canonical).toBe('MID123')
  })

  it('checks MID before civilian so MID12345 is never read as a civilian plate', () => {
    expect(classify('MID12345').kind).toBe('mid')
  })
})

describe('repair', () => {
  it('returns nothing for a plate that already validates', () => {
    // The caller only repairs when the checksum failed, but the function must not
    // invent an alternative reading for a good plate.
    expect(repair('SBA1234G')).not.toContain('SBA1234G')
  })

  it('respects maxSubs', () => {
    expect(repair('SNB953BE', 0)).toEqual([])
  })

  it('returns every candidate at the smallest k, so ambiguity is visible', () => {
    // The decision rule (§5.2) uses length: 1 → use it, 0 or >1 → CHECK.
    const candidates = repair('5NB9538E')
    expect(candidates).toEqual(['SNB9538E'])            // 5 → S
  })
})

describe('formatPlate', () => {
  it('renders the canonical forms', () => {
    expect(formatPlate('SBA1234G')).toBe('SBA 1234 G')
    expect(formatPlate('MID12345')).toBe('MID 12345')
    expect(formatPlate('12345MID')).toBe('MID 12345')
    expect(formatPlate('JHA1234')).toBe('JHA 1234')
  })

  it('is tolerant of a raw OCR read — the CHECK stage shows what the camera saw', () => {
    expect(formatPlate('SNB953BE')).toBe('SNB 953B E')
    expect(formatPlate('snb 953b e')).toBe('SNB 953B E')
  })

  it('never throws and never loses the string', () => {
    expect(formatPlate('')).toBe('')
    expect(formatPlate('???')).toBe('')
    expect(formatPlate('X')).toBe('X')
    expect(formatPlate('12')).toBe('12')
  })
})

describe('diffPlates', () => {
  it('points at the repaired character', () => {
    const d = diffPlates('SNB953BE', 'SNB9538E')
    expect(d.chars.map((c) => c.changed)).toEqual([false, false, false, false, false, false, true, false])
    expect(d.subs).toEqual([{ from: 'B', to: '8' }])
  })

  it('claims nothing when there is no raw read', () => {
    expect(diffPlates(null, 'SNB9538E').subs).toEqual([])
    expect(diffPlates('', 'SNB9538E').subs).toEqual([])
  })

  it('claims nothing when the raw read and the guess are the same', () => {
    expect(diffPlates('SNB9538E', 'SNB9538E').subs).toEqual([])
  })

  it('claims nothing when the lengths differ — we only flag what we can point at', () => {
    const d = diffPlates('SNB953E', 'SNB9538E')
    expect(d.subs).toEqual([])
    expect(d.chars.every((c) => !c.changed)).toBe(true)
  })

  it('handles more than one substitution', () => {
    expect(diffPlates('5G2O17C', 'SG2017C').subs).toEqual([
      { from: '5', to: 'S' },
      { from: 'O', to: '0' },
    ])
  })
})
