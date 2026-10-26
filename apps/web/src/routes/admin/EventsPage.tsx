import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { normalise, formatPlate } from '../../lib/plates'
import { SearchIcon } from '../../lib/icons'
import { todayAtGate } from '../../lib/status'
import { VERB, type Vehicle } from '../../lib/types'
import { screenLine, toneOf, type Tone } from '../display/screen'
import { eventTime, okAt, PAGE_SIZE, screenFilter, sinceIso, type EventWithActions, type Range, type ScreenFilter } from './events'

const RANGES: { key: Range; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All' },
]

const SCREENS: { key: ScreenFilter; label: string }[] = [
  { key: 'all', label: 'All results' },
  { key: 'allow', label: 'Green · proceed' },
  { key: 'check', label: 'Orange · verify' },
  { key: 'deny', label: 'Red · foreign' },
]

/** The badge colours already used for a vehicle's status: green, amber, red. */
const BADGE: Record<Tone, string> = { allow: 'active', check: 'expiring', deny: 'expired' }

/**
 * /admin → Events (CLAUDE.md §6.3): what the gate decided, newest first, as the guard saw
 * it — the screen's colour and its one line — with the owner from today's list and when
 * OK was pressed. No crop images: the engine stores none (§11, Display sign-in).
 */
export function EventsPage({ vehicles }: { vehicles: Vehicle[] }) {
  const [range, setRange] = useState<Range>('today')
  const [screen, setScreen] = useState<ScreenFilter>('all')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<EventWithActions[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const byPlate = useMemo(() => new Map(vehicles.map((v) => [v.plate_norm, v])), [vehicles])
  const today = useMemo(() => todayAtGate(), [])
  const plate = normalise(query)

  const fetchPage = useCallback(async (offset: number) => {
    if (!supabase) return { data: [] as EventWithActions[], error: null }
    let q = supabase.from('events').select('*, guard_actions(action, ts)')
    const since = sinceIso(range)
    if (since) q = q.gte('ts', since)
    const f = screenFilter(screen)
    if (f.kind === 'eq') q = q.eq('decision', f.decision)
    else if (f.kind === 'foreign') q = q.eq('decision', 'deny').eq('reason', 'foreign')
    else if (f.kind === 'or') q = q.or(f.expr)
    if (plate) q = q.ilike('plate_norm', `%${plate}%`)
    const { data, error } = await q.order('ts', { ascending: false }).range(offset, offset + PAGE_SIZE - 1)
    return { data: (data ?? []) as EventWithActions[], error }
  }, [range, screen, plate])

  const reload = useCallback(async () => {
    setLoading(true)
    const { data, error } = await fetchPage(0)
    setLoading(false)
    if (error) { setError(error.message); return }
    setError(null); setRows(data); setMore(data.length === PAGE_SIZE)
  }, [fetchPage])

  useEffect(() => { void reload() }, [reload])

  async function loadMore() {
    setLoading(true)
    const { data, error } = await fetchPage(rows.length)
    setLoading(false)
    if (error) { setError(error.message); return }
    setRows((r) => [...r, ...data]); setMore(data.length === PAGE_SIZE)
  }

  return (
    <>
      <h1 className="admin__h1">Events</h1>
      <p className="admin__sub">Every vehicle the gate answered for, newest first, in the colour the guard saw.</p>

      <div className="admin__toolbar">
        <label className="admin__search">
          <SearchIcon />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Plate" aria-label="Search by plate" />
        </label>
        {RANGES.map((r) => (
          <button key={r.key} className="chip" aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>
        ))}
        <span className="admin__spacer" />
        <button className="btn btn--paper" onClick={() => void reload()} disabled={loading}>{loading ? 'LOADING…' : 'REFRESH'}</button>
      </div>
      <div className="admin__toolbar">
        {SCREENS.map((s) => (
          <button key={s.key} className="chip" aria-pressed={screen === s.key} onClick={() => setScreen(s.key)}>{s.label}</button>
        ))}
      </div>

      {error && <p className="error-note" style={{ marginBottom: 16 }}>{error}</p>}

      <div className="table-wrap">
        <table className="vehicles events">
          <thead>
            <tr><th>TIME</th><th>PLATE</th><th>SCREEN</th><th>WHY</th><th>READS</th><th>OK PRESSED</th></tr>
          </thead>
          <tbody>
            {rows.map((e) => {
              const tone = toneOf(e)
              const ok = okAt(e)
              return (
                <tr key={e.id}>
                  <td className="mono events__time">{eventTime(e.ts)}</td>
                  <td><span className="plate plate--sm">{formatPlate(e.plate_norm ?? e.plate_raw ?? '') || '—'}</span></td>
                  <td><span className={`badge badge--${BADGE[tone]}`}>{VERB[tone]}</span></td>
                  <td>
                    {screenLine(e, byPlate.get(e.plate_norm ?? '') ?? null, today)}
                    {e.source === 'manual' && <span className="events__tag mono"> · TYPED</span>}
                  </td>
                  <td className="mono">{e.read_count}</td>
                  <td className="mono events__time">{ok ? eventTime(ok).split(' ').pop() : '—'}</td>
                </tr>
              )
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={6} className="events__empty">No events for these filters.</td></tr>
            )}
          </tbody>
        </table>
        <div className="table-foot">
          SHOWING {rows.length}{more ? '+' : ''} · OWNER AND PASS FROM TODAY&rsquo;S LIST
          {more && <button className="btn btn--link events__more" onClick={() => void loadMore()} disabled={loading}>LOAD {PAGE_SIZE} MORE</button>}
        </div>
      </div>
    </>
  )
}
