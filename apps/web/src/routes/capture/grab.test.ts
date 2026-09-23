import { describe, expect, it } from 'vitest'
import { toGrey, vehicleTag } from './grab'

describe('grab', () => {
  it('converts RGBA to luma, one byte a pixel', () => {
    expect(Array.from(toGrey([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 200, 200, 200, 255])))
      .toEqual([76, 150, 29, 200])
  })

  it('tags a vehicle by local date and time, so its frames sort together', () => {
    expect(vehicleTag(new Date(2026, 8, 23, 14, 32, 6))).toBe('v20260923-143206')
  })
})
