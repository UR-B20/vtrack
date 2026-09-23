import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROI, MIN_ROI_PX, bandFromBox, clampRoi, moveRoi, parseStoredRoi, resizeRoi, roiField,
  roiPixels, roiQuality,
} from './roi'
import { mapCropBox, rectToView } from './frame'

const CAM = { width: 1920, height: 1080 }

describe('the lane ROI', () => {
  it('stays inside the frame', () => {
    expect(moveRoi(DEFAULT_ROI, 0.9, 0.9, CAM)).toMatchObject({ x: 1 - DEFAULT_ROI.w, y: 1 - DEFAULT_ROI.h })
    expect(moveRoi(DEFAULT_ROI, -2, -2, CAM)).toMatchObject({ x: 0, y: 0 })
  })

  it('is never narrower than the engine accepts', () => {
    const r = resizeRoi(DEFAULT_ROI, -5, -5, CAM)
    expect(r.w * CAM.width).toBeGreaterThanOrEqual(MIN_ROI_PX)
    expect(roiQuality(r, CAM)).toBe('small')
  })

  it('warns below 640 camera pixels and is fine above', () => {
    expect(roiQuality({ ...DEFAULT_ROI, w: 0.3 }, CAM)).toBe('small')       // 576 px
    expect(roiQuality({ ...DEFAULT_ROI, w: 0.4 }, CAM)).toBe('ok')          // 768 px
    expect(roiQuality({ ...DEFAULT_ROI, w: 0.1 }, CAM)).toBe('too_small')
  })

  it('converts to whole camera pixels inside the frame', () => {
    expect(roiPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, CAM)).toEqual({ x: 960, y: 540, width: 960, height: 540 })
  })

  it('a camera narrower than the minimum gets the whole width', () => {
    expect(clampRoi({ x: 0.2, y: 0, w: 0.1, h: 0.5 }, { width: 300, height: 200 }).w).toBe(1)
  })
})

describe('stored ROI', () => {
  const stored = JSON.stringify({ roi: DEFAULT_ROI, aspect: 16 / 9, plateBand: [0.1, 0.2] })

  it('round-trips for the same camera shape', () => {
    expect(parseStoredRoi(stored, 16 / 9)).toEqual({ roi: DEFAULT_ROI, aspect: 16 / 9, plateBand: [0.1, 0.2] })
  })

  it('is dropped when the camera\'s shape changed (the tablet rotated)', () => {
    expect(parseStoredRoi(stored, 9 / 16)).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseStoredRoi('{', 1)).toBeNull()
    expect(parseStoredRoi(JSON.stringify({ roi: { x: 'a' }, aspect: 1 }), 1)).toBeNull()
  })

  it('drops a malformed plate band but keeps the ROI', () => {
    const raw = JSON.stringify({ roi: DEFAULT_ROI, aspect: 1, plateBand: [0.3, 0.1] })
    expect(parseStoredRoi(raw, 1)?.plateBand).toBeNull()
  })
})

describe('plate size band (SET PLATE SIZE)', () => {
  it('is the read plate\'s width ± 30 %, as fractions of the sent frame', () => {
    expect(bandFromBox([100, 50, 300, 100], 1000)).toEqual([0.14, 0.26])
  })

  it('travels as the engine\'s roi field', () => {
    expect(roiField([0.14, 0.26])).toBe('{"plate_w":[0.14,0.26]}')
    expect(roiField(null)).toBeNull()
  })

  it('refuses a nonsense box', () => {
    expect(bandFromBox([0, 0, 0, 10], 1000)).toBeNull()
    expect(bandFromBox([0, 0, 10, 10], 0)).toBeNull()
  })
})

describe('boxes from a cropped, scaled frame land on the camera view', () => {
  // Camera 1920×1080 shown in a 960×540 view (scale 0.5). ROI at (400, 300), 1000×500,
  // sent scaled down to 800×400 (0.8).
  const crop = { x: 400, y: 300, width: 1000, height: 500 }
  const sent = { width: 800, height: 400 }
  const view = { width: 960, height: 540 }

  it('composes the fit scale, the ROI offset and the view scale', () => {
    // A box at (80, 40)–(240, 120) in the sent frame is (100, 50)–(300, 150) in the crop,
    // (500, 350)–(700, 450) in the camera, and half that on screen.
    expect(mapCropBox([80, 40, 240, 120], sent, crop, { width: 1920, height: 1080 }, view))
      .toEqual({ left: 250, top: 175, width: 100, height: 50 })
  })

  it('puts the ROI rectangle where the crop was taken', () => {
    expect(rectToView(crop, { width: 1920, height: 1080 }, view)).toEqual({ left: 200, top: 150, width: 500, height: 250 })
  })

  it('accounts for letterboxing: a portrait view of a landscape camera', () => {
    const tall = { width: 540, height: 960 }             // scale 0.28125, offY = (960 - 303.75) / 2
    const box = rectToView({ x: 0, y: 0, width: 1920, height: 1080 }, { width: 1920, height: 1080 }, tall)!
    expect(box.left).toBe(0)
    expect(box.top).toBeCloseTo(328.125)
    expect(box.width).toBeCloseTo(540)
  })
})
