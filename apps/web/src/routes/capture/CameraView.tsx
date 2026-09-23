import { useCallback, useEffect, useRef, useState } from 'react'
import { EngineError, recognise, sendHeartbeat, type RecogniseResult } from '../../lib/engine'
import { fitJpeg, mapBox, type Encode, type Size } from '../../lib/frame'
import type { Pairing } from '../../lib/device'
import { useEngineHealth } from '../../lib/useEngineHealth'
import { EnginePill } from '../../lib/EnginePill'
import { CheckIcon, CrossIcon, WarnIcon } from '../../lib/icons'
import { readView, type ReadView } from './readView'

/** §6.2: the detection box, plate and confidence stay on the video for 3 s. */
const OVERLAY_MS = 3000
/** §6.2: heartbeat every 10 s. */
const HEARTBEAT_MS = 10_000

interface Props {
  engineUrl: string
  pairing: Pairing
  onUnpair: () => void
}

interface Shown {
  result: RecogniseResult
  view: ReadView
  sent: Size
}

type CameraState = { kind: 'starting' } | { kind: 'live' } | { kind: 'failed'; message: string }

function cameraProblem(e: unknown): string {
  const name = (e as { name?: string })?.name
  if (name === 'NotAllowedError') return 'Camera permission was refused. Allow the camera for this page (the icon at the left of the address bar), then reload.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device.'
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it (Teams, Zoom, the Camera app) and reload.'
  return `The camera could not start: ${e instanceof Error ? e.message : String(e)}`
}

