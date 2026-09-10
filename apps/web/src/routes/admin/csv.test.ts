import { describe, it, expect } from 'vitest'
import { parseCsv, parseVehicleCsv, importableRows, toVehicleCsv, CSV_COLUMNS } from './csv'

const HEADER = CSV_COLUMNS.join(',')
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n')

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
    ])
  })

  it('drops blank lines and a BOM', () => {
    expect(parseCsv('﻿a,b\n\n\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('keeps a newline inside a quoted field', () => {
    expect(parseCsv('a,b\n"line1\nline2",z\n')).toEqual([['a', 'b'], ['line1\nline2', 'z']])
  })
})

describe('the rejection predicate', () => {
  it('rejects a civilian plate with the wrong check letter, and says which it should be', () => {
    const [row] = parseVehicleCsv(csv('SBA 1234 F,Someone,HQ,car,permanent,,,'))
    expect(row?.verdict).toBe('rejected')
    expect(row?.reason).toBe('check letter should be G, got F')
  })

  it('accepts MID plates — they have no checksum to fail', () => {
    const rows = parseVehicleCsv(csv(
      'MID 12345,SAF pool vehicle,MT Line,military,permanent,,,',
      '12345 MID,SAF pool two,MT Line,military,permanent,,,',
    ))
    expect(rows.map((r) => r.verdict)).toEqual(['ok', 'duplicate_in_file'])
    expect(rows[0]?.plate_norm).toBe('MID12345')
    expect(rows[0]?.kind).toBe('mid')
  })

  it('accepts a foreign plate, with a warning rather than a rejection', () => {
    const [row] = parseVehicleCsv(csv('JHA 1234,Malaysian contractor,ABC,goods,contractor,,,'))
    expect(row?.verdict).toBe('ok')
    expect(row?.kind).toBe('foreign')
    expect(row?.reason).toMatch(/no checksum/)
  })

  it('flags a dropped check letter as foreign rather than silently importing it as SG', () => {
    // 'SBA 1234' is indistinguishable from a Malaysian plate, so it imports — but the
    // warning is what makes a spreadsheet that lost its last column visible.
    const [row] = parseVehicleCsv(csv('SBA 1234,Someone,HQ,car,permanent,,,'))
    expect(row?.verdict).toBe('ok')
    expect(row?.kind).toBe('foreign')
    expect(row?.reason).toMatch(/check letter was not dropped/)
  })

  it('rejects an unrecognisable pattern', () => {
    const [row] = parseVehicleCsv(csv('!!!,Someone,HQ,car,permanent,,,'))
    expect(row?.verdict).toBe('rejected')
    expect(row?.reason).toMatch(/not a recognisable plate pattern/)
  })

  it('never repairs a typed plate', () => {
    // repair('SNB953BE') would give SNB9538E, but an import must not invent a plate.
    const [row] = parseVehicleCsv(csv('SNB 953B E,Someone,HQ,car,permanent,,,'))
    expect(row?.verdict).toBe('rejected')
    expect(row?.plate_norm).not.toBe('SNB9538E')
  })

  it('requires an owner name', () => {
    const [row] = parseVehicleCsv(csv('SBA 1234 G,,HQ,car,permanent,,,'))
    expect(row?.verdict).toBe('rejected')
    expect(row?.reason).toMatch(/owner_name/)
  })
})

describe('enumerations and dates', () => {
  it('rejects an unknown vehicle_type or pass_type', () => {
    expect(parseVehicleCsv(csv('SBA 1234 G,A,HQ,spaceship,permanent,,,'))[0]?.reason).toMatch(/vehicle_type/)
    expect(parseVehicleCsv(csv('SBA 1234 G,A,HQ,car,gold,,,'))[0]?.reason).toMatch(/pass_type/)
  })

  it('defaults pass_type to permanent, matching the schema', () => {
    expect(parseVehicleCsv(csv('SBA 1234 G,A,HQ,car,,,,'))[0]?.pass_type).toBe('permanent')
  })

  it('rejects a malformed, unreal or inverted date', () => {
    expect(parseVehicleCsv(csv('SBA 1234 G,A,HQ,car,permanent,01/02/2026,,'))[0]?.reason).toMatch(/yyyy-mm-dd/)
    expect(parseVehicleCsv(csv('SBA 1234 G,A,HQ,car,permanent,2026-02-31,,'))[0]?.reason).toMatch(/not a real date/)
    expect(parseVehicleCsv(csv('SBA 1234 G,A,HQ,car,permanent,2026-12-31,2026-01-01,'))[0]?.reason)
      .toMatch(/is after valid_until/)
  })

  it('accepts empty dates as unbounded', () => {
    const [row] = parseVehicleCsv(csv('SBA 1234 G,A,HQ,car,permanent,,,'))
    expect(row?.verdict).toBe('ok')
    expect(row?.valid_from).toBeNull()
    expect(row?.valid_until).toBeNull()
  })
})

