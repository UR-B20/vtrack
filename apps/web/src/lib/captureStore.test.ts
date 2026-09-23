import { describe, expect, it } from 'vitest'
import { parseBackground, parseTuning, roiSignature, serialiseBackground } from './captureStore'
import { DEFAULT_CONFIG, SAMPLE_CELLS } from './presence'

describe('tuning', () => {
  it('defaults when nothing is stored', () => {
    expect(parseTuning(null)).toEqual({ cellT: DEFAULT_CONFIG.cellT, presenceFrac: DEFAULT_CONFIG.presenceFrac, motionFrac: DEFAULT_CONFIG.motionFrac })
  })

  it('keeps values inside their limits and drops the rest', () => {
    expect(parseTuning('{"presenceFrac":0.1,"motionFrac":5,"cellT":"x"}')).toMatchObject({
      presenceFrac: 0.1, motionFrac: DEFAULT_CONFIG.motionFrac, cellT: DEFAULT_CONFIG.cellT,
    })
    expect(parseTuning('{')).toMatchObject({ presenceFrac: DEFAULT_CONFIG.presenceFrac })
  })
})

describe('stored background', () => {
  const roi = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }
  const sig = roiSignature(roi, 16 / 9)
  const bg = Float32Array.from({ length: SAMPLE_CELLS }, (_, i) => 1 + (i % 7) / 100)

  it('round-trips for the same ROI on the same camera', () => {
    const back = parseBackground(serialiseBackground(bg, sig), sig)!
    expect(back).toHaveLength(SAMPLE_CELLS)
    expect(back[5]).toBeCloseTo(bg[5]!, 3)
  })

  it('is ignored once the ROI moved or the camera changed shape', () => {
    const raw = serialiseBackground(bg, sig)
    expect(parseBackground(raw, roiSignature({ ...roi, x: 0.2 }, 16 / 9))).toBeNull()
    expect(parseBackground(raw, roiSignature(roi, 9 / 16))).toBeNull()
  })

  it('rejects a wrong size or junk', () => {
    expect(parseBackground(JSON.stringify({ sig, values: [1, 2] }), sig)).toBeNull()
    expect(parseBackground('nope', sig)).toBeNull()
  })
})
