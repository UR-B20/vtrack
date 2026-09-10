/**
 * status.ts — the one place that decides what a vehicle row's validity means.
 *
 * admin.png renders five badges (ACTIVE, EXPIRING 11 d, EXPIRES TODAY, EXPIRED,
 * SUSPENDED), header counts and filter-chip counts; gate-offline.png renders the same
 * rule as ALLOWED / EXPIRED pills in manual mode. That is a decision rule, so per
 * CLAUDE.md §1 it is pure and tested rather than scattered across components — and it
 * mirrors the vehicle half of the engine's decide.py (§5.2), so admin and gate can
 * never disagree about who is on the list.
 *
 * Pure: values in, values out. `today` is passed in; nothing here reads the clock.
 */

/** admin.png header: "9 expiring within 30 days". */
export const EXPIRING_DAYS = 30

export type StatusKind = 'suspended' | 'not_yet_valid' | 'expired' | 'expires_today' | 'expiring' | 'active'

export interface VehicleStatus {
  kind: StatusKind
  /** Badge text, exactly as the screens render it. */
  label: string
  /** Days until valid_until. Negative once expired, null when there is no end date. */
  daysLeft: number | null
  /** Would this vehicle be waved through today? §5.2's vehicle half. */
  allowed: boolean
}

export interface StatusInput {
  status: string | null
  valid_from: string | null
  valid_until: string | null
}

/** Whole days from `from` to `to`, both 'YYYY-MM-DD'. Calendar arithmetic, not elapsed time. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

/**
 * `today` must be a calendar date in the gate's timezone, as 'YYYY-MM-DD' — see
 * `todayAtGate()`. Comparing calendar dates as strings is deliberate: millisecond
 * arithmetic on timestamps would flip "expires today" to EXPIRED eight hours early for
 * anyone west of Singapore.
 */
export function vehicleStatus(v: StatusInput, today: string): VehicleStatus {
  const daysLeft = v.valid_until ? daysBetween(today, v.valid_until) : null

  // Suspension wins over everything: a suspended pass is suspended whether or not it
  // has also run out (§5.2 checks status before validity).
  if (v.status === 'suspended') return { kind: 'suspended', label: 'SUSPENDED', daysLeft, allowed: false }

  if (v.valid_from && today < v.valid_from) {
    return { kind: 'not_yet_valid', label: 'NOT YET VALID', daysLeft, allowed: false }
  }
  if (v.valid_until && today > v.valid_until) {
    return { kind: 'expired', label: 'EXPIRED', daysLeft, allowed: false }
  }
  if (v.valid_until && today === v.valid_until) {
    return { kind: 'expires_today', label: 'EXPIRES TODAY', daysLeft: 0, allowed: true }
  }
  if (daysLeft !== null && daysLeft <= EXPIRING_DAYS) {
    return { kind: 'expiring', label: `EXPIRING ${daysLeft} d`, daysLeft, allowed: true }
  }
  return { kind: 'active', label: 'ACTIVE', daysLeft, allowed: true }
}

/** The gate's calendar date. The one impure helper, kept out of the rule above. */
export function todayAtGate(now: Date = new Date()): string {
  // en-CA gives ISO-shaped YYYY-MM-DD.
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
}

/** The admin filter chips of admin.png / §6.3. */
export type VehicleFilter = 'all_active' | 'visitors' | 'expiring' | 'suspended'

export function matchesFilter(
  v: StatusInput & { pass_type: string | null },
  filter: VehicleFilter,
  today: string,
): boolean {
  const s = vehicleStatus(v, today)
  switch (filter) {
    // "All active" is the default chip: everything still good to enter today.
    case 'all_active': return s.allowed
    case 'visitors':   return v.pass_type === 'visitor'
    case 'expiring':   return s.kind === 'expiring' || s.kind === 'expires_today'
    case 'suspended':  return s.kind === 'suspended'
  }
}
