import { useMemo, useRef, useState } from 'react'
import { normalise } from '../../lib/plates'
import { SearchIcon } from '../../lib/icons'
import { matchesFilter, todayAtGate, vehicleStatus, type VehicleFilter } from '../../lib/status'
import type { Vehicle } from '../../lib/types'
import { importableRows, parseVehicleCsv, toVehicleCsv, type ImportRow } from './csv'

interface Props {
  vehicles: Vehicle[]
  onEdit: (vehicle: Vehicle) => void
  onAdd: () => void
  onImport: (rows: ReturnType<typeof importableRows>) => Promise<string | null>
}

const FILTERS: { key: VehicleFilter; label: string }[] = [
  { key: 'all_active', label: 'All active' },
  { key: 'visitors', label: 'Visitors' },
  { key: 'expiring', label: 'Expiring' },
  { key: 'suspended', label: 'Suspended' },
]

const VERDICT_LABEL: Record<ImportRow['verdict'], string> = {
  ok: 'IMPORT',
  rejected: 'REJECTED',
  duplicate_in_file: 'SKIPPED',
  duplicate_existing: 'SKIPPED',
}

export function VehiclesTable({ vehicles, onEdit, onAdd, onImport }: Props) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<VehicleFilter>('all_active')
  const [report, setReport] = useState<ImportRow[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const today = useMemo(() => todayAtGate(), [])

  const counts = useMemo(() => ({
    all_active: vehicles.filter((v) => matchesFilter(v, 'all_active', today)).length,
    visitors: vehicles.filter((v) => matchesFilter(v, 'visitors', today)).length,
    expiring: vehicles.filter((v) => matchesFilter(v, 'expiring', today)).length,
    suspended: vehicles.filter((v) => matchesFilter(v, 'suspended', today)).length,
  }), [vehicles, today])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const plateQuery = normalise(query)
    return vehicles
      .filter((v) => matchesFilter(v, filter, today))
      .filter((v) => {
        if (!q) return true
        return (
          (plateQuery !== '' && normalise(v.plate_norm).includes(plateQuery)) ||
          v.owner_name.toLowerCase().includes(q) ||
          (v.org_unit ?? '').toLowerCase().includes(q)
        )
      })
      .sort((a, b) => a.plate_norm.localeCompare(b.plate_norm))
  }, [vehicles, query, filter, today])

  const existing = useMemo(() => new Set(vehicles.map((v) => v.plate_norm)), [vehicles])

  async function onFile(file: File) {
    setImportError(null)
    const parsed = parseVehicleCsv(await file.text(), existing)
    setReport(parsed)
  }

  async function confirmImport() {
    if (!report) return
    setImporting(true)
    const message = await onImport(importableRows(report))
    setImporting(false)
    if (message) setImportError(message)
    else setReport(null)
  }

  function exportCsv() {
    const csv = toVehicleCsv(rows)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `vtrack-vehicles-${today}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <>
      <h1 className="admin__h1">Vehicles</h1>
      <p className="admin__sub">
        {counts.all_active} active · {counts.expiring} expiring within 30 days · {vehicles.length} on the list
      </p>

      <div className="admin__toolbar">
        <label className="admin__search">
          <SearchIcon />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plate, owner or unit" aria-label="Search vehicles"
          />
        </label>

        {FILTERS.map((f) => (
          <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
            {f.key !== 'all_active' && counts[f.key] > 0 ? ` · ${counts[f.key]}` : ''}
          </button>
        ))}

        <span className="admin__spacer" />

        <input
          ref={fileRef} type="file" accept=".csv,text/csv" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }}
        />
        <button className="btn btn--paper" onClick={() => fileRef.current?.click()}>IMPORT CSV</button>
        <button className="btn btn--paper" onClick={exportCsv}>EXPORT CSV</button>
        <button className="btn btn--navy" onClick={onAdd}>ADD VEHICLE</button>
      </div>

      {report && (
        <div className="import-report">
          <div className="import-report__head">
            {importableRows(report).length} of {report.length} rows will be imported ·{' '}
            {report.filter((r) => r.verdict === 'rejected').length} rejected ·{' '}
            {report.filter((r) => r.verdict.startsWith('duplicate')).length} duplicates skipped
            <span style={{ float: 'right', display: 'flex', gap: 10 }}>
              <button className="btn btn--navy" onClick={() => void confirmImport()}
                disabled={importing || importableRows(report).length === 0}>
                {importing ? 'IMPORTING…' : 'IMPORT'}
              </button>
              <button className="btn btn--link" onClick={() => setReport(null)}>Cancel</button>
            </span>
          </div>
          <div className="import-report__list">
            {report.map((r) => (
              <div key={r.line} className={`import-report__row import-report__row--${r.verdict}`}>
                <span className="mono" style={{ color: 'var(--muted)', minWidth: 34 }}>{r.line}</span>
                <span className="plate plate--sm">{r.plate_display || r.raw || '—'}</span>
                <span style={{ minWidth: 110 }}>{r.owner_name || <em style={{ color: 'var(--muted)' }}>no owner</em>}</span>
                <span className="mono" style={{ color: 'var(--muted)', minWidth: 70, fontSize: 12 }}>
                  {VERDICT_LABEL[r.verdict]}
                </span>
                <span className="import-report__why">{r.reason ?? ''}</span>
              </div>
            ))}
          </div>
          {importError && <div className="import-report__head"><span className="error-note">{importError}</span></div>}
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 18 }}>
        <table className="vehicles">
          <thead>
            <tr>
              <th>PLATE</th><th>OWNER</th><th>STATUS</th><th>UNIT / ORG</th><th>TYPE</th><th>VALID UNTIL</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => {
              const s = vehicleStatus(v, today)
              return (
                <tr key={v.id} onClick={() => onEdit(v)} tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onEdit(v) }}>
                  <td><span className="plate plate--sm">{v.plate_display}</span></td>
                  <td>{v.owner_name}</td>
                  <td><span className={`badge badge--${s.kind}`}>{s.label}</span></td>
                  <td style={{ color: 'var(--muted)' }}>
                    {v.pass_type === 'visitor' ? `Visitor · hosted by ${v.org_unit ?? '—'}` : v.org_unit ?? '—'}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>
                    {v.vehicle_type ? v.vehicle_type.charAt(0).toUpperCase() + v.vehicle_type.slice(1) : '—'}
                  </td>
                  <td className="mono" style={{ color: 'var(--muted)', fontSize: 14 }}>{v.valid_until ?? '—'}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={6} style={{ color: 'var(--muted)', padding: 26 }}>
                Nothing matches. Try a different search or filter.
              </td></tr>
            )}
          </tbody>
        </table>
        <div className="table-foot">SHOWING {rows.length} OF {vehicles.length}</div>
      </div>
    </>
  )
}
