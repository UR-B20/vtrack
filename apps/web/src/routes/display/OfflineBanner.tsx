import { formatShortClock } from '../../lib/format'
import { OfflineIcon } from '../../lib/icons'
import { engineLabel, type EngineHealth } from '../../lib/engine'

interface Props {
  cameraOffline: boolean
  realtimeDown: boolean
  /** Local ms since the camera was last seen, or null when heartbeats do not exist yet. */
  cameraSince: number | null
  cacheSyncedAt: number | null
  engine: EngineHealth
  now: number
}

/**
 * The grey strip under the top bar (gate-offline.png).
 *
 * It never displaces the stage — brief §4.5 is explicit that the state is "preserved
 * underneath". A result the guard is acting on must not vanish because a heartbeat
 * was missed.
 */
export function OfflineBanner({ cameraOffline, realtimeDown, cameraSince, cacheSyncedAt, engine, now }: Props) {
  if (!cameraOffline && !realtimeDown) return null

  const heartbeatAgo = cameraSince === null ? null : Math.round((now - cameraSince) / 1000)

  return (
    <div className="banner" role="status">
      <OfflineIcon />
      {realtimeDown ? (
        <>
          <span className="banner__title"><b>NO CONNECTION</b> · manual mode</span>
          <span className="banner__meta">the list below is the last synced copy</span>
        </>
      ) : (
        <>
          <span className="banner__title">
            <b>CAMERA A OFFLINE</b>
            {cameraSince !== null && <> · since {formatShortClock(cameraSince)}</>}
          </span>
          {heartbeatAgo !== null && <span className="banner__meta">heartbeat {heartbeatAgo} s ago</span>}
        </>
      )}

      <span className="banner__right">
        {engineLabel(engine)}
        {' · '}
        {cacheSyncedAt ? `LIST CACHED ${formatShortClock(cacheSyncedAt)}` : 'LIST NOT YET CACHED'}
      </span>
    </div>
  )
}
