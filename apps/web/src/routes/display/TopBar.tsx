import { formatClock, siteLabel } from '../../lib/format'
import { SoundOnIcon, SoundOffIcon } from '../../lib/icons'
import { LANE, SITE } from '../../lib/supabase'
import type { EngineHealth } from '../../lib/engine'
import { EnginePill } from '../../lib/EnginePill'

interface Props {
  now: number
  cameraOnline: boolean
  engine: EngineHealth
  muted: boolean
  onToggleMute: () => void
}

/** The 56 px top bar of §3: wordmark, where we are, the two status pills, mute, clock. */
export function TopBar({ now, cameraOnline, engine, muted, onToggleMute }: Props) {
  return (
    <header className="topbar">
      <span className="wordmark" style={{ fontSize: 20 }}>VTRACK</span>
      <span className="topbar__where">
        {siteLabel(SITE)} · LANE {LANE}
      </span>

      <span className="topbar__spacer" />

      <span className={`pill ${cameraOnline ? 'pill--ok' : 'pill--offline'}`}>
        <span className="pill__dot" />
        CAMERA A · {cameraOnline ? 'LIVE' : 'OFFLINE'}
      </span>

      {/* What the engine's /health last said — never merely that a URL is set. Unset reads
          as a muted "not set", which is an absence, not an outage. */}
      <EnginePill health={engine} />

      <button
        type="button"
        className="iconbtn"
        aria-pressed={muted}
        aria-label={muted ? 'Unmute chimes' : 'Mute chimes'}
        title={muted ? 'Chimes muted' : 'Chimes on'}
        onClick={onToggleMute}
      >
        {muted ? <SoundOffIcon /> : <SoundOnIcon />}
      </button>

      <span className="topbar__clock">{formatClock(now)}</span>
    </header>
  )
}
