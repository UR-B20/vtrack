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

export function readView(r: RecogniseResult): ReadView {
  if (!r.decision) {
    return {
      tone: 'none', word: 'NO PLATE IN VIEW', plate: null, confidence: '—',
      detail: 'Hold the plate square to the camera, filling more of the frame, and tap again.',
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
