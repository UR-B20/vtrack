/**
 * cameras.ts — which camera /capture uses (CLAUDE.md §11, Camera at A, 13 Oct 2026). Pure.
 *
 * Point A can be a desktop whose camera is a video capture card: the card shows up in the
 * browser as one more webcam beside the desktop's own. The ?dev=1 panel lists every camera
 * and the choice is kept on the device; with no choice the browser picks (the rear camera
 * on a phone).
 */

export interface CameraChoice {
  id: string
  label: string
}

/** The video inputs from `enumerateDevices()`, named. Before camera permission the browser
 *  hides ids and labels, so this is called once a camera is live. */
export function cameraChoices(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]): CameraChoice[] {
  const out: CameraChoice[] = []
  for (const d of devices) {
    if (d.kind !== 'videoinput' || !d.deviceId || out.some((c) => c.id === d.deviceId)) continue
    out.push({ id: d.deviceId, label: d.label.trim() || `Camera ${out.length + 1}` })
  }
  return out
}

/** A stored camera id, or null for "let the browser pick". */
export function parseCameraId(raw: string | null): string | null {
  const v = raw?.trim()
  return v ? v : null
}