describe('duplicates', () => {
  it('flags the second occurrence within the file, keeping the first', () => {
    const rows = parseVehicleCsv(csv(
      'SBA 1234 G,First,HQ,car,permanent,,,',
      'sba1234g,Second,HQ,car,permanent,,,',
    ))
    expect(rows.map((r) => r.verdict)).toEqual(['ok', 'duplicate_in_file'])
    expect(importableRows(rows)).toHaveLength(1)
    expect(importableRows(rows)[0]?.owner_name).toBe('First')
  })

  it('flags a plate already on the list, so one 23505 cannot abort the batch', () => {
    const rows = parseVehicleCsv(
      csv('SBA 1234 G,A,HQ,car,permanent,,,', 'SNB 9538 E,B,A Coy,car,permanent,,,'),
      new Set(['SBA1234G']),
    )
    expect(rows[0]?.verdict).toBe('duplicate_existing')
    expect(rows[1]?.verdict).toBe('ok')
    expect(importableRows(rows)).toHaveLength(1)
  })
})

describe('shape', () => {
  it('reports the line number counting the header', () => {
    const rows = parseVehicleCsv(csv('SBA 1234 F,A,HQ,car,permanent,,,'))
    expect(rows[0]?.line).toBe(2)
  })

  it('derives plate_norm and plate_display, which the CSV does not carry', () => {
    const [row] = parseVehicleCsv(csv('  sba 1234 g ,Tan Wei Ming,HQ Coy,car,permanent,2026-01-01,2026-12-31,note'))
    expect(row?.plate_norm).toBe('SBA1234G')
    expect(row?.plate_display).toBe('SBA 1234 G')
    expect(row?.owner_name).toBe('Tan Wei Ming')
    expect(row?.notes).toBe('note')
  })

  it('works without a header row', () => {
    const rows = parseVehicleCsv('SBA 1234 G,Tan Wei Ming,HQ Coy,car,permanent,,,')
    expect(rows[0]?.verdict).toBe('ok')
    expect(rows[0]?.line).toBe(1)
  })

  it('tolerates reordered columns when a header is present', () => {
    const rows = parseVehicleCsv('owner_name,plate\nTan Wei Ming,SBA 1234 G')
    expect(rows[0]?.verdict).toBe('ok')
    expect(rows[0]?.plate_norm).toBe('SBA1234G')
  })

  it('returns nothing for an empty file', () => {
    expect(parseVehicleCsv('')).toEqual([])
    expect(parseVehicleCsv(HEADER)).toEqual([])
  })
})

describe('export', () => {
  it('round-trips through the importer', () => {
    const out = toVehicleCsv([{
      plate_display: 'SBA 1234 G', owner_name: 'Tan, Wei Ming', org_unit: 'HQ Coy',
      vehicle_type: 'car', pass_type: 'permanent',
      valid_from: '2026-01-01', valid_until: '2026-12-31', notes: 'says "hi"',
    }])
    expect(out.split('\n')[0]).toBe(HEADER)

    const rows = parseVehicleCsv(out)
    expect(rows[0]?.verdict).toBe('ok')
    expect(rows[0]?.owner_name).toBe('Tan, Wei Ming')
    expect(rows[0]?.notes).toBe('says "hi"')
    expect(rows[0]?.plate_norm).toBe('SBA1234G')
  })
})

describe('the §9 fixtures import cleanly', () => {
  it('accepts all eight seeded plates and rejects the two invalid ones', () => {
    const good = ['SBA 1234 G', 'SNB 9538 E', 'FBA 2210 T', 'SNB 9517 R',
                  'SNB 9502 H', 'SGX 4471 M', 'SLM 3090 J', 'SKN 8821 R', 'MID 12345']
    const rows = parseVehicleCsv(csv(...good.map((p) => `${p},Owner,Unit,car,permanent,,,`)))
    expect(rows.every((r) => r.verdict === 'ok')).toBe(true)

    const bad = parseVehicleCsv(csv('SBA 1234 F,A,U,car,permanent,,,', 'SNB 9538 F,B,U,car,permanent,,,'))
    expect(bad.every((r) => r.verdict === 'rejected')).toBe(true)
  })
})
