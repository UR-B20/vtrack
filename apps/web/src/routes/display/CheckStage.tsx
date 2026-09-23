import { useEffect, useState } from 'react'
import { classify, diffPlates, formatPlate, normalise } from '../../lib/plates'
import { WarnIcon } from '../../lib/icons'
import { VERB, type EventRow, type VehiclePublic } from '../../lib/types'
import { GuardActions, type GuardActionRequest } from './GuardActions'

interface Props {
  event: EventRow
  /** The vehicle the best guess matches, if it is on the list. */
  vehicle: VehiclePublic | null
  onAct: (request: GuardActionRequest) => void
  onConfirm: (plateNorm: string) => void
}

/**
 * The CHECK stage (gate-check.png) — deliberately not the allow/deny layout in amber.
 *
 * Left: what the camera saw, with the substituted character called out, so the guard can
 * check our guess against the plate in front of them. Right: confirm it or type the real
 * one, with the checksum validated as they type. This is the screen that stops a misread
 * becoming a confident wrong green.
 */
export function CheckStage({ event, vehicle, onAct, onConfirm }: Props) {
  const best = event.plate_norm ?? ''
  const [typed, setTyped] = useState(() => formatPlate(best))

  // A better frame can upgrade the plate under the guard's fingers; follow it unless
  // they have started typing something of their own.
  useEffect(() => { setTyped(formatPlate(best)) }, [best])

  const typedNorm = normalise(typed)
  const { kind, checksumOk, canonical } = classify(typedNorm)
  const typedValid = typedNorm.length > 0 && kind !== 'invalid' && checksumOk
  const diff = diffPlates(event.repaired_from ?? event.plate_raw, best)

  return (
    <>
      <div className="verb">
        <WarnIcon className="verb__icon" />
        {VERB.check}
      </div>

      <div className="check-grid">
        <section className="panel">
          <span className="panel__label">WHAT THE CAMERA SAW</span>

          {/* events.image_path stays null until the engine writes crops in M3 (§8). */}
          <div className="crop">
            <span className="plate plate--chip" style={{ fontSize: 22 }}>
              {formatPlate(event.plate_raw ?? best)}
            </span>
            <span className="crop__note">NO CROP · M3</span>
          </div>

          {event.plate_raw && (
            <div className="rawread">
              <span className="rawread__label">RAW READ</span>
              <span className="rawread__value">
                {diff.chars.length && diff.subs.length
                  ? diff.chars.map((c, i) => (
                      <span key={i} className={c.changed ? 'rawread__char--changed' : undefined}>
                        {/* show the raw character at the changed position, not the guess */}
                        {c.changed ? (normalise(event.repaired_from ?? event.plate_raw ?? '')[i] ?? c.ch) : c.ch}
                      </span>
                    ))
                  : formatPlate(event.plate_raw)}
              </span>
            </div>
          )}

          <p className="panel__note">
            {diff.subs.length > 0 ? (
              <>
                Best guess <span className="plate plate--sm">{formatPlate(best)}</span>
                {' · '}
                {diff.subs.map((s) => `${s.from} → ${s.to}`).join(', ')} repaired
                {vehicle ? <> · on the list: {vehicle.owner_name}{vehicle.org_unit ? `, ${vehicle.org_unit}` : ''}</> : ' · not on the list'}
              </>
            ) : (
              <>
                Best guess <span className="plate plate--sm">{formatPlate(best)}</span>
                {vehicle ? <> · on the list: {vehicle.owner_name}{vehicle.org_unit ? `, ${vehicle.org_unit}` : ''}</> : ' · not on the list'}
              </>
            )}
          </p>
        </section>

        <section className="panel">
          <span className="panel__label">CONFIRM OR TYPE THE PLATE</span>

          <input
            className={`plate-input${typedNorm && !typedValid ? ' plate-input--invalid' : ''}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            aria-label="Plate"
            spellCheck={false}
            autoCapitalize="characters"
          />

          <span className={`checkline ${typedValid ? 'checkline--ok' : 'checkline--bad'}`}>
            {typedNorm.length === 0
              ? 'TYPE A PLATE'
              : kind === 'invalid'
                ? '✕ NOT A PLATE PATTERN'
                : kind === 'civilian'
                  ? (checksumOk ? '✓ VALID' : '✕ CHECK LETTER WRONG')
                  : kind === 'mid'
                    ? '✓ MID PLATE'
                    : '✓ FOREIGN — NO CHECKSUM'}
          </span>

          <GuardActions
            onAct={onAct}
            confirmLabel={typedValid ? `CONFIRM · ${formatPlate(canonical)}` : undefined}
            onConfirm={typedValid ? () => onConfirm(canonical) : undefined}
          />

          <p className="panel__help">
            Typing checks the checksum as you go — an invalid letter is flagged before you confirm.
          </p>
        </section>
      </div>
    </>
  )
}
