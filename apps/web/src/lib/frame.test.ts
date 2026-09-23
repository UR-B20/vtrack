import { describe, expect, it } from 'vitest'
import { fitJpeg, mapBox, MAX_FRAME_BYTES, MIN_FRAME_WIDTH, type Encode } from './frame'

/** A fake canvas: JPEG size grows with pixel count and quality, like the real thing. */
function fakeEncoder(bytesPerPixelAtFull: number) {
  const calls: [number, number, number][] = []
  const encode: Encode = async (w, h, q) => {
    calls.push([w, h, q])
    return new Blob([new Uint8Array(Math.round(w * h * bytesPerPixelAtFull * q))])
  }
  return { encode, calls }
}

describe('fitJpeg', () => {
  it('sends the full frame at 0.85 when it already fits (§6.2)', async () => {
    const { encode, calls } = fakeEncoder(0.1)
    const out = await fitJpeg(1920, 1080, encode)
    expect(out).toMatchObject({ width: 1920, height: 1080, quality: 0.85 })
    expect(calls).toHaveLength(1)
  })

  it('lowers quality before it lowers resolution', async () => {
    const { encode } = fakeEncoder(0.26) // 1920×1080 at 0.85 ≈ 458 KB; at 0.75 ≈ 404 KB; 0.65 fits
    const out = await fitJpeg(1920, 1080, encode)
    expect(out).toMatchObject({ width: 1920, quality: 0.65 })
    expect(out!.blob.size).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  })

  it('then scales down, keeping the aspect ratio', async () => {
    const { encode } = fakeEncoder(0.6)
    const out = await fitJpeg(1920, 1080, encode)
    expect(out!.width).toBeLessThan(1920)
    expect(out!.width / out!.height).toBeCloseTo(1920 / 1080, 2)
    expect(out!.blob.size).toBeLessThanOrEqual(MAX_FRAME_BYTES)
  })

  it('never goes narrower than the engine accepts', async () => {
    const { encode, calls } = fakeEncoder(50)
    expect(await fitJpeg(640, 360, encode)).toBeNull()
    expect(Math.min(...calls.map((c) => c[0]))).toBeGreaterThanOrEqual(MIN_FRAME_WIDTH)
  })

  it('treats a failed encode as not fitting', async () => {
    let n = 0
    const encode: Encode = async () => (n++ === 0 ? null : new Blob([new Uint8Array(10)]))
    expect(await fitJpeg(1280, 720, encode)).toMatchObject({ quality: 0.75 })
  })
})

describe('mapBox', () => {
  it('maps straight through when the view is the frame', () => {
    expect(mapBox([100, 50, 300, 90], { width: 1280, height: 720 }, { width: 1280, height: 720 }))
      .toEqual({ left: 100, top: 50, width: 200, height: 40 })
  })

  it('scales a downscaled sent image back up', () => {
    // Sent at 640×360, shown at 1280×720.
    expect(mapBox([100, 50, 300, 90], { width: 640, height: 360 }, { width: 1280, height: 720 }))
      .toEqual({ left: 200, top: 100, width: 400, height: 80 })
  })

  it('accounts for letterboxing (object-fit: contain)', () => {
    // A 16:9 frame in a 4:3 view: bars top and bottom.
    const box = mapBox([0, 0, 1280, 720], { width: 1280, height: 720 }, { width: 800, height: 600 })!
    expect(box.left).toBe(0)
    expect(box.width).toBe(800)
    expect(box.top).toBeCloseTo(75, 5)
    expect(box.height).toBeCloseTo(450, 5)
  })

  it('clamps to the view and rejects degenerate boxes', () => {
    const box = mapBox([-20, -20, 50, 50], { width: 100, height: 100 }, { width: 100, height: 100 })!
    expect(box).toEqual({ left: 0, top: 0, width: 50, height: 50 })
    expect(mapBox([10, 10, 10, 40], { width: 100, height: 100 }, { width: 100, height: 100 })).toBeNull()
    expect(mapBox([1, 2, 3, 4], { width: 0, height: 0 }, { width: 100, height: 100 })).toBeNull()
  })
})
