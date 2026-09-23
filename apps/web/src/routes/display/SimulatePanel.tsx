import { useState } from 'react'
import { LANE, SITE, supabase } from '../../lib/supabase'
import type { Decision, EventRow } from '../../lib/types'

interface Props {
  /** What is on the stage now, so "re-read" can update it in place. */
  current: EventRow | null
  /** Feed a row into the reducer directly when the database will not take it. */
  onLocalEvent: (event: EventRow) => void
  cameraOnline: boolean
  onToggleCamera: () => void
}

/** The device the dev policy scopes anon writes to (supabase/dev/simulate_policy.sql). */
const SIM_DEVICE = 'sim-dev'

type Scenario = {
  key: string
  label: string
  row: () => Omit<EventRow, 'id' | 'ts' | 'last_read_at'>
}

const base = {
  device_id: SIM_DEVICE, site: SITE, lane: LANE,
  vehicle_id: null, image_path: null, engine: 'simulate', latency_ms: 420,
  read_count: 1, source: 'camera' as const,
}

const SCENARIOS: Scenario[] = [
  {
    key: 'allow', label: 'ALLOW · SBA 1234 G',
    row: () => ({ ...base, plate_raw: 'SBA 1234 G', plate_norm: 'SBA1234G', plate_kind: 'civilian',
      confidence: 0.97, checksum_ok: true, repaired_from: null, decision: 'allow', reason: null }),
  },
  {
    key: 'deny', label: 'DENY · SKN 8821 R',
    // Deliberately not in seed.sql — this is the "not on the list" fixture (§9).
    row: () => ({ ...base, plate_raw: 'SKN 8821 R', plate_norm: 'SKN8821R', plate_kind: 'civilian',
      confidence: 0.94, checksum_ok: true, repaired_from: null, decision: 'deny', reason: 'not_on_list' }),
  },
  {
    key: 'check', label: 'CHECK · SNB 953B E',
    // A raw read whose checksum fails and which repairs to exactly one candidate — the
    // case that exercises the raw-read panel, the amber highlight and the repaired badge.
    row: () => ({ ...base, plate_raw: 'SNB 953B E', plate_norm: 'SNB9538E', plate_kind: 'civilian',
      confidence: 0.58, checksum_ok: false, repaired_from: 'SNB953BE', decision: 'check', reason: 'low_confidence' }),
  },
  {
    key: 'expired', label: 'DENY · expired · SNB 9517 R',
    row: () => ({ ...base, plate_raw: 'SNB 9517 R', plate_norm: 'SNB9517R', plate_kind: 'civilian',
      confidence: 0.95, checksum_ok: true, repaired_from: null, decision: 'deny', reason: 'expired' }),
  },
  {
    key: 'suspended', label: 'DENY · suspended · SLM 3090 J',
    row: () => ({ ...base, plate_raw: 'SLM 3090 J', plate_norm: 'SLM3090J', plate_kind: 'civilian',
      confidence: 0.96, checksum_ok: true, repaired_from: null, decision: 'deny', reason: 'suspended' }),
  },
  {
    key: 'mid', label: 'ALLOW · MID 12345',
    row: () => ({ ...base, plate_raw: '12345 MID', plate_norm: 'MID12345', plate_kind: 'mid',
      confidence: 0.91, checksum_ok: true, repaired_from: null, decision: 'allow', reason: null }),
  },
]

/**
 * Dev-only event injector, gated behind ?dev=1 (M0 acceptance, §8).
 *
 * It tries the database first, so the real Realtime INSERT/UPDATE path is exercised. If
 * RLS refuses — which it does unless supabase/dev/simulate_policy.sql is applied and
 * VITE_SITE is devlab — it falls back to feeding the reducer directly and says why once.
 * The fallback triggers on any error, not just 42501: a missing devices row is 23503, an
 * offline browser has no code at all, and a fallback that misreports the cause is worse
 * than no fallback.
 */
