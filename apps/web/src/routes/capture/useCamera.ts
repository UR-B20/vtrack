import { useEffect, useRef, useState, type RefObject } from 'react'
import type { Size } from '../../lib/frame'

export type CameraState = { kind: 'starting' } | { kind: 'live'; size: Size } | { kind: 'failed'; message: string }

function cameraProblem(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError') return 'Camera permission was refused. Allow the camera for this page (the icon at the left of the address bar), then reload.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and reload.'
  return `The camera could not start: ${e instanceof Error ? e.message : String(e)}`
}

/**
 * The rear camera into a <video>. `size` is the camera's own resolution (videoWidth ×
 * videoHeight), which the ROI, the crop and the box mapping are all measured in; it is
 * re-read when the stream changes shape (the tablet rotated).
 */
export function useCamera(): { videoRef: RefObject<HTMLVideoElement | null>; camera: CameraState } {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [camera, setCamera] = useState<CameraState>({ kind: 'starting' })

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const video = videoRef.current
    const onSize = () => {
      if (video && video.videoWidth && video.videoHeight) {
        setCamera({ kind: 'live', size: { width: video.videoWidth, height: video.videoHeight } })
      }
    }
    video?.addEventListener('loadedmetadata', onSize)
    video?.addEventListener('resize', onSize)
    navigator.mediaDevices
      .getUserMedia({
        // `ideal`, not `exact`: a laptop has only a front camera. §6.2 asks for 1920 wide
        // where the camera can give it.
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
        audio: false,
      })
      .then((s) => {
        // StrictMode mounts twice in development; a stream that arrives after this effect
        // was torn down must be stopped, or the camera light stays on.
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        if (video) {
          video.srcObject = s
          void video.play().catch(() => undefined)
        }
      })
      .catch((e) => {
        if (!cancelled) setCamera({ kind: 'failed', message: cameraProblem(e) })
      })
    return () => {
      cancelled = true
      video?.removeEventListener('loadedmetadata', onSize)
      video?.removeEventListener('resize', onSize)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return { videoRef, camera }
}
