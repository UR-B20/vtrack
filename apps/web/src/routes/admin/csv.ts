/**
 * csv.ts — CSV import and export for the approved list (CLAUDE.md §6.3).
 *
 * Columns, fixed by §6.3:
 *   plate,owner_name,org_unit,vehicle_type,pass_type,valid_from,valid_until,notes
 *
 * §6.3 says "reject rows whose checksum fails and show why". Read literally that would
 * reject MID 12345, which has no checksum at all — so the predicate runs on classify()
 * rather than on a bare last-character comparison: an unrecognisable pattern is
 * rejected, a civilian plate with the wrong check letter is rejected and told which
 * letter it should have been, and MID and foreign plates are accepted untouched.
 *
 * repair() is deliberately never called here. Repairing a typed list would put a plate
 * on the approved list that nobody typed — the opposite of what an approved list is for.
 *
 * Pure: text in, rows out. The caller does the inserting.
 */

import { classify, checksumLetter, formatPlate, normalise } from '../../lib/plates'
import type { PlateKind } from '../../lib/plates'

export const CSV_COLUMNS = [
  'plate', 'owner_name', 'org_unit', 'vehicle_type', 'pass_type', 'valid_from', 'valid_until', 'notes',
] as const

const VEHICLE_TYPES = ['car', 'motorcycle', 'goods', 'bus', 'military', 'other']
const PASS_TYPES = ['permanent', 'visitor', 'contractor']

export type RowVerdict = 'ok' | 'rejected' | 'duplicate_in_file' | 'duplicate_existing'

export interface ImportRow {
  /** 1-based line in the source file, counting the header. */
  line: number
  raw: string
  plate_norm: string
  plate_display: string
  kind: PlateKind
  owner_name: string
  org_unit: string | null
  vehicle_type: string | null
  pass_type: string
  valid_from: string | null
  valid_until: string | null
  notes: string | null
  verdict: RowVerdict
  /** Why it was rejected or skipped, or a warning on an accepted row. */
  reason: string | null
}

/** RFC4180-ish: quoted fields, doubled quotes, embedded commas and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const src = text.replace(/^﻿/, '')   // strip a BOM from Excel exports

  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); rows.push(row); row = [] }

  while (i < src.length) {
    const c = src[i] as string
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { quoted = true; i++; continue }
    if (c === ',') { endField(); i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { endRow(); i++; continue }
    field += c; i++
  }
  if (field.length > 0 || row.length > 0) endRow()
  return rows.filter((r) => r.some((f) => f.trim() !== ''))
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseDate(value: string): { value: string | null; error: string | null } {
  const v = value.trim()
  if (!v) return { value: null, error: null }
  if (!ISO_DATE.test(v)) return { value: null, error: `date "${v}" must be yyyy-mm-dd` }
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    return { value: null, error: `date "${v}" is not a real date` }
  }
  return { value: v, error: null }
}

/**
 * Parse and validate an import.
 * `existingPlateNorms` are the plates already on the list, so duplicates are reported
 * up front rather than surfacing as a unique-violation that aborts the whole batch.
 */
