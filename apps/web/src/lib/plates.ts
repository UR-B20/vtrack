/**
 * plates.ts — Singapore plate normalisation, classification, checksum and repair.
 *
 * A faithful port of the reference implementation in CLAUDE.md §5.1. The engine's
 * `plates.py` is the authority; this mirror exists so the admin drawer can validate a
 * check letter as you type and the display can format and diff a plate without a
 * round trip. Any change here must be made in both, and §5.1's assertions are the
 * shared oracle — they are the first block of plates.test.ts.
 *
 * Pure: values in, values out. No I/O.
 */

export type PlateKind = 'civilian' | 'mid' | 'foreign' | 'invalid'

const CHECK_LETTERS = 'AZYXUTSRPMLKJHGEDCB'
const WEIGHTS = [9, 4, 5, 4, 3, 2] as const

const CIVILIAN = /^([A-Z]{1,3})(\d{1,4})([A-Z])$/
const MID = /^(?:MID(\d{1,5})|(\d{1,5})MID)$/
const FOREIGN = /^[A-Z]{1,3}\d{1,4}[A-Z]?$/

/** OCR confusables, as in §5.1. Note 9 is deliberately absent: 9→O is not a
 *  substitution we will make, which is why SBS 988O U stays a CHECK. */
const CONFUSABLE: Record<string, string> = {
  '0': 'OD', O: '0', D: '0', '1': 'I', I: '1', '8': 'B', B: '8',
  '5': 'S', S: '5', '2': 'Z', Z: '2', '6': 'G', G: '6', '4': 'A', A: '4',
}

/** Strip everything that is not A–Z or 0–9 and upper-case the rest. */
export function normalise(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * The check letter for a civilian plate's prefix and number.
 * A one-letter prefix leaves the first weighted slot at zero (the '@' padding in §5.1).
 */
export function checksumLetter(prefix: string, number: string): string {
  const letters = prefix.slice(-2).padStart(2, '@')
  const values = [
    ...[...letters].map((c) => (c === '@' ? 0 : c.charCodeAt(0) - 64)),
    ...[...number.padStart(4, '0')].map((d) => Number(d)),
  ]
  const sum = WEIGHTS.reduce((acc, w, i) => acc + w * (values[i] ?? 0), 0)
  return CHECK_LETTERS[sum % 19] as string
}

export interface Classification {
  kind: PlateKind
  /** Canonical form: 'SBA1234G', 'MID12345', 'JHA1234'. */
  canonical: string
  checksumOk: boolean
}

/** Classify a plate string. MID is matched before civilian, as in §5.1. */
export function classify(plate: string): Classification {
  const p = normalise(plate)

  const mid = MID.exec(p)
  if (mid) {
    const digits = mid[1] ?? mid[2] ?? ''
    return { kind: 'mid', canonical: `MID${parseInt(digits, 10)}`, checksumOk: true }
  }

  const civ = CIVILIAN.exec(p)
  if (civ) {
    const [, prefix = '', number = '', check = ''] = civ
    return { kind: 'civilian', canonical: p, checksumOk: checksumLetter(prefix, number) === check }
  }

  // Malaysian and other foreign plates carry no checksum, so they are never repaired
  // and only ever matched exactly.
  if (FOREIGN.test(p)) return { kind: 'foreign', canonical: p, checksumOk: true }

  return { kind: 'invalid', canonical: p, checksumOk: false }
}

/** All k-combinations of `items`, k fixed. */
function combinations<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]]
  const out: T[][] = []
  for (let i = 0; i <= items.length - k; i++) {
    const head = items[i] as T
    for (const rest of combinations(items.slice(i + 1), k - 1)) out.push([head, ...rest])
  }
  return out
}

/** Cartesian product of the replacement alternatives at each chosen position. */
function product(groups: string[][]): string[][] {
  return groups.reduce<string[][]>(
    (acc, group) => acc.flatMap((prefix) => group.map((g) => [...prefix, g])),
    [[]],
  )
}

/**
 * Try confusable substitutions until a civilian plate validates.
 * Returns every candidate found at the *smallest* number of substitutions, so the
 * caller can tell "exactly one reading" (use it) from "several" (ambiguous → CHECK).
 */
export function repair(plate: string, maxSubs = 2): string[] {
  const p = normalise(plate)
  const positions = [...p].map((c, i) => (CONFUSABLE[c] ? i : -1)).filter((i) => i >= 0)
  const found: string[] = []

  for (let k = 1; k <= maxSubs; k++) {
    for (const combo of combinations(positions, k)) {
      const alternatives = combo.map((i) => [...(CONFUSABLE[p[i] as string] as string)])
      for (const replacement of product(alternatives)) {
        const candidate = [...p]
        combo.forEach((i, n) => { candidate[i] = replacement[n] as string })
        const { kind, canonical, checksumOk } = classify(candidate.join(''))
        if (kind === 'civilian' && checksumOk && !found.includes(canonical)) found.push(canonical)
      }
    }
    if (found.length) return found
  }
  return found
}

/**
 * Render a plate the way it is painted on the car: 'SBA1234G' → 'SBA 1234 G'.
 *
 * Deliberately tolerant of a raw OCR read, not just a canonical plate_norm — the CHECK
 * stage has to show what the camera actually saw ('SNB953BE' → 'SNB 953B E'). Never
 * throws and never returns empty for garbage; the worst case is the normalised string.
 */
export function formatPlate(plate: string): string {
  const p = normalise(plate)
  if (!p) return ''

  const mid = MID.exec(p)
  if (mid) return `MID ${parseInt(mid[1] ?? mid[2] ?? '', 10)}`

  // Leading letters, then everything up to a trailing letter, then that letter.
  const m = /^([A-Z]+)(.*?)([A-Z])$/.exec(p)
  if (m && p.length >= 3) {
    const [, prefix = '', middle = '', check = ''] = m
    if (middle) return `${prefix} ${middle} ${check}`
    return `${prefix} ${check}`
  }

  // No trailing letter (foreign plates such as JHA1234).
  const split = /^([A-Z]+)(\d+)$/.exec(p)
  if (split) return `${split[1]} ${split[2]}`

  return p
}

export interface PlateDiff {
  /** One entry per character of the best guess, flagged where the raw read differed. */
  chars: { ch: string; changed: boolean }[]
  /** The substitutions that were made, e.g. [{ from: 'B', to: '8' }]. */
  subs: { from: string; to: string }[]
}

/**
 * Character-level diff between a raw read and the repaired best guess, for the
 * "RAW READ SNB 953[B] E · B → 8 repaired" cue on the CHECK stage (gate-check.png).
 * Returns no highlights when there is no raw read or the lengths differ — we only
 * claim a substitution when we can point at it.
 */
export function diffPlates(rawRead: string | null | undefined, bestGuess: string): PlateDiff {
  const best = normalise(bestGuess)
  const raw = rawRead ? normalise(rawRead) : ''
  const chars = [...best].map((ch) => ({ ch, changed: false }))
  if (!raw || raw.length !== best.length || raw === best) return { chars, subs: [] }

  const subs: { from: string; to: string }[] = []
  for (let i = 0; i < best.length; i++) {
    if (raw[i] !== best[i]) {
      ;(chars[i] as { ch: string; changed: boolean }).changed = true
      subs.push({ from: raw[i] as string, to: best[i] as string })
    }
  }
  return { chars, subs }
}
