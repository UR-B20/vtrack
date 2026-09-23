import { formatAge, formatClock, formatConfidence, formatShortClock } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import { RAIL_WORD, type EventRow, type VehiclePublic } from '../../lib/types'
import { SlabStage } from './SlabStage'
import { CheckStage } from './CheckStage'
import type { GuardActionRequest } from './GuardActions'

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
  onAct: (request: GuardActionRequest) => void
  onConfirm: (plateNorm: string) => void
}

/** How much of the hold window is left, 0–1. */
function holdProgress(stageSince: number | null, clearAt: number | null, now: number): number {
  if (stageSince === null || clearAt === null || clearAt <= stageSince) return 1
  return Math.max(0, Math.min(1, (clearAt - now) / (clearAt - stageSince)))
}

/**
 * The stage: the vehicle in front of the guard now, refined in place (brief §1).
 * A shell around two very different bodies — see SlabStage and CheckStage.
 */
export function Stage(props: Props) {
  const { event, vehicle, lastReadLocal, clearAt, stageSince, now, lastRead, cacheSyncedAt, cacheCount, cacheError } = props

  if (!event) {
    return (
      <section className="stage stage--standby">
        <div className="stage__head">
          <span>
            {lastRead
              ? `LAST READ ${formatClock(lastRead.ts)} · ${formatPlate(lastRead.plate_norm ?? '')} · ${RAIL_WORD[lastRead.decision]}`
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
            <span className="standby__sub">WATCHING LANE A · RESULTS APPEAR HERE WITHIN A SECOND</span>
          </div>
        </div>

        <div className="stage__foot">THE LAST FIVE READS STAY IN THE RAIL · TYPE A PLATE TO SEARCH THE LIST</div>
      </section>
    )
  }

  const repaired = Boolean(event.repaired_from)
  // §5.2: a read between CONF_CHECK and CONF_DECIDE still decides, but says so.
  const verify = event.decision !== 'check' && event.confidence !== null && event.confidence < 0.85

  return (
    <section className="stage" data-decision={event.decision}>
      <div className="stage__head">
        <span>
          READ {formatAge(lastReadLocal, now)} AGO
          {event.read_count > 1 ? ` · ${event.read_count} READS` : ''}
          {event.source === 'manual' ? ' · TYPED BY GUARD' : ''}
        </span>
        <span>
          CONFIDENCE {formatConfidence(event.confidence)}
          {' · '}
          {event.checksum_ok === false
            ? (repaired ? 'CHECKSUM FAILED ON RAW READ' : 'CHECKSUM FAILED')
            : 'CHECKSUM VALID'}
          {repaired && <span className="badge-verify">REPAIRED</span>}
          {verify && <span className="badge-verify">VERIFY</span>}
        </span>
      </div>

      <div className="stage__body">
        {event.decision === 'check' ? (
          <CheckStage event={event} vehicle={vehicle} onAct={props.onAct} onConfirm={props.onConfirm} />
        ) : (
          <SlabStage event={event} vehicle={vehicle} onAct={props.onAct} />
        )}
      </div>

      <div className="stage__foot">
        {event.decision === 'allow' ? (
          <>
            <div className="holdbar" style={{ marginBottom: 12 }}>
              <div className="holdbar__fill" style={{ width: `${holdProgress(stageSince, clearAt, now) * 100}%` }} />
            </div>
            HOLDS WHILE THE CAR IS HERE · CLEARS 5 s AFTER IT LEAVES
          </>
        ) : event.decision === 'deny' ? (
          'HOLDS UNTIL YOU ACT OR THE CAR LEAVES · TURNED AWAY IS ONE TAP · OVERRIDE ASKS FOR A REASON AND IS LOGGED UNDER YOUR NAME'
        ) : (
          'HOLDS UNTIL YOU ACT · THE CAR IS STILL IN FRONT OF THE CAMERA, SO A CLEARER FRAME CAN UPGRADE THIS BY ITSELF'
        )}
      </div>
    </section>
  )
}
