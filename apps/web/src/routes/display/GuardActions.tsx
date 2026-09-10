import { useState } from 'react'
import type { GuardActionKind } from '../../lib/types'

export interface GuardActionRequest {
  action: GuardActionKind
  reason: string | null
  actor: string
}

interface Props {
  /** Rendered on deny and check only — an allow is not something the guard acts on. */
  onAct: (request: GuardActionRequest) => void
  /** CHECK offers a third action: confirm the best guess. */
  confirmLabel?: string
  onConfirm?: () => void
}

const ACTOR_KEY = 'vtrack:actor'

function storedActor(): string {
  try {
    return localStorage.getItem(ACTOR_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberActor(name: string): void {
  try {
    localStorage.setItem(ACTOR_KEY, name)
  } catch {
    /* storage blocked — the name still applies for this session */
  }
}

/**
 * LET THROUGH · OVERRIDE and TURNED AWAY (§6.1).
 *
 * Every override is attributed (§3.10) — the guard is asked for a reason and, once per
 * device, for their name, and both go into `guard_actions`. There is no anonymous path:
 * an unattributed override is worth less than no override at all.
 */
export function GuardActions({ onAct, confirmLabel, onConfirm }: Props) {
  const [prompting, setPrompting] = useState<GuardActionKind | null>(null)
  const [actor, setActor] = useState(storedActor)
  const [reason, setReason] = useState('')

  function submit() {
    if (!prompting) return
    const name = actor.trim()
    if (!name || !reason.trim()) return
    rememberActor(name)
    onAct({ action: prompting, reason: reason.trim(), actor: name })
    setPrompting(null)
    setReason('')
  }

  return (
    <>
      <div className="actions">
        {confirmLabel && onConfirm && (
          <button type="button" className="action action--primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        )}
        <button type="button" className="action" onClick={() => setPrompting('let_through')}>
          LET THROUGH · OVERRIDE
        </button>
        <button type="button" className="action" onClick={() => setPrompting('turned_away')}>
          TURNED AWAY
        </button>
      </div>

      {prompting && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Record this decision">
          <div className="modal">
            <h2>{prompting === 'let_through' ? 'Override — let this vehicle through' : 'Turned away'}</h2>
            <p className="modal__hint">
              This is logged against your name and kept in the audit trail. Say what you checked.
            </p>

            <div className="field">
              <label htmlFor="ga-actor">YOUR NAME</label>
              <input
                id="ga-actor" value={actor} autoFocus={!actor}
                onChange={(e) => setActor(e.target.value)} placeholder="e.g. Guard Tan"
              />
            </div>

            <div className="field">
              <label htmlFor="ga-reason">REASON</label>
              <input
                id="ga-reason" value={reason} autoFocus={Boolean(actor)}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                placeholder="e.g. Driver has a signed visitor pass"
              />
            </div>

            <div className="modal__row">
              <button type="button" className="btn" onClick={() => setPrompting(null)}>Cancel</button>
              <button
                type="button" className="btn btn--primary" onClick={submit}
                disabled={!actor.trim() || !reason.trim()}
              >
                Record
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
