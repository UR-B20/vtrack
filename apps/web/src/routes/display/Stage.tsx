import { formatAge, formatClock, formatShortClock } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import { CheckIcon, CrossIcon, WarnIcon } from '../../lib/icons'
import { todayAtGate } from '../../lib/status'
import { RAIL_WORD, VERB, type EventRow, type VehiclePublic } from '../../lib/types'
import { HOLD } from './displayMachine'
import { screenLine, toneOf } from './screen'

interface Props {
  event: EventRow | null
  vehicle: VehiclePublic | null
  /** Local ms of the most recent read for this event — the trust line counts from here. */
  lastReadLocal: number | null
  /** Local ms at which the hold expires, for the progress bar. */
  clearAt: number | null
  stageSince: number | null
  now: number
  /** Newest rail entry, for the standby header's "LAST READ ...". */
  lastRead: EventRow | null
  cacheSyncedAt: number | null
  cacheCount: number
  /** Why the list did not refresh, if it did not. */
  cacheError: string | null
  /** The guard has seen the result for this event. */
  onOk: (eventId: string) => void
}

/** How much of the hold window is left, 0–1. */
function holdProgress(stageSince: number | null, clearAt: number | null, now: number): number {
  if (stageSince === null || clearAt === null || clearAt <= stageSince) return 1
  return Math.max(0, Math.min(1, (clearAt - now) / (clearAt - stageSince)))
}

const ICON = { allow: CheckIcon, deny: CrossIcon, check: WarnIcon }

/**
 * The stage: the vehicle in front of the guard now, refined in place (brief §1).
 *
 * One layout for all three screens (screen.ts): plate, one word, one line, and OK — the one
 * button (owner's call, 13 Oct 2026). OK clears the result once the guard has seen it, so the
 * next car never pulls up under the last car's colour. TYPE A PLATE stays in the rail.
 */
export function Stage(props: Props) {
  const { event, vehicle, lastReadLocal, clearAt, stageSince, now, lastRead, cacheSyncedAt, cacheCount, cacheError, onOk } = props

  if (!event) {
    return (
      <section className="stage stage--standby">
        <div className="stage__head">
          <span>
            {lastRead
              ? `LAST READ ${formatClock(lastRead.ts)} · ${formatPlate(lastRead.plate_norm ?? '')} · ${RAIL_WORD[toneOf(lastRead)]}`
              : 'NO READS YET'}
          </span>
          <span style={cacheError ? { color: 'var(--check)' } : undefined}>
            {cacheError
              ? `LIST NOT SYNCED · ${cacheError.toUpperCase()}`
              : `LIST SYNCED ${formatShortClock(cacheSyncedAt)} · ${cacheCount} VEHICLES`}
          </span>
        </div>

        <div className="stage__body">
          <div className="standby">
            <span className="plate plate--stage" style={{ opacity: 0.28 }}>— — — —</span>
            <h1 className="standby__title">Waiting for vehicle</h1>
            <span className="standby__sub">RESULTS APPEAR HERE WITHIN A SECOND</span>
          </div>
        </div>
      </section>
    )
  }

  const tone = toneOf(event)
  const Icon = ICON[tone]
  // §5.2: a read between CONF_CHECK and CONF_DECIDE still admits, but says so.
  const verify = tone === 'allow' && event.confidence !== null && event.confidence < 0.85

  return (
    <section className="stage" data-decision={tone}>
      <div className="stage__head">
        <span>
          READ {formatAge(lastReadLocal, now)} AGO
          {event.source === 'manual' ? ' · TYPED BY GUARD' : ''}
        </span>
        {verify && <span className="badge-verify">VERIFY</span>}
      </div>

      <div className="stage__body">
        <span className="plate plate--stage">{formatPlate(event.plate_norm ?? event.plate_raw ?? '')}</span>
        <div className="verb">
          <Icon className="verb__icon" />
          <span>{VERB[tone]}</span>
        </div>
        <p className="stage__secondary">{screenLine(event, vehicle, todayAtGate())}</p>
      </div>

      <button type="button" className="stage__ok" onClick={() => onOk(event.id)}
        aria-label={`OK — seen ${formatPlate(event.plate_norm ?? '')} ${VERB[tone]}`}>
        OK
      </button>

      <div className="stage__foot">
        <div className="holdbar">
          <div className="holdbar__fill" style={{ width: `${holdProgress(stageSince, clearAt, now) * 100}%` }} />
        </div>
        <span>PRESS OK ONCE SEEN · OTHERWISE CLEARS {HOLD.afterLastRead / 1000} s AFTER THE LAST READ</span>
      </div>
    </section>
  )
}
