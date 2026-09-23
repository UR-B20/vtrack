/**
 * CameraView — the camera screen at point A (CLAUDE.md §6.2, docs/screens/capture.png).
 *
 * The pieces, and where each rule lives:
 *   useCamera.ts        the rear camera and its resolution
 *   lib/roi.ts          the lane ROI: what the engine is sent
 *   grab.ts             the 64×36 thumbnail (4 Hz) and the full-resolution ROI crop
 *   lib/presence.ts     WHEN to send: presence + motion, sessions, the 12-frame cap
 *   ScreenLock.tsx      locked unless held for 2 s; fullscreen; leaving asks first
 *   DevPanel.tsx        ?dev=1 setup at the gate
 *
 * This component owns the I/O and passes values between them; the decisions are in the
 * pure modules, which carry the tests.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { EngineError, recognise, sendHeartbeat, type RecogniseResult } from '../../lib/engine'
import type { Rect, Size } from '../../lib/frame'
import type { Pairing } from '../../lib/device'
import { useEngineHealth } from '../../lib/useEngineHealth'
import { EnginePill } from '../../lib/EnginePill'
import { isDevMode } from '../../lib/router'
import { useApplyUpdateWhenIdle } from '../../lib/updates'
import {
  DEFAULT_CONFIG, framesSent, initialPresence, outcomeOf, reduce,
  type Action as PresenceAction, type Effect as PresenceEffect, type PresenceState,
} from '../../lib/presence'
import {
  DEFAULT_ROI, bandFromBox, clampRoi, loadRoi, roiField, roiPixels, saveRoi, type Roi, type StoredRoi,
} from '../../lib/roi'
import { roiSignature, store, type CaptureMode, type Tuning } from '../../lib/captureStore'
import { readView, type ReadView } from './readView'
import { useCamera } from './useCamera'
import { cropJpeg, downloadFrame, sampleRoi, vehicleTag } from './grab'
import { CaptureNow, Chips, Detection, LastRead, ModeSwitch, RoiLayer } from './parts'
import { ScreenLock, useLeaveGuard } from './ScreenLock'
import { DevPanel } from './DevPanel'

/** §6.2: the detection box, plate and confidence stay on the video for 3 s. */
const OVERLAY_MS = 3000
/** §6.2: heartbeat every 10 s. */
const HEARTBEAT_MS = 10_000
/** presence.ts expects about four thumbnails a second. */
const SAMPLE_MS = 250
/** How often the empty-lane background is saved for the next page load. */
const SAVE_BACKGROUND_MS = 30_000
const APP_VERSION = 'm2-web'

interface Props {
  engineUrl: string
  pairing: Pairing
  onUnpair: () => void
}

interface Shown {
  result: RecogniseResult
  view: ReadView
  sent: Size
  crop: Rect
  camera: Size
  at: number
}

