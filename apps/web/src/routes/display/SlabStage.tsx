import { formatDate } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import { CheckIcon, CrossIcon } from '../../lib/icons'
import { REASON_TITLE, VERB, type EventRow, type VehiclePublic } from '../../lib/types'
import { GuardActions, type GuardActionRequest } from './GuardActions'

interface Props {
  event: EventRow
  vehicle: VehiclePublic | null
  onAct: (request: GuardActionRequest) => void
}

/** The second line under DO NOT ALLOW — what the guard should actually do about it. */
function denyDetail(event: EventRow, vehicle: VehiclePublic | null): string {
  const plate = formatPlate(event.plate_norm ?? '')
  switch (event.reason) {
    case 'not_on_list':
      return `No vehicle record for ${plate} · stop and verify with the driver`
    case 'expired':
      return vehicle
        ? `${vehicle.owner_name} · pass ran out ${formatDate(vehicle.valid_until)} · stop and verify`
        : `Pass for ${plate} has run out · stop and verify with the driver`
    case 'suspended':
      return vehicle
        ? `${vehicle.owner_name} · pass suspended · do not admit without authorisation`
        : `Pass for ${plate} is suspended · do not admit without authorisation`
    default:
      return `Stop and verify with the driver`
  }
}

/** allow and deny: one giant plate, one verb, one line saying why. gate-allowed / gate-denied. */
export function SlabStage({ event, vehicle, onAct }: Props) {
  const allow = event.decision === 'allow'
  const Icon = allow ? CheckIcon : CrossIcon

  return (
    <>
      <span className="plate plate--stage">{formatPlate(event.plate_norm ?? event.plate_raw ?? '')}</span>

      <div className="verb">
        <Icon className="verb__icon" />
        {VERB[event.decision]}
      </div>

      {allow ? (
        // Deliberately just this, not the owner's name and unit.
        //
        // The canvas (gate-allowed.png) showed "Tan Wei Ming · HQ Coy · Permanent pass ·
        // valid to 31 Dec 2026", but the guard does not need any of it to wave a car
        // through — the system has already decided — and the gate screen is readable from
        // outside the post. Owner names are personal data (brief §3.10), so a green that
        // broadcasts them is a privacy cost with no operational benefit.
        //
        // The details still exist where they are actually used: the DENY reason lines
        // below, manual mode, and /admin.
        <p className="stage__secondary">On the approved list</p>
      ) : (
        <>
          <p className="stage__reason-title">{event.reason ? REASON_TITLE[event.reason] : 'Not allowed'}</p>
          <p className="stage__detail">{denyDetail(event, vehicle)}</p>
          <GuardActions onAct={onAct} />
        </>
      )}
    </>
  )
}
