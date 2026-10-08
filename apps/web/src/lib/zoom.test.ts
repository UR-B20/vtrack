import { describe, expect, it } from 'vitest'
import { clampZoom, parseZoom, zoomRange } from './zoom'

describe('zoomRange', () => {
  it('reads the capability Chrome reports', () => {
    expect(zoomRange({ min: 1, max: 8, step: 0.1 })).toEqual({ min: 1, max: 8, step: 0.1 })
  })

  it('is null when the camera has no zoom, or a range of one value', () => {
    expect(zoomRange(undefined)).toBeNull()
    expect(zoomRange({})).toBeNull()
    expect(zoomRange({ min: 1, max: 1, step: 0.1 })).toBeNull()
    expect(zoomRange({ min: 'a', max: 8 })).toBeNull()
  })

  it('gives a missing or bad step a sensible one', () => {
    expect(zoomRange({ min: 1, max: 4 })?.step).toBe(0.1)
    expect(zoomRange({ min: 1, max: 4, step: 0 })?.step).toBe(0.1)
  })
})

describe('clampZoom', () => {
  const r = { min: 1, max: 8, step: 0.1 }

  it('keeps a value inside the range and on its steps', () => {
    expect(clampZoom(2.34, r)).toBe(2.3)
    expect(clampZoom(0.5, r)).toBe(1)
    expect(clampZoom(20, r)).toBe(8)
  })

  it('treats nonsense as no zoom', () => {
    expect(clampZoom(Number.NaN, r)).toBe(1)
  })
})

describe('parseZoom', () => {
  it('reads a stored zoom', () => {
    expect(parseZoom('2.5')).toBe(2.5)
  })

  it('ignores nothing, junk and non-positive values', () => {
    expect(parseZoom(null)).toBeNull()
    expect(parseZoom('abc')).toBeNull()
    expect(parseZoom('0')).toBeNull()
    expect(parseZoom('-2')).toBeNull()
  })
})