export function CameraView({ engineUrl, pairing, onUnpair }: Props) {
  const dev = useMemo(isDevMode, [])
  const { videoRef, camera } = useCamera()
  const health = useEngineHealth(engineUrl)
  const stageRef = useRef<HTMLDivElement>(null)
  const [viewSize, setViewSize] = useState<Size>({ width: 0, height: 0 })

  const size = camera.kind === 'live' ? camera.size : null
  const aspect = size ? size.width / size.height : null

  // ── the lane ROI, per camera shape ─────────────────────────────────────────────────
  const [stored, setStored] = useState<StoredRoi | null>(null)
  const [draft, setDraft] = useState<Roi | null>(null)       // while being dragged
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!size || !aspect) return
    setStored(loadRoi(aspect) ?? { roi: clampRoi(DEFAULT_ROI, size), aspect, plateBand: null })
    // Only the camera's SHAPE matters: the stored ROI is in fractions of the frame.
  }, [aspect]) // eslint-disable-line react-hooks/exhaustive-deps
  const roi = stored?.roi ?? null
  const rect = useMemo(() => (size && roi ? roiPixels(roi, size) : null), [size, roi])
  const signature = roi && aspect ? roiSignature(roi, aspect) : null

  // ── presence ──────────────────────────────────────────────────────────────────────
  const [tuning, setTuning] = useState<Tuning>(store.tuning)
  const cfgRef = useRef({ ...DEFAULT_CONFIG, ...tuning })
  cfgRef.current = { ...DEFAULT_CONFIG, ...tuning }
  const pending = useRef<PresenceEffect[]>([])
  const [mode, setModeState] = useState<CaptureMode>(store.mode)
  const [presence, rawDispatch] = useReducer(
    (s: PresenceState, a: PresenceAction) => {
      const step = reduce(s, a, cfgRef.current)
      // Collected here and acted on after commit, as in DisplayRoute: StrictMode's double
      // reduce must not double-send.
      pending.current.push(...step.effects)
      return step.state
    },
    undefined,
    () => initialPresence(null, store.mode() === 'auto'),
  )
  const dispatch = useCallback((a: PresenceAction) => rawDispatch(a), [])

  // A (new) ROI: start from the background an earlier run saved for it, if any.
  useEffect(() => {
    if (signature) dispatch({ type: 'restore', background: store.background(signature) })
  }, [signature, dispatch])

  // Save the background while the lane is empty, for the next page load.
  const presenceRef = useRef(presence)
  presenceRef.current = presence
  useEffect(() => {
    if (!signature) return
    const id = setInterval(() => {
      const p = presenceRef.current
      if (p.lane === 'empty' && p.background) store.setBackground(p.background, signature)
    }, SAVE_BACKGROUND_MS)
    return () => clearInterval(id)
  }, [signature])

  // The thumbnail, four times a second.
  useEffect(() => {
    if (!rect || editing) return
    const id = setInterval(() => {
      const video = videoRef.current
      const grey = video && sampleRoi(video, rect)
      if (grey) dispatch({ type: 'sample', grey, now: performance.now() })
    }, SAMPLE_MS)
    return () => clearInterval(id)
  }, [rect, editing, videoRef, dispatch])

  // ── sending ───────────────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState<Shown | null>(null)
  const [overlayOn, setOverlayOn] = useState(false)
  const [error, setError] = useState<{ message: string; pairing: boolean } | null>(null)
  const [saveFrames, setSaveFramesState] = useState(() => dev && store.saveFrames())
  const tapInFlight = useRef(false)
  const tags = useRef(new Map<number, string>())
  const live = useRef({ rect, size, band: stored?.plateBand ?? null, saveFrames })
  live.current = { rect, size, band: stored?.plateBand ?? null, saveFrames }

  const sendFrame = useCallback(async (target: { session: number; n: number } | null) => {
    const video = videoRef.current
    const { rect: r, size: cam, band, saveFrames: save } = live.current
    const fail = () => {
      if (target) dispatch({ type: 'result', session: target.session, outcome: 'failed', now: performance.now() })
    }
    if (!video || !r || !cam) return fail()
    setBusy(true)
    try {
      const capturedAt = new Date()
      const fitted = await cropJpeg(video, r)
      if (!fitted) throw new Error('This frame could not be made small enough to send.')
      if (dev && save) {
        const tag = target
          ? (tags.current.get(target.session) ?? tags.current.set(target.session, vehicleTag(capturedAt)).get(target.session)!)
          : `tap-${vehicleTag(capturedAt)}`
        downloadFrame(fitted.blob, target ? `${tag}-${String(target.n).padStart(2, '0')}.jpg` : `${tag}.jpg`)
      }
      const result = await recognise(engineUrl, pairing, fitted.blob, capturedAt, roiField(band))
      if (target) dispatch({ type: 'result', session: target.session, outcome: outcomeOf(result), now: performance.now() })
      setShown({ result, view: readView(result), sent: { width: fitted.width, height: fitted.height }, crop: r, camera: cam, at: Date.now() })
      setOverlayOn(true)
      setError(null)
    } catch (e) {
      fail()
      const status = e instanceof EngineError ? e.status : 0
      setError({ message: e instanceof Error ? e.message : String(e), pairing: status === 401 || status === 403 })
    } finally {
      setBusy(false)
    }
  }, [videoRef, dispatch, dev, engineUrl, pairing])

  // Act on what the presence machine asked for. StrictMode runs a reducer twice in
  // development, so the same capture can be queued twice: each (session, frame) is sent once.
  const handled = useRef(new Set<string>())
  useEffect(() => {
    const effects = pending.current.splice(0)
    for (const e of effects) {
      if (e.type !== 'capture') continue
      const key = `${e.session}:${e.n}:${presence.session?.failures ?? 0}`
      if (handled.current.has(key)) continue
      if (handled.current.size > 500) handled.current.clear()   // the page runs for days
      handled.current.add(key)
      void sendFrame({ session: e.session, n: e.n })
    }
  }, [presence, sendFrame])

  const tap = useCallback(async () => {
    if (mode !== 'tap' || tapInFlight.current || camera.kind !== 'live') return
    tapInFlight.current = true
    try {
      await sendFrame(null)
    } finally {
      tapInFlight.current = false
    }
  }, [mode, camera.kind, sendFrame])

  useEffect(() => {
    if (!overlayOn) return
    const id = setTimeout(() => setOverlayOn(false), OVERLAY_MS)
    return () => clearTimeout(id)
  }, [overlayOn, shown])

  const setMode = (m: CaptureMode) => {
    setModeState(m)
    store.setMode(m)
    dispatch({ type: 'auto', on: m === 'auto' })
  }

  // ── lock, fullscreen, leaving, updates ────────────────────────────────────────────
  const [locked, setLocked] = useState(true)
  const lock = useCallback(() => {
    setLocked(true)
    setEditing(false)
  }, [])
  useLeaveGuard(camera.kind === 'live')
  useApplyUpdateWhenIdle(presence.lane !== 'present' && !busy)

  // Space bar = tap, for setting up on a laptop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || locked) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      e.preventDefault()
      void tap()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tap, locked])

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

  // ── heartbeat (§6.2) and wake lock ────────────────────────────────────────────────
  useEffect(() => {
    const beat = () => void sendHeartbeat(engineUrl, pairing, 'capture', APP_VERSION).catch(() => undefined)
    beat()
    const id = setInterval(beat, HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [engineUrl, pairing])

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

  // ── ROI edits ─────────────────────────────────────────────────────────────────────
  const commitRoi = (next: Roi) => {
    setDraft(null)
    if (!stored || !size) return
    // The plate band is a fraction of the ROI's width: a new width invalidates it.
    const sameWidth = Math.abs(next.w - stored.roi.w) < 1e-6
    const updated = { ...stored, roi: next, plateBand: sameWidth ? stored.plateBand : null }
    setStored(updated)
    saveRoi(updated)
  }
  const setBand = (band: StoredRoi['plateBand']) => {
    if (!stored) return
    const updated = { ...stored, plateBand: band }
    setStored(updated)
    saveRoi(updated)
  }

  const shownRoi = draft ?? roi
  const lastBand = shown?.result.bbox ? bandFromBox(shown.result.bbox, shown.sent.width) : null

  return (
    <div className="cap">
      <header className="cap__top">
        <span className="wordmark" style={{ fontSize: 20 }}>VTRACK</span>
        <span className="topbar__where">CAPTURE · <span className="mono">{pairing.deviceId.replace(/^cam-/, '').toUpperCase()}</span></span>
        <span className="topbar__spacer" />
        <EnginePill health={health} />
        {!locked && <button type="button" className="btn btn--link cap__unpair" onClick={onUnpair}>UNPAIR</button>}
      </header>

      <div className="cap__stage" ref={stageRef}>
        <video ref={videoRef} className="cap__video" muted playsInline autoPlay aria-label="Camera view" />
        {camera.kind !== 'live' && (
          <div className="cap__notice">{camera.kind === 'starting' ? 'Starting the camera…' : camera.message}</div>
        )}
        {size && shownRoi && (
          <RoiLayer roi={shownRoi} camera={size} view={viewSize} editing={editing && !locked}
            onChange={setDraft} onCommit={commitRoi} />
        )}
        {overlayOn && shown && (
          <Detection result={shown.result} view={shown.view} sent={shown.sent} crop={shown.crop}
            camera={shown.camera} viewSize={viewSize} />
        )}
        <Chips mode={mode} lane={presence.lane} sent={framesSent(presence)} maxFrames={DEFAULT_CONFIG.maxFrames} />
        {dev && !locked && size && roi && (
          <DevPanel camera={size} roi={roi} presence={presence} tuning={tuning}
            onTuning={(t) => { setTuning(t); store.setTuning(t) }}
            band={stored?.plateBand ?? null} canSetBand={Boolean(lastBand)}
            onSetBand={() => setBand(lastBand)} onClearBand={() => setBand(null)}
            onCalibrate={() => dispatch({ type: 'calibrate' })}
            saveFrames={saveFrames} onSaveFrames={(on) => { setSaveFramesState(on); store.setSaveFrames(on) }} />
        )}
      </div>

      <div className="cap__controls">
        <LastRead view={shown?.view ?? null} latencyMs={shown?.result.latency_ms ?? null} at={shown?.at ?? null} />
        {error && (
          <p className="cap__error" role="alert">
            {error.message}
            {error.pairing && <button type="button" className="btn btn--link" onClick={onUnpair}>RE-PAIR</button>}
          </p>
        )}
        <ModeSwitch mode={mode} onMode={setMode} />
        <CaptureNow enabled={mode === 'tap' && camera.kind === 'live'} busy={busy && mode === 'tap'} onTap={() => void tap()} />
        {!locked && (
          <button type="button" className="btn cap__edit" onClick={() => setEditing((v) => !v)} disabled={!roi}>
            {editing ? 'DONE — SAVE THE LANE ROI' : 'EDIT LANE ROI'}
          </button>
        )}
      </div>

      <ScreenLock locked={locked} onUnlock={() => setLocked(false)} onLock={lock} />
    </div>
  )
}
