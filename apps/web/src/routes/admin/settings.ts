/**
 * settings.ts — /admin → Settings (CLAUDE.md §6.3): the engine's thresholds, read from its
 * public /health and explained, not edited. Pure.
 */

export interface ThresholdRow { key: string; env: string; label: string; value: string; meaning: string }

const THRESHOLDS: { key: string; env: string; label: string; unit?: string; meaning: string }[] = [
  { key: 'conf_decide', env: 'CONF_DECIDE', label: 'Confident read',
    meaning: 'A read at or above this decides with no VERIFY badge.' },
  { key: 'conf_check', env: 'CONF_CHECK', label: 'Usable read',
    meaning: 'Below this the screen is orange (unclear read), whatever the plate.' },
  { key: 'dedupe_s', env: 'DEDUPE_S', label: 'Same vehicle window', unit: 's',
    meaning: 'Reads of one plate this close together update one result instead of adding another.' },
  { key: 'repair_max_subs', env: 'REPAIR_MAX_SUBS', label: 'Character corrections',
    meaning: 'How many look-alike characters (0/O, 8/B…) may be swapped to fit a Singapore plate. A corrected read is always orange.' },
  { key: 'max_frame_age_s', env: 'MAX_FRAME_AGE_S', label: 'Oldest photo accepted', unit: 's',
    meaning: 'A photo older than this when it arrives is refused, so a late one cannot decide for the next car.' },
  { key: 'rate_limit_per_s', env: 'RATE_LIMIT_PER_S', label: 'Requests per second', unit: '/s',
    meaning: 'Per device token; more are refused.' },
  { key: 'detector_conf', env: 'ALPR_DETECTOR_CONF', label: 'Plate detector',
    meaning: 'How sure the model must be that there is a plate in the photo before reading it.' },
]

export function thresholdRows(values: Record<string, number> | undefined | null): ThresholdRow[] {
  return THRESHOLDS.map((t) => {
    const v = values?.[t.key]
    return {
      key: t.key, env: t.env, label: t.label, meaning: t.meaning,
      value: typeof v === 'number' ? `${v}${t.unit ? ` ${t.unit}` : ''}` : '—',
    }
  })
}

/** "3 d 4 h", "5 h 12 min", "42 min", "8 s". */
export function uptime(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || seconds < 0) return '—'
  const d = Math.floor(seconds / 86_400), h = Math.floor((seconds % 86_400) / 3600), m = Math.floor((seconds % 3600) / 60)
  if (d) return `${d} d ${h} h`
  if (h) return `${h} h ${m} min`
  if (m) return `${m} min`
  return `${Math.floor(seconds)} s`
}
