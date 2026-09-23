/**
 * /capture — point A, the camera (CLAUDE.md §6.2).
 *
 * M1 is TAP mode on the laptop webcam: one frame per tap (or Space), sent to POST /recognise,
 * with the engine's answer overlaid for 3 s. The ROI, the presence + motion gate and burst
 * sampling are M2 (§8) — they need the tablet at the gate to be tuned, not a laptop.
 */

import { useState } from 'react'
import { ENGINE_URL } from '../../lib/supabase'
import { clearPairing, loadPairing, type Pairing } from '../../lib/device'
import { PairDevice } from './PairDevice'
import { CameraView } from './CameraView'

export function CaptureRoute() {
  const [pairing, setPairing] = useState<Pairing | null>(() => loadPairing('capture'))

  if (!ENGINE_URL) {
    return (
      <div className="placeholder">
        <span className="wordmark" style={{ fontSize: 30 }}>VTRACK</span>
        <span className="placeholder__ms">CAPTURE · NO ENGINE SET</span>
        <p className="placeholder__note">
          Add <span className="mono">VITE_ENGINE_URL=http://localhost:8000</span> to{' '}
          <span className="mono">apps/web/.env</span> and restart <span className="mono">pnpm dev</span>.
        </p>
      </div>
    )
  }

  if (!pairing) return <PairDevice engineUrl={ENGINE_URL} onPaired={setPairing} />

  return (
    <CameraView
      engineUrl={ENGINE_URL}
      pairing={pairing}
      onUnpair={() => {
        clearPairing('capture')
        setPairing(null)
      }}
    />
  )
}
