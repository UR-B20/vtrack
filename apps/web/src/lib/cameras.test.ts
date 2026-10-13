import { describe, expect, it } from 'vitest'
import { cameraChoices, parseCameraId } from './cameras'

const dev = (kind: MediaDeviceKind, deviceId: string, label = '') => ({ kind, deviceId, label })

describe('cameraChoices', () => {
  it('lists video inputs only, named by the browser', () => {
    expect(cameraChoices([
      dev('audioinput', 'mic'),
      dev('videoinput', 'a', 'Integrated Webcam'),
      dev('videoinput', 'b', 'USB Video (534d:2109)'),
    ])).toEqual([
      { id: 'a', label: 'Integrated Webcam' },
      { id: 'b', label: 'USB Video (534d:2109)' },
    ])
  })

  it('numbers an unnamed camera and drops ones without an id or seen twice', () => {
    expect(cameraChoices([dev('videoinput', ''), dev('videoinput', 'x'), dev('videoinput', 'x', 'again')]))
      .toEqual([{ id: 'x', label: 'Camera 1' }])
  })
})

describe('parseCameraId', () => {
  it('is null for nothing stored', () => {
    expect(parseCameraId(null)).toBeNull()
    expect(parseCameraId('  ')).toBeNull()
    expect(parseCameraId('abc')).toBe('abc')
  })
})
