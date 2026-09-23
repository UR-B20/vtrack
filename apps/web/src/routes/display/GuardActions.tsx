import { useState } from 'react'
import type { GuardActionKind } from '../../lib/types'

export interface GuardActionRequest {
  action: GuardActionKind
  reason: string | null
  actor: string | null
}

interface Props {
  /** Rendered on deny and check only — an allow is not something the guard acts on. */
  onAct: (request: GuardActionRequest) => void
  /** CHECK offers a third action: confirm the best guess. */
  confirmLabel?: string
  onConfirm?: () => void
}

const ACTOR_KEY = 'vtrack:actor'

export function storedActor(): string {
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
 * The two actions are deliberately asymmetric.
 *
 * TURNED AWAY is one tap. It is the guard agreeing with a decision the system already
 * made, so there is nothing to justify — and putting a form in front of the correct
 * action is how you train people to stop using it. The row is still written to
 * `guard_actions` for the audit trail; it just carries no typing.
 *
 * LET THROUGH is the override: admitting a vehicle the system said to stop. That is the
 * one that has to be attributed (§3.10), so it asks for a reason and, once per device,
 * for a name. There is no anonymous path through it — an unattributed override is worth
 * less than no override at all.
 */
export function GuardActions({ onAct, confirmLabel, onConfirm }: Props) {
  const [prompting, setPrompting] = useState(false)
  const [actor, setActor] = useState(storedActor)
  const [reason, setReason] = useState('')

  function submitOverride() {
    const name = actor.trim()
    if (!name || !reason.trim()) return
    rememberActor(name)
    onAct({ action: 'let_through', reason: reason.trim(), actor: name })
    setPrompting(false)
    setReason('')
  }

  function turnAway() {
    // No prompt. If this device already knows who is on shift, the row carries it;
    // otherwise it is logged without a name rather than blocking on one.
    onAct({ action: 'turned_away', reason: null, actor: storedActor() || null })
  }

  return (
    <>
      <div className="actions">
        {confirmLabel && onConfirm && (
          <button type="button" className="action action--primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        )}
        <button type="button" className="action" onClick={() => setPrompting(true)}>
          LET THROUGH · OVERRIDE
        </button>
        <button type="button" className="action" onClick={turnAway}>
          TURNED AWAY
        </button>
      </div>

      {prompting && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Record this override">
          <div className="modal">
            <h2>Override — let this vehicle through</h2>
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
                onKeyDown={(e) => { if (e.key === 'Enter') submitOverride() }}
                placeholder="e.g. Driver has a signed visitor pass"
              />
            </div>

            <div className="modal__row">
              <button type="button" className="btn" onClick={() => setPrompting(false)}>Cancel</button>
              <button
                type="button" className="btn btn--primary" onClick={submitOverride}
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
