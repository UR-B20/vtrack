/**
 * screen.ts — what the gate screen at B shows for an event (CLAUDE.md §11, Gate screen,
 * 13 Oct 2026). Pure: values in, values out, tested in screen.test.ts.
 *
 * Three screens, one layout — plate, one word, one line — and nothing to press:
 *
 *   GREEN   allow                          PROCEED
 *   RED     deny, reason foreign           DO NOT ALLOW     only Singapore plates are admitted
 *   ORANGE  everything else                VERIFY MANUALLY  the guard looks
 *
 * The engine's decision is unchanged and is what is stored: a Singapore car that is not on
 * the list is still `deny / not_on_list` in `events`. Only the screen treats it as a case for
 * the guard, because the one definite refusal at this gate is a foreign plate.
 */

import { formatDate } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import type { Decision, EventRow, VehiclePublic } from '../../lib/types'

/** The screen's colour, word, icon and chime. Reuses the decision names as its three keys. */
export type Tone = Decision

export function toneOf(e: Pick<EventRow, 'decision' | 'reason'>): Tone {
  if (e.decision === 'allow') return 'allow'
  if (e.decision === 'deny' && e.reason === 'foreign') return 'deny'
  return 'check'
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

/** The one line under the word, for every screen. */
export function screenLine(e: EventRow, vehicle: VehiclePublic | null, today: string): string {
  const tone = toneOf(e)
  if (tone === 'allow') return allowDetail(vehicle, today)
  if (tone === 'deny') return 'Foreign plate · only Singapore plates are admitted'

  // ORANGE. A corrected read says what the camera actually saw, so the guard can compare it
  // with the car: the big plate is the best guess, not necessarily what is on the car.
  if (e.repaired_from) return `Camera read ${formatPlate(e.repaired_from)} · check the plate`
  switch (e.reason) {
    case 'not_on_list':
      return 'Not on the approved list'
    case 'expired':
      if (vehicle?.valid_from && vehicle.valid_from > today) {
        return `${vehicle.owner_name} · pass starts ${formatDate(vehicle.valid_from)}`
      }
      return vehicle?.valid_until ? `${vehicle.owner_name} · pass ended ${formatDate(vehicle.valid_until)}` : 'Pass has expired'
    case 'suspended':
      return vehicle ? `${vehicle.owner_name} · pass suspended` : 'Pass suspended'
    case 'low_confidence':
      return 'Unclear read · check the plate'
    case 'ambiguous':
      return 'Unsure which plate · check the plate'
    default:
      return 'Plate not recognised · check the plate'
  }
}