export function SimulatePanel({ current, onLocalEvent, cameraOnline, onToggleCamera }: Props) {
  // Collapsed by default: the panel must never sit over the stage during a demo.
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  function localRow(partial: Omit<EventRow, 'id' | 'ts' | 'last_read_at'>): EventRow {
    const nowIso = new Date().toISOString()
    return { ...partial, id: crypto.randomUUID(), ts: nowIso, last_read_at: nowIso }
  }

  function explain(code: string | undefined, message: string): string {
    if (code === '23503') return 'Insert refused: no devices row. Run supabase/seed.sql.'
    if (code === '42501' || /row-level security/i.test(message)) {
      return `Insert refused by RLS — showing it locally instead. To round-trip through Realtime, apply supabase/dev/simulate_policy.sql and set VITE_SITE=devlab (currently ${SITE}).`
    }
    return `Insert failed (${code ?? 'no code'}) — showing it locally instead.`
  }

  async function fire(scenario: Scenario) {
    const partial = scenario.row()
    if (supabase) {
      const { error } = await supabase.from('events').insert(partial)
      if (!error) { setNote(null); return }        // Realtime will deliver it
      setNote(explain(error.code, error.message))
    } else {
      setNote('Supabase is not configured — showing simulated events locally.')
    }
    onLocalEvent(localRow(partial))
  }

  async function reread() {
    if (!current) return
    // The dedupe upgrade of §5.3: same row, one more read, higher confidence.
    const next: EventRow = {
      ...current,
      read_count: current.read_count + 1,
      confidence: Math.min(0.99, (current.confidence ?? 0.6) + 0.13),
      last_read_at: new Date().toISOString(),
    }
    if (supabase) {
      const { error } = await supabase
        .from('events')
        .update({ read_count: next.read_count, confidence: next.confidence, last_read_at: next.last_read_at })
        .eq('id', current.id)
      if (!error) { setNote(null); return }
      setNote(explain(error.code, error.message))
    }
    onLocalEvent(next)
  }

  async function upgrade() {
    if (!current || current.decision !== 'check') return
    // A clearer frame arrives: CHECK becomes ALLOW on the same event, in place.
    const next: EventRow = {
      ...current,
      decision: 'allow' as Decision, reason: null, checksum_ok: true,
      confidence: 0.96, read_count: current.read_count + 1,
      last_read_at: new Date().toISOString(),
    }
    if (supabase) {
      const { error } = await supabase
        .from('events')
        .update({ decision: 'allow', reason: null, checksum_ok: true,
                  confidence: next.confidence, read_count: next.read_count, last_read_at: next.last_read_at })
        .eq('id', current.id)
      if (!error) { setNote(null); return }
      setNote(explain(error.code, error.message))
    }
    onLocalEvent(next)
  }

  if (!open) {
    return (
      <button type="button" className="devpanel__collapsed" onClick={() => setOpen(true)}>
        SIMULATE
      </button>
    )
  }

  return (
    <div className="devpanel">
      <div className="devpanel__title">
        SIMULATE · ?dev=1
        <button type="button" className="btn btn--link" style={{ padding: 0 }} onClick={() => setOpen(false)}>
          HIDE
        </button>
      </div>

      {SCENARIOS.map((s) => (
        <button key={s.key} type="button" onClick={() => void fire(s)}>{s.label}</button>
      ))}

      <button type="button" onClick={() => void reread()} disabled={!current}>
        RE-READ CURRENT · read_count +1
      </button>
      <button type="button" onClick={() => void upgrade()} disabled={current?.decision !== 'check'}>
        UPGRADE CHECK → ALLOW
      </button>
      <button type="button" onClick={onToggleCamera}>
        CAMERA A · {cameraOnline ? 'GO OFFLINE' : 'GO LIVE'}
      </button>

      {note && <p className="devpanel__note">{note}</p>}
    </div>
  )
}
