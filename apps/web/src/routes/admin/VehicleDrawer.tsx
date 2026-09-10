import { useEffect, useMemo, useState } from 'react'
import { checksumLetter, classify, formatPlate, normalise } from '../../lib/plates'
import type { Vehicle } from '../../lib/types'

export type VehicleDraft = Omit<Vehicle, 'id' | 'created_at' | 'updated_at'> & { id?: string }

interface Props {
  vehicle: Vehicle | null
  /** Plates already on the list, so "already on the list" is caught before the insert. */
  existing: Set<string>
  onSave: (draft: VehicleDraft) => Promise<string | null>
  onDelete: ((id: string) => Promise<string | null>) | null
  onClose: () => void
}

const VEHICLE_TYPES = ['car', 'motorcycle', 'goods', 'military'] as const
const PASS_TYPES = ['permanent', 'visitor', 'contractor'] as const

const empty: VehicleDraft = {
  plate_norm: '', plate_display: '', owner_name: '', org_unit: '',
  vehicle_type: 'car', pass_type: 'permanent', status: 'active',
  valid_from: null, valid_until: null, notes: null,
}

/**
 * Add / edit drawer with live checksum validation (§6.3).
 *
 * The check letter is validated as it is typed, which is the cheapest accuracy the
 * system has (brief §2, position 6): a plate that cannot exist should never reach the
 * approved list, because a wrong row there produces a wrong decision at the gate for
 * as long as nobody notices.
 */
export function VehicleDrawer({ vehicle, existing, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState<VehicleDraft>(() => (vehicle ? { ...vehicle } : { ...empty }))
  const [typed, setTyped] = useState(() => (vehicle ? vehicle.plate_display : ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(vehicle ? { ...vehicle } : { ...empty })
    setTyped(vehicle ? vehicle.plate_display : '')
    setError(null)
  }, [vehicle])

  const plate = useMemo(() => {
    const norm = normalise(typed)
    const { kind, canonical, checksumOk } = classify(norm)
    const m = /^([A-Z]{1,3})(\d{1,4})([A-Z])$/.exec(norm)
    const expected = m ? checksumLetter(m[1] as string, m[2] as string) : null
    const duplicate = canonical !== '' && canonical !== vehicle?.plate_norm && existing.has(canonical)
    const valid = norm.length > 0 && kind !== 'invalid' && checksumOk && !duplicate
    return { norm, kind, canonical, checksumOk, expected, duplicate, valid }
  }, [typed, existing, vehicle?.plate_norm])

  function note(): { text: string; tone: 'ok' | 'bad' | 'muted' } {
    if (!plate.norm) return { text: 'Enter the plate as painted on the vehicle.', tone: 'muted' }
    if (plate.kind === 'invalid') return { text: 'Not a recognisable plate pattern.', tone: 'bad' }
    if (plate.kind === 'civilian' && !plate.checksumOk) {
      return { text: `Checksum fails · check letter should be ${plate.expected}.`, tone: 'bad' }
    }
    if (plate.duplicate) return { text: `${formatPlate(plate.canonical)} is already on the list.`, tone: 'bad' }
    const series =
      plate.kind === 'mid' ? 'MID series · no checksum'
      : plate.kind === 'foreign' ? 'foreign plate · no checksum'
      : 'civilian series'
    return { text: `Checksum valid · ${series} · not yet on the list`, tone: 'ok' }
  }

  async function save() {
    if (!plate.valid || !draft.owner_name.trim()) return
    setBusy(true); setError(null)
    const message = await onSave({
      ...draft,
      plate_norm: plate.canonical,
      plate_display: formatPlate(plate.canonical),
      owner_name: draft.owner_name.trim(),
      org_unit: draft.org_unit?.trim() || null,
      notes: draft.notes?.trim() || null,
    })
    setBusy(false)
    if (message) setError(message)
    else onClose()
  }

  async function remove() {
    if (!vehicle?.id || !onDelete) return
    if (!window.confirm(`Remove ${vehicle.plate_display} from the list?`)) return
    setBusy(true)
    const message = await onDelete(vehicle.id)
    setBusy(false)
    if (message) setError(message)
    else onClose()
  }

  const n = note()

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={vehicle ? 'Edit vehicle' : 'Add vehicle'}>
        <div className="drawer__head">
          <h2>{vehicle ? 'Edit vehicle' : 'Add vehicle'}</h2>
          <button className="btn btn--link" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="drawer__body">
          <div className="field">
            <label htmlFor="v-plate">PLATE</label>
            <input
              id="v-plate" className="mono" value={typed} autoFocus spellCheck={false} autoCapitalize="characters"
              onChange={(e) => setTyped(e.target.value)}
            />
            <span className={`field__note field__note--${n.tone}`}>{n.text}</span>
          </div>

          <div className="field">
            <label htmlFor="v-owner">OWNER NAME</label>
            <input id="v-owner" value={draft.owner_name}
              onChange={(e) => setDraft({ ...draft, owner_name: e.target.value })} />
          </div>

          <div className="field">
            <label htmlFor="v-org">UNIT / ORG</label>
            <input id="v-org" value={draft.org_unit ?? ''}
              onChange={(e) => setDraft({ ...draft, org_unit: e.target.value })} />
          </div>

          <div className="field">
            <label>VEHICLE TYPE</label>
            <div className="segmented">
              {VEHICLE_TYPES.map((t) => (
                <button key={t} type="button" aria-pressed={draft.vehicle_type === t}
                  onClick={() => setDraft({ ...draft, vehicle_type: t })}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>PASS TYPE</label>
            <div className="segmented">
              {PASS_TYPES.map((t) => (
                <button key={t} type="button" aria-pressed={draft.pass_type === t}
                  onClick={() => setDraft({ ...draft, pass_type: t })}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="field__row">
            <div className="field">
              <label htmlFor="v-from">VALID FROM</label>
              <input id="v-from" type="date" value={draft.valid_from ?? ''}
                onChange={(e) => setDraft({ ...draft, valid_from: e.target.value || null })} />
            </div>
            <div className="field">
              <label htmlFor="v-until">VALID UNTIL</label>
              <input id="v-until" type="date" value={draft.valid_until ?? ''}
                onChange={(e) => setDraft({ ...draft, valid_until: e.target.value || null })} />
            </div>
          </div>

          <div className="field">
            <label>STATUS</label>
            <div className="segmented">
              {(['active', 'suspended'] as const).map((s) => (
                <button key={s} type="button" aria-pressed={draft.status === s}
                  onClick={() => setDraft({ ...draft, status: s })}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label htmlFor="v-notes">NOTES</label>
            <input id="v-notes" value={draft.notes ?? ''} placeholder="Optional"
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </div>

          {error && <p className="error-note">{error}</p>}
        </div>

        <div className="drawer__foot">
          <button className="btn btn--navy" onClick={() => void save()}
            disabled={busy || !plate.valid || !draft.owner_name.trim()}>
            {busy ? 'SAVING…' : 'SAVE VEHICLE'}
          </button>
          <button className="btn btn--link" onClick={onClose}>Cancel</button>
          {vehicle && onDelete && (
            <button className="btn btn--link" style={{ marginLeft: 'auto', color: 'var(--deny-field)' }}
              onClick={() => void remove()} disabled={busy}>
              Remove
            </button>
          )}
        </div>
      </aside>
    </>
  )
}
