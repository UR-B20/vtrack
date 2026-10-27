import { describe, expect, it } from 'vitest'
import { cameraOffline, observe, unknownLiveness } from './liveness'

const T0 = Date.parse('2026-10-27T02:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

describe('camera liveness', () => {
  it('a fresh first heartbeat is online; one with no change for 30 s is offline', () => {
    let l = observe(unknownLiveness, iso(T0 - 5_000), T0, true)
    expect(cameraOffline(l, T0)).toBe(false)
    l = observe(l, iso(T0 - 5_000), T0 + 20_000, false)       // same value: no news
    expect(cameraOffline(l, T0 + 30_000)).toBe(false)
    expect(cameraOffline(l, T0 + 30_001)).toBe(true)
  })

  it('a new heartbeat restarts the 30 s, whatever the server clock says', () => {
    let l = observe(unknownLiveness, iso(T0), T0, true)
    // The server is an hour behind the phone: only the change counts.
    l = observe(l, iso(T0 - 3_600_000), T0 + 25_000, false)
    expect(cameraOffline(l, T0 + 50_000)).toBe(false)
  })

  it('a heartbeat hours old at start-up is offline at once', () => {
    const l = observe(unknownLiveness, iso(T0 - 3 * 3_600_000), T0, true)
    expect(cameraOffline(l, T0)).toBe(true)
  })

  it('a phone clock a little off still reads a fresh heartbeat as fresh', () => {
    const l = observe(unknownLiveness, iso(T0 + 45_000), T0, true)   // phone 45 s slow
    expect(cameraOffline(l, T0)).toBe(false)
  })

  it('a camera that never reported is offline', () => {
    expect(cameraOffline(observe(unknownLiveness, null, T0, true), T0)).toBe(true)
  })
})
