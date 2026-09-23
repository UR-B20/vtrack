import { formatClock, siteLabel } from '../../lib/format'
import { SoundOnIcon, SoundOffIcon } from '../../lib/icons'
import { ENGINE_URL, LANE, SITE } from '../../lib/supabase'

interface Props {
  now: number
  cameraOnline: boolean
  muted: boolean
  onToggleMute: () => void
}

/** The 56 px top bar of §3: wordmark, where we are, the two status pills, mute, clock. */
export function TopBar({ now, cameraOnline, muted, onToggleMute }: Props) {
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

      {/* No engine exists in M0. An unset VITE_ENGINE_URL means "not deployed yet",
          which is not the same as an outage, so it reads as a muted pill rather than red. */}
      <span className={`pill ${ENGINE_URL ? 'pill--ok' : ''}`}>
        <span className="pill__dot" />
        ENGINE · {ENGINE_URL ? 'CLOUD OK' : 'M1'}
      </span>

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