export function CameraView({ engineUrl, pairing, onUnpair }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const [camera, setCamera] = useState<CameraState>({ kind: 'starting' })
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)
  const [overlayOn, setOverlayOn] = useState(false)
  const [error, setError] = useState<{ message: string; pairing: boolean } | null>(null)
  const [viewSize, setViewSize] = useState<Size>({ width: 0, height: 0 })
  const health = useEngineHealth(engineUrl)

  // ── the camera ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    navigator.mediaDevices
      .getUserMedia({
        // `ideal`, not `exact`: a laptop has only a front camera, and the tablet at the gate
        // uses its rear one. §6.2 asks for 1920 wide where the camera can give it.
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
        const video = videoRef.current
        if (video) {
          video.srcObject = s
          void video.play().catch(() => undefined)
        }
        setCamera({ kind: 'live' })
      })
      .catch((e) => {
        if (!cancelled) setCamera({ kind: 'failed', message: cameraProblem(e) })
      })
    return () => {
      cancelled = true
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // ── the overlay's geometry follows the video element's size ───────────────────────
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setViewSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── one frame ─────────────────────────────────────────────────────────────────────
  const tap = useCallback(async () => {
    const video = videoRef.current
    // One request in flight, never queued and never retried: a frame that arrives late could
    // otherwise be decided as the car that is now at the gate (§6.2; the engine also refuses
    // frames older than MAX_FRAME_AGE_S).
    if (inFlight.current || !video || camera.kind !== 'live' || !video.videoWidth) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      // Draw the frame ONCE, at the instant of the tap; every size/quality attempt below
      // re-encodes this same picture rather than whatever the camera shows a moment later.
      const w = video.videoWidth
      const h = video.videoHeight
      const capturedAt = new Date()
      const still = document.createElement('canvas')
      still.width = w
      still.height = h
      still.getContext('2d')!.drawImage(video, 0, 0, w, h)
      const out = document.createElement('canvas')
      const encode: Encode = (ew, eh, q) => {
        out.width = ew
        out.height = eh
        out.getContext('2d')!.drawImage(still, 0, 0, ew, eh)
        return new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', q))
      }
      const fitted = await fitJpeg(w, h, encode)
      if (!fitted) throw new Error('This frame could not be made small enough to send.')
      const result = await recognise(engineUrl, pairing, fitted.blob, capturedAt)
      setShown({ result, view: readView(result), sent: { width: fitted.width, height: fitted.height } })
      setOverlayOn(true)
    } catch (e) {
      const status = e instanceof EngineError ? e.status : 0
      setError({ message: e instanceof Error ? e.message : String(e), pairing: status === 401 || status === 403 })
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [camera.kind, engineUrl, pairing])

  useEffect(() => {
    if (!overlayOn) return
    const id = setTimeout(() => setOverlayOn(false), OVERLAY_MS)
    return () => clearTimeout(id)
  }, [overlayOn, shown])

  // Space bar = tap, for a laptop held at arm's length with a plate in the other hand.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      void tap()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tap])

  // ── heartbeat (§6.2) ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const beat = () => void sendHeartbeat(engineUrl, pairing, 'capture', 'm1-web').catch(() => undefined)
    beat()
    const id = setInterval(beat, HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [engineUrl, pairing])

  // ── wake lock: the camera screen must not sleep (§6.2) ──────────────────────────────
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') sentinel = await navigator.wakeLock?.request('screen')
      } catch { /* unsupported or refused — not fatal */ }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      document.removeEventListener('visibilitychange', acquire)
      void sentinel?.release()
    }
  }, [])

  const box = overlayOn && shown?.result.bbox ? mapBox(shown.result.bbox, shown.sent, viewSize) : null

  return (
    <div className="capture">
      <header className="capture__top">
        <span className="wordmark" style={{ fontSize: 20 }}>VTRACK</span>
        <span className="topbar__where">CAMERA · <span className="mono">{pairing.deviceId}</span></span>
        <span className="topbar__spacer" />
        <EnginePill health={health} />
        <button type="button" className="btn btn--link capture__unpair" onClick={onUnpair}>UNPAIR</button>
      </header>

      <div className="capture__stage" ref={stageRef}>
        <video ref={videoRef} className="capture__video" muted playsInline autoPlay aria-label="Camera view" />
        {camera.kind !== 'live' && (
          <div className="capture__notice">
            {camera.kind === 'starting' ? 'Starting the camera…' : camera.message}
          </div>
        )}
        {box && shown && (
          <div className={`capture__box tone-${shown.view.tone}`}
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
        )}
        {overlayOn && shown && <ReadChip view={shown.view} floating />}
      </div>

      <footer className="capture__bar">
        <button type="button" className="btn btn--primary capture__tap" onClick={() => void tap()}
          disabled={busy || camera.kind !== 'live'}>
          {busy ? 'READING…' : 'READ PLATE'}
        </button>
        <span className="capture__hint">OR PRESS SPACE</span>
        <span className="topbar__spacer" />
        {error ? (
          <span className="capture__error" role="alert">
            {error.message}
            {error.pairing && (
              <button type="button" className="btn btn--link" onClick={onUnpair}>RE-PAIR</button>
            )}
          </span>
        ) : shown ? (
          <span className="capture__last">
            LAST READ · <ReadChip view={shown.view} /> · {shown.result.latency_ms} ms
            {shown.result.deduped ? ' · REFINED' : ''}
          </span>
        ) : (
          <span className="capture__last">NO READS YET</span>
        )}
      </footer>
    </div>
  )
}

function ReadChip({ view, floating = false }: { view: ReadView; floating?: boolean }) {
  const Icon = view.tone === 'allow' ? CheckIcon : view.tone === 'deny' ? CrossIcon : WarnIcon
  return (
    <span className={`readchip tone-${view.tone}${floating ? ' readchip--floating' : ''}`}>
      {view.tone !== 'none' && <Icon className="readchip__icon" />}
      <b className="readchip__word">{view.word}</b>
      {view.plate && <span className="plate plate--sm">{view.plate}</span>}
      {view.tone !== 'none' && <span className="mono">{view.confidence}</span>}
      {view.verify && <span className="badge-verify">VERIFY</span>}
      {view.repaired && <span className="badge-verify">REPAIRED</span>}
      {floating && view.detail && <span className="readchip__detail">{view.detail}</span>}
    </span>
  )
}
