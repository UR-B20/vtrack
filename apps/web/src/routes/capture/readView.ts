/**
 * readView.ts — what the capture screen shows for one engine answer. Pure.
 *
 * Redundant encoding, as on the gate display (§6.1): the tone is colour, and it is never
 * the only channel — there is always a word and an icon beside it.
 *
 * No owner, unit or pass details here. §5.5 returns them to the capture device, but the
 * camera's screen faces the lane, and M0 already decided a green does not broadcast names.
 */

import type { RecogniseResult } from '../../lib/engine'
import { formatConfidence } from '../../lib/format'
import { formatPlate } from '../../lib/plates'
import { RAIL_WORD, REASON_TITLE } from '../../lib/types'

export type Tone = 'allow' | 'deny' | 'check' | 'none'

export interface ReadView {
  tone: Tone
  word: string
  plate: string | null
  confidence: string
  detail: string | null
  verify: boolean
  repaired: boolean
}

/** Plates were seen but not read (engine alpr/base.py select): say why, and what to change. */
const REJECTED: Record<NonNullable<RecogniseResult['rejected']>, { word: string; detail: string }> = {
  edge: {
    word: 'PLATE AT THE EDGE',
    detail: 'The plate is cut by the edge of the lane box. Move or widen the box so the stopped car\'s plate sits well inside it.',
  },
  size: {
    word: 'PLATE NOT AT THE STOP LINE',
    detail: 'The plate is bigger or smaller than one at the stop line: a car nearer or further away. Set the plate size again if the stop line moved.',
  },
  multiple_plates: {
    word: 'TWO PLATES IN THE LANE BOX',
    detail: 'More than one plate is inside the lane box, so nothing was decided. Tighten the box around the stop line.',
  },
}

export function readView(r: RecogniseResult): ReadView {
  if (!r.decision) {
    const why = r.rejected ? REJECTED[r.rejected] : null
    return {
      tone: 'none', word: why?.word ?? 'NO PLATE IN VIEW', plate: null, confidence: '—',
      detail: why?.detail ?? 'No plate was found in the lane box.',
      verify: false, repaired: false,
    }
  }
  return {
    tone: r.decision,
    word: RAIL_WORD[r.decision],
    plate: r.plate_display || (r.plate_norm ? formatPlate(r.plate_norm) : null),
    confidence: formatConfidence(r.confidence ?? null),
    detail: r.reason ? REASON_TITLE[r.reason] : null,
    verify: Boolean(r.flags?.verify),
    repaired: Boolean(r.repaired_from),
  }
}
