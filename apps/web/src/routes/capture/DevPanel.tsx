import { useState } from 'react'
import type { Size } from '../../lib/frame'
import type { PresenceState } from '../../lib/presence'
import { TUNING_LIMITS, type Tuning } from '../../lib/captureStore'
import { roiQuality, type PlateBand, type Roi } from '../../lib/roi'
import type { CameraZoom } from './useCamera'

/**
 * ?dev=1 only — the setup panel used at the gate (STOP 2), never shown to the guard:
 * live presence/motion levels against their thresholds, the thresholds themselves, the
 * camera and ROI resolution, the camera's zoom, the plate-size calibration, re-calibrating
 * the empty lane, and saving every frame sent, to see what the camera saw when a vehicle was
 * missed.
 */
export function DevPanel(props: {
  camera: Size
  roi: Roi
  presence: PresenceState
  tuning: Tuning
  onTuning: (t: Tuning) => void
  band: PlateBand | null
  canSetBand: boolean
  onSetBand: () => void
  onClearBand: () => void
  onCalibrate: () => void
  zoom: CameraZoom | null
  onZoom: (value: number) => void
  saveFrames: boolean
  onSaveFrames: (on: boolean) => void
}) {
  const { camera, roi, presence: p, tuning } = props
  const [open, setOpen] = useState(true)
  const px = Math.round(roi.w * camera.width)
  const quality = roiQuality(roi, camera)

  if (!open) {
    return <button type="button" className="capdev capdev--closed" onClick={() => setOpen(true)}>DEV</button>
  }

  const meter = (label: string, level: number, threshold: number) => (
    <div className="capdev__meter">
      <span>{label}</span>
      <span className="capdev__bar">
        <span className={`capdev__fill${level > threshold ? ' capdev__fill--over' : ''}`}
          style={{ width: `${Math.min(100, (level / Math.max(threshold * 3, 0.01)) * 100)}%` }} />
        <span className="capdev__mark" style={{ left: '33.3%' }} />
      </span>
      <span className="mono">{level.toFixed(3)} / {threshold.toFixed(3)}</span>
    </div>
  )

  const slider = (key: keyof Tuning, label: string) => {
    const [lo, hi] = TUNING_LIMITS[key]
    return (
      <label className="capdev__slider">
        <span>{label}</span>
        <input type="range" min={lo} max={hi} step={(hi - lo) / 200} value={tuning[key]}
          onChange={(e) => props.onTuning({ ...tuning, [key]: Number(e.target.value) })} />
        <span className="mono">{tuning[key].toFixed(3)}</span>
      </label>
    )
  }

  return (
    <aside className="capdev" onPointerDown={(e) => e.stopPropagation()}>
      <div className="capdev__head">
        <b>DEV · SETUP</b>
        <button type="button" className="btn btn--link" onClick={() => setOpen(false)}>HIDE</button>
      </div>
      <div className="mono capdev__line">
        CAMERA {camera.width}×{camera.height} · ROI {px} px{quality !== 'ok' && ' · NARROW'}
      </div>
      <div className="mono capdev__line">
        LANE {p.lane.toUpperCase()} · SESSION {p.session ? `#${p.session.id} ${p.session.sent}/12${p.session.done ? ` ${p.session.done.toUpperCase()}` : ''}` : '—'}
        {p.inFlight && (p.session?.rechecking ? ' · RE-READING' : ' · IN FLIGHT')}
      </div>
      <div className="mono capdev__line">SEEN {p.seen ?? '—'}</div>
      {props.zoom ? (
        <label className="capdev__slider">
          <span>ZOOM</span>
          <input type="range" min={props.zoom.range.min} max={props.zoom.range.max} step={props.zoom.range.step}
            value={props.zoom.value} onChange={(e) => props.onZoom(Number(e.target.value))} />
          <span className="mono">{props.zoom.value.toFixed(1)}×</span>
        </label>
      ) : (
        <div className="mono capdev__line">ZOOM — this camera offers none in this browser</div>
      )}
      {meter('PRESENCE', p.presenceLevel, tuning.presenceFrac)}
      {meter('MOTION', p.motionLevel, tuning.motionFrac)}
      {slider('presenceFrac', 'PRESENT AT')}
      {slider('motionFrac', 'MOVING AT')}
      {slider('cellT', 'CELL CHANGE')}
      <div className="mono capdev__line">
        PLATE SIZE {props.band ? `${(props.band[0] * 100).toFixed(1)}–${(props.band[1] * 100).toFixed(1)} % of ROI` : 'NOT SET'}
      </div>
      <div className="capdev__buttons">
        <button type="button" className="btn" disabled={!props.canSetBand} onClick={props.onSetBand}>SET PLATE SIZE</button>
        <button type="button" className="btn" disabled={!props.band} onClick={props.onClearBand}>CLEAR SIZE</button>
        <button type="button" className="btn" onClick={props.onCalibrate}>LANE IS EMPTY</button>
      </div>
      <label className="capdev__check">
        <input type="checkbox" checked={props.saveFrames} onChange={(e) => props.onSaveFrames(e.target.checked)} />
        SAVE EVERY FRAME SENT (to look into a missed read — personal data, delete when done)
      </label>
    </aside>
  )
}
