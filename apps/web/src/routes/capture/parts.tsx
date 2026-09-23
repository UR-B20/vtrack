/**
 * parts.tsx — the pieces of the capture screen (docs/screens/capture.png). Presentational:
 * CameraView owns the state and passes values in.
 */

import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { containFit, mapCropBox, rectToView, type Rect, type Size } from '../../lib/frame'
import { CameraIcon, CheckIcon, CrossIcon, WarnIcon } from '../../lib/icons'
import type { Lane } from '../../lib/presence'
import { moveRoi, resizeRoi, roiPixels, roiQuality, type Roi } from '../../lib/roi'
import type { CaptureMode } from '../../lib/captureStore'
import type { RecogniseResult } from '../../lib/engine'
import type { ReadView } from './readView'

// ── chips: what the camera is doing ─────────────────────────────────────────────────────

export function Chips({ mode, lane, sent, maxFrames }: { mode: CaptureMode; lane: Lane; sent: number; maxFrames: number }) {
  const laneText =
    lane === 'calibrating' ? 'CALIBRATING · CLEAR THE LANE'
      : lane === 'present' ? `VEHICLE IN LANE${mode === 'auto' ? ` · ${sent}/${maxFrames}` : ''}`
        : 'LANE EMPTY'
  return (
    <div className="cap__chips">
      <span className="chip">{mode === 'auto' ? 'AUTO · PRESENCE' : 'TAP MODE'}</span>
      <span className={`chip${lane === 'present' ? ' chip--on' : ''}${lane === 'calibrating' ? ' chip--warn' : ''}`}>{laneText}</span>
    </div>
  )
}

// ── the lane ROI, drawn over the video; draggable when editing ──────────────────────────

export function RoiLayer({ roi, camera, view, editing, onChange, onCommit }: {
  roi: Roi
  camera: Size
  view: Size
  editing: boolean
  onChange: (r: Roi) => void
  onCommit: (r: Roi) => void
}) {
  const drag = useRef<{ kind: 'move' | 'resize'; x: number; y: number; start: Roi; last: Roi } | null>(null)
  const box = rectToView(roiPixels(roi, camera), camera, view)
  const fit = containFit(camera, view)
  if (!box || !fit) return null
  const quality = roiQuality(roi, camera)
  const px = Math.round(roi.w * camera.width)

  const begin = (kind: 'move' | 'resize') => (e: ReactPointerEvent) => {
    if (!editing) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    drag.current = { kind, x: e.clientX, y: e.clientY, start: roi, last: roi }
  }
  const move = (e: ReactPointerEvent) => {
    const d = drag.current
    if (!d) return
    // Screen pixels → fractions of the camera frame.
    const dx = (e.clientX - d.x) / (camera.width * fit.scale)
    const dy = (e.clientY - d.y) / (camera.height * fit.scale)
    d.last = d.kind === 'move' ? moveRoi(d.start, dx, dy, camera) : resizeRoi(d.start, dx, dy, camera)
    onChange(d.last)
  }
  const end = () => {
    const d = drag.current
    drag.current = null
    if (d) onCommit(d.last)
  }

  return (
    <div
      className={`cap__roi${editing ? ' cap__roi--editing' : ''}${quality !== 'ok' ? ' cap__roi--small' : ''}`}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
    >
      <span className="cap__roi-label">
        LANE ROI{editing && <> · {px} px{quality === 'small' && ' · TOO NARROW FOR NIGHT READS'}</>}
      </span>
      {editing && (
        <span className="cap__roi-handle" onPointerDown={begin('resize')} onPointerMove={move}
          onPointerUp={end} onPointerCancel={end} aria-label="Resize the lane ROI" />
      )}
    </div>
  )
}

// ── the engine's box and label, for 3 s after each answer ───────────────────────────────

export function Detection({ result, view, sent, crop, camera, viewSize }: {
  result: RecogniseResult
  view: ReadView
  sent: Size
  crop: Rect
  camera: Size
  viewSize: Size
}) {
  const box = result.bbox ? mapCropBox(result.bbox, sent, crop, camera, viewSize) : null
  if (!box) {
    return (
      <div className={`cap__float tone-${view.tone}`} role="status">
        <b>{view.word}</b>
        {view.detail && <span className="cap__float-detail">{view.detail}</span>}
      </div>
    )
  }
  return (
    <>
      <div className={`cap__box tone-${view.tone}`} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
      <div className={`cap__boxlabel bg-${view.tone}`} style={{ left: box.left + box.width / 2, top: box.top }}>
        {view.plate ?? view.word}{view.tone !== 'none' && <> · {view.confidence}</>}
        {view.verify && ' · VERIFY'}{view.repaired && ' · REPAIRED'}
      </div>
    </>
  )
}

// ── LAST READ ───────────────────────────────────────────────────────────────────────────

export function LastRead({ view, latencyMs, at }: { view: ReadView | null; latencyMs: number | null; at: number | null }) {
  const Icon = view?.tone === 'allow' ? CheckIcon : view?.tone === 'deny' ? CrossIcon : WarnIcon
  return (
    <section className="lastread" aria-live="polite">
      <div>
        <span className="lastread__label">LAST READ</span>
        {view?.plate ? <span className="plate plate--chip lastread__plate">{view.plate}</span>
          : <span className="lastread__none">{view ? view.word : 'NO READS YET'}</span>}
      </div>
      {view && view.tone !== 'none' && (
        <div className="lastread__right">
          <span className={`lastread__word tone-${view.tone}`}>
            <Icon className="readchip__icon" /> {view.word}
            {view.verify && <span className="badge-verify">VERIFY</span>}
            {view.repaired && <span className="badge-verify">REPAIRED</span>}
          </span>
          <span className="lastread__meta mono">
            {latencyMs !== null && `${(latencyMs / 1000).toFixed(1)} s`}
            {at !== null && ` · ${new Date(at).toLocaleTimeString('en-GB', { hour12: false })}`}
          </span>
        </div>
      )}
    </section>
  )
}

// ── AUTO | TAP, and CAPTURE NOW ─────────────────────────────────────────────────────────

export function ModeSwitch({ mode, onMode }: { mode: CaptureMode; onMode: (m: CaptureMode) => void }) {
  return (
    <div className="modeswitch" role="radiogroup" aria-label="Capture mode">
      {(['auto', 'tap'] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m}
          className={`modeswitch__opt${mode === m ? ' modeswitch__opt--on' : ''}`} onClick={() => onMode(m)}>
          {m.toUpperCase()}
        </button>
      ))}
    </div>
  )
}

export function CaptureNow({ enabled, busy, onTap }: { enabled: boolean; busy: boolean; onTap: () => void }) {
  return (
    <button type="button" className="capnow" disabled={!enabled || busy} onClick={onTap}>
      <CameraIcon className="capnow__icon" />
      {busy ? 'READING…' : 'CAPTURE NOW · TAP MODE ONLY'}
    </button>
  )
}
