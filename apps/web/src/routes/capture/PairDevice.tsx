import { useState, type FormEvent } from 'react'
import { EngineError, sendHeartbeat } from '../../lib/engine'
import { MIN_TOKEN_LEN, savePairing, type Pairing } from '../../lib/device'

interface Props {
  engineUrl: string
  onPaired: (p: Pairing) => void
}

/**
 * Pair this screen as a camera, once. The token is checked against the engine before it is
 * kept — by sending a heartbeat, which the engine refuses for an unknown token, a token that
 * belongs to another device, or a display's token on a camera — so a bad pairing fails here
 * with its reason, not silently at the first vehicle.
 */
export function PairDevice({ engineUrl, onPaired }: Props) {
  const [deviceId, setDeviceId] = useState('cam-a')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function pair(e: FormEvent) {
    e.preventDefault()
    const pairing = { deviceId: deviceId.trim(), token: token.trim() }
    setBusy(true)
    setError(null)
    try {
      await sendHeartbeat(engineUrl, pairing, 'capture', 'm1-web')
      if (!savePairing('capture', pairing)) {
        setError('This browser is blocking local storage, so the pairing cannot be kept. Allow site data for this page.')
        return
      }
      onPaired(pairing)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        err instanceof EngineError && err.status === 401
          ? `${msg}. Check the cam-a value in DEVICE_TOKENS in services/engine/.env — and restart the engine after editing it.`
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={(e) => void pair(e)}>
        <span className="wordmark" style={{ fontSize: 22 }}>VTRACK</span>
        <h1>Pair this camera</h1>
        <p>
          Paste this camera's token — the <span className="mono">cam-a</span> value in{' '}
          <span className="mono">DEVICE_TOKENS</span> in <span className="mono">services/engine/.env</span>. It is kept on
          this device only.
        </p>
        <label className="pair__label" htmlFor="pair-device">DEVICE</label>
        <input id="pair-device" className="mono" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
          autoComplete="off" spellCheck={false} />
        <label className="pair__label" htmlFor="pair-token">TOKEN</label>
        <input id="pair-token" className="mono" type="password" value={token} autoFocus
          onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
        <button className="btn btn--primary" type="submit" disabled={busy || token.trim().length < MIN_TOKEN_LEN || !deviceId.trim()}>
          {busy ? 'CHECKING…' : 'PAIR'}
        </button>
        {error && <p className="error-note" role="alert">{error}</p>}
      </form>
    </div>
  )
}
