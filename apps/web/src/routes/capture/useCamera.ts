import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { Size } from '../../lib/frame'
import { store } from '../../lib/captureStore'
import { clampZoom, zoomRange, type ZoomRange } from '../../lib/zoom'
import { cameraChoices, type CameraChoice } from '../../lib/cameras'

export type CameraState = { kind: 'starting' } | { kind: 'live'; size: Size } | { kind: 'failed'; message: string }

/** The camera's own zoom, when it offers one (lib/zoom.ts). */
export interface CameraZoom {
  range: ZoomRange
  value: number
}

function cameraProblem(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError') return 'Camera permission was refused. Allow the camera for this page (the icon at the left of the address bar), then reload.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and reload.'
  return `The camera could not start: ${e instanceof Error ? e.message : String(e)}`
}

/**
 * The rear camera — or the camera chosen in the ?dev=1 panel, such as a video capture card on
 * a desktop (lib/cameras.ts) — into a <video>. `size` is the camera's own resolution (videoWidth ×
 * videoHeight), which the ROI, the crop and the box mapping are all measured in; it is
 * re-read when the stream changes shape (the tablet rotated).
 *
 * `zoom` is null when the camera (or the browser) offers none. The zoom last set on this
 * device is re-applied when the camera starts. `cameras` lists every camera once one is live;
 * `cameraId` is the one in use, `chosenCamera` the one chosen (null: the browser picks). A chosen camera that is gone (the card unplugged) is
 * forgotten and the browser's own camera starts instead.
 */
export function useCamera(): {
  videoRef: RefObject<HTMLVideoElement | null>
  camera: CameraState
  zoom: CameraZoom | null
  setZoom: (value: number) => void
  cameras: CameraChoice[]
  cameraId: string | null
  chosenCamera: string | null
  chooseCamera: (id: string | null) => void
} {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const [camera, setCamera] = useState<CameraState>({ kind: 'starting' })
  const [zoom, setZoomState] = useState<CameraZoom | null>(null)
  const [chosen, setChosen] = useState<string | null>(store.camera)
  const [cameras, setCameras] = useState<CameraChoice[]>([])
  const [cameraId, setCameraId] = useState<string | null>(null)

  const applyZoom = useCallback(async (track: MediaStreamTrack, range: ZoomRange, wanted: number) => {
    const value = clampZoom(wanted, range)
    try {
      await track.applyConstraints({ advanced: [{ zoom: value } as MediaTrackConstraintSet] })
      setZoomState({ range, value })
      store.setZoom(value)
    } catch { /* the camera refused this value: keep the last one */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    const video = videoRef.current
    setCamera({ kind: 'starting' })
    setZoomState(null)
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
        // where the camera can give it. `zoom: true` asks Chrome for the camera's zoom too;
        // a camera without one still starts. A chosen camera is asked for by its id.
        video: {
          ...(chosen ? { deviceId: { exact: chosen } } : { facingMode: { ideal: 'environment' } }),
          width: { ideal: 1920 }, zoom: true,
        } as MediaTrackConstraints & { zoom: boolean },
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
        const track = s.getVideoTracks()[0] ?? null
        trackRef.current = track
        setCameraId((track?.getSettings().deviceId as string | undefined) ?? null)
        // Ids and labels are only given out once the camera is allowed, i.e. now.
        void navigator.mediaDevices.enumerateDevices()
          .then((list) => { if (!cancelled) setCameras(cameraChoices(list)) })
          .catch(() => undefined)
        const caps = track?.getCapabilities?.() as Record<string, unknown> | undefined
        const range = zoomRange(caps?.zoom)
        if (track && range) {
          const current = (track.getSettings() as Record<string, unknown>).zoom
          void applyZoom(track, range, store.zoom() ?? (typeof current === 'number' ? current : range.min))
        }
        if (video) {
          video.srcObject = s
          void video.play().catch(() => undefined)
        }
      })
      .catch((e) => {
        if (cancelled) return
        const name = (e as { name?: string })?.name
        if (chosen && (name === 'NotFoundError' || name === 'OverconstrainedError')) {
          store.setCamera(null)
          setChosen(null)
          return
        }
        setCamera({ kind: 'failed', message: cameraProblem(e) })
      })
    return () => {
      cancelled = true
      video?.removeEventListener('loadedmetadata', onSize)
      video?.removeEventListener('resize', onSize)
      stream?.getTracks().forEach((t) => t.stop())
      trackRef.current = null
    }
  }, [applyZoom, chosen])

  const setZoom = useCallback((value: number) => {
    const track = trackRef.current
    if (track && zoom) void applyZoom(track, zoom.range, value)
  }, [applyZoom, zoom])

  const chooseCamera = useCallback((id: string | null) => {
    store.setCamera(id)
    setChosen(id)
  }, [])

  return { videoRef, camera, zoom, setZoom, cameras, cameraId, chosenCamera: chosen, chooseCamera }
}