export function parseVehicleCsv(text: string, existingPlateNorms: Set<string> = new Set()): ImportRow[] {
  const table = parseCsv(text)
  if (table.length === 0) return []

  const header = (table[0] as string[]).map((h) => h.trim().toLowerCase())
  const hasHeader = header.includes('plate')
  const index = (name: string) => (hasHeader ? header.indexOf(name) : CSV_COLUMNS.indexOf(name as never))
  const body = hasHeader ? table.slice(1) : table

  const seen = new Set<string>()
  const rows: ImportRow[] = []

  body.forEach((cells, n) => {
    const at = (name: string) => {
      const i = index(name)
      return i >= 0 ? (cells[i] ?? '').trim() : ''
    }
    const line = n + (hasHeader ? 2 : 1)
    const rawPlate = at('plate')
    const { kind, canonical, checksumOk } = classify(rawPlate)

    const base = {
      line,
      raw: rawPlate,
      plate_norm: canonical,
      plate_display: formatPlate(canonical),
      kind,
      owner_name: at('owner_name'),
      org_unit: at('org_unit') || null,
      vehicle_type: at('vehicle_type').toLowerCase() || null,
      pass_type: at('pass_type').toLowerCase() || 'permanent',
      valid_from: null as string | null,
      valid_until: null as string | null,
      notes: at('notes') || null,
    }

    const reject = (reason: string) => rows.push({ ...base, verdict: 'rejected', reason })

    if (!rawPlate) return reject('no plate')
    if (kind === 'invalid') return reject(`"${rawPlate}" is not a recognisable plate pattern`)
    if (kind === 'civilian' && !checksumOk) {
      const m = /^([A-Z]{1,3})(\d{1,4})([A-Z])$/.exec(normalise(rawPlate))
      const expected = m ? checksumLetter(m[1] as string, m[2] as string) : '?'
      return reject(`check letter should be ${expected}, got ${m?.[3] ?? '?'}`)
    }
    if (!base.owner_name) return reject('owner_name is required')
    if (base.vehicle_type && !VEHICLE_TYPES.includes(base.vehicle_type)) {
      return reject(`vehicle_type "${base.vehicle_type}" must be one of ${VEHICLE_TYPES.join(', ')}`)
    }
    if (!PASS_TYPES.includes(base.pass_type)) {
      return reject(`pass_type "${base.pass_type}" must be one of ${PASS_TYPES.join(', ')}`)
    }

    const from = parseDate(at('valid_from'))
    if (from.error) return reject(from.error)
    const until = parseDate(at('valid_until'))
    if (until.error) return reject(until.error)
    if (from.value && until.value && from.value > until.value) {
      return reject(`valid_from ${from.value} is after valid_until ${until.value}`)
    }
    base.valid_from = from.value
    base.valid_until = until.value

    if (seen.has(canonical)) {
      return rows.push({ ...base, verdict: 'duplicate_in_file', reason: `${formatPlate(canonical)} appears earlier in this file` })
    }
    seen.add(canonical)

    if (existingPlateNorms.has(canonical)) {
      return rows.push({ ...base, verdict: 'duplicate_existing', reason: `${formatPlate(canonical)} is already on the list` })
    }

    // Foreign plates carry no checksum, so we accept them but say so — an SG plate that
    // lost its check letter in a spreadsheet looks exactly like a Malaysian one.
    const warning = kind === 'foreign'
      ? 'no checksum — treated as a foreign plate; check the check letter was not dropped'
      : kind === 'mid' ? 'MID plate — no checksum' : null

    rows.push({ ...base, verdict: 'ok', reason: warning })
  })

  return rows
}

/** The rows that should actually be inserted. */
export function importableRows(rows: ImportRow[]) {
  return rows
    .filter((r) => r.verdict === 'ok')
    .map((r) => ({
      plate_norm: r.plate_norm,
      plate_display: r.plate_display,
      owner_name: r.owner_name,
      org_unit: r.org_unit,
      vehicle_type: r.vehicle_type,
      pass_type: r.pass_type,
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      notes: r.notes,
    }))
}

function escapeCsv(value: string | null | undefined): string {
  const v = value ?? ''
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export interface ExportableVehicle {
  plate_display: string
  owner_name: string
  org_unit: string | null
  vehicle_type: string | null
  pass_type: string
  valid_from: string | null
  valid_until: string | null
  notes: string | null
}

/** Export in exactly the shape the importer accepts, so a round trip is lossless. */
export function toVehicleCsv(vehicles: ExportableVehicle[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const v of vehicles) {
    lines.push([
      escapeCsv(v.plate_display), escapeCsv(v.owner_name), escapeCsv(v.org_unit),
      escapeCsv(v.vehicle_type), escapeCsv(v.pass_type),
      escapeCsv(v.valid_from), escapeCsv(v.valid_until), escapeCsv(v.notes),
    ].join(','))
  }
  return `${lines.join('\n')}\n`
}
