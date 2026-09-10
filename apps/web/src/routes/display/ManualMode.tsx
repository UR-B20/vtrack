import { useMemo, useState } from 'react'
import { searchVehicles } from '../../lib/cache'
import { formatShortClock } from '../../lib/format'
import { SearchIcon } from '../../lib/icons'
import { todayAtGate, vehicleStatus } from '../../lib/status'
import type { VehiclePublic } from '../../lib/types'

interface Props {
  rows: VehiclePublic[]
  syncedAt: number | null
  /** Why the list is not current, if it is not. */
  syncError: string | null
  /** True when the channel is down: the panel is then not dismissible. */
  forced: boolean
  onClose: () => void
}

/** "Nurul Aisyah · A Coy · Permanent" / "Priya Nair · Visitor · valid today". */
function describe(v: VehiclePublic, today: string): string {
  if (v.pass_type === 'visitor') {
    const s = vehicleStatus(v, today)
    const when = s.kind === 'expires_today' ? 'valid today' : s.kind === 'expired' ? 'expired' : 'visitor pass'
    return `${v.owner_name} · Visitor · ${when}`
  }
  const pass = `${v.pass_type.charAt(0).toUpperCase()}${v.pass_type.slice(1)}`
  return `${v.owner_name}${v.org_unit ? ` · ${v.org_unit}` : ''} · ${pass}`
}

/**
 * MANUAL MODE (§6.1) — search the cached list with no network at all.
 *
 * This is the thing that makes demo day safe: brief §2 position 2 says a searchable list
 * on the guard's screen works with no camera, so the camera is an accelerator rather than
 * a dependency. It reaches the guard two ways: forced when Realtime is down, and on
 * demand from the rail's always-available TYPE A PLATE.
 */
export function ManualMode({ rows, syncedAt, syncError, forced, onClose }: Props) {
  const [query, setQuery] = useState('')
  const today = useMemo(() => todayAtGate(), [])
  const results = useMemo(() => searchVehicles(rows, query), [rows, query])

  return (
    <section className="manual">
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span className="manual__label">MANUAL MODE</span>
        {!forced && (
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>
            CLOSE
          </button>
        )}
      </div>

      <h1 className="manual__title">Type a plate or a name</h1>

      <div className="manual__search">
        <SearchIcon />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape' && !forced) onClose() }}
          placeholder="SNB 95"
          aria-label="Search the approved list"
          autoFocus
          spellCheck={false}
          autoCapitalize="characters"
        />
      </div>

      {query.trim().length > 0 && (
        <div className="manual__results">
          {results.length === 0 && (
            <div className="manual__row">
              <span className="manual__empty">
                Nothing on the list matches “{query.trim()}”. Not on the list is not the same as not allowed —
                check with the driver.
              </span>
            </div>
          )}
          {results.map((v) => {
            const s = vehicleStatus(v, today)
            return (
              <div className="manual__row" key={v.plate_norm}>
                <span className="plate plate--chip" style={{ fontSize: 19 }}>{v.plate_display}</span>
                <span className="manual__row-text">{describe(v, today)}</span>
                <span className={`statuspill statuspill--${s.allowed ? 'allow' : 'deny'}`}>
                  {s.allowed ? 'ALLOWED' : s.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {rows.length === 0 && (
        <p className="manual__empty" style={{ color: 'var(--check)' }}>
          {syncError
            ? `No approved list on this device — ${syncError}. Until it loads, nothing typed here can be checked against the list.`
            : 'The list has not been cached yet. Connect once while online and it is kept for offline use.'}
        </p>
      )}

      <div className="manual__foot">
        DECISIONS MADE HERE ARE LOGGED AS MANUAL ENTRIES ·{' '}
        {syncError
          ? `LIST NOT SYNCED · ${syncError.toUpperCase()}`
          : syncedAt
            ? `THE LIST IS THE COPY CACHED AT ${formatShortClock(syncedAt)}`
            : 'THE LIST HAS NOT BEEN CACHED YET'}
      </div>
    </section>
  )
}
