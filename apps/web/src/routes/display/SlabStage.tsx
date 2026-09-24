import { formatDate } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import { todayAtGate } from '../../lib/status'
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

/**
 * The line under PROCEED, as in gate-allowed.png: "Tan Wei Ming · HQ Coy · Permanent pass ·
 * valid to 31 Dec 2026". `today` is the gate's calendar date ('YYYY-MM-DD', todayAtGate).
 * With no list row to hand (the cached list has not synced yet) it says only what is known.
 */
export function allowDetail(vehicle: VehiclePublic | null, today: string): string {
  if (!vehicle) return 'On the approved list'
  const pass = `${vehicle.pass_type.charAt(0).toUpperCase()}${vehicle.pass_type.slice(1)} pass`
  const until = vehicle.valid_until
    ? (vehicle.valid_until === today ? 'valid today' : `valid to ${formatDate(vehicle.valid_until)}`)
    : null
  return [vehicle.owner_name, vehicle.org_unit, pass, until].filter(Boolean).join(' · ')
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
        // The owner's details, as the canvas has them (owner's decision, 24 Sep 2026 —
        // CLAUDE.md §11). M0 had left them off because the gate screen can be read from
        // outside the post and owner names are personal data (brief §3.10): place the
        // screen so it faces the guard, not the lane.
        <p className="stage__secondary">{allowDetail(vehicle, todayAtGate())}</p>
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
