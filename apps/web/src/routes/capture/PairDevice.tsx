import { useEffect, useRef, useState, type FormEvent } from 'react'
import { EngineError, sendHeartbeat } from '../../lib/engine'
import { MIN_TOKEN_LEN, parsePairingCode, savePairing, type Pairing } from '../../lib/device'

interface Props {
  engineUrl: string
  onPaired: (p: Pairing) => void
}

/** Chrome on Android (the gate tablets) has it; Safari and Firefox do not. Not in TS's DOM lib. */
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike
const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector

const APP_VERSION = 'm2-web'

/**
 * Pair this screen as a camera, once. On the laptop, `uv run vtrack-pair-qr cam-a` shows a
 * QR code; this screen scans it, so nobody types a 32-character token on a tablet. Typing it
 * stays as the fallback.
 *
 * Either way the token is checked against the engine before it is kept — by sending a
 * heartbeat, which the engine refuses for an unknown token, a token that belongs to another
 * device, or a display's token on a camera — so a bad pairing fails here with its reason,
 * not silently at the first vehicle.
 */
export function PairDevice({ engineUrl, onPaired }: Props) {
  const [deviceId, setDeviceId] = useState('cam-a')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function verify(pairing: Pairing) {
    setBusy(true)
    setError(null)
    try {
      await sendHeartbeat(engineUrl, pairing, 'capture', APP_VERSION)
      if (!savePairing('capture', pairing)) {
        setError('This browser is blocking local storage, so the pairing cannot be kept. Allow site data for this page.')
        return
      }
      onPaired(pairing)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        err instanceof EngineError && err.status === 401
          ? `${msg}. Check the ${pairing.deviceId} value in DEVICE_TOKENS — services/engine/.env on the laptop, Render → Environment for the cloud engine. They must match.`
          : msg,
      )
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    void verify({ deviceId: deviceId.trim(), token: token.trim() })
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <span className="wordmark" style={{ fontSize: 22 }}>VTRACK</span>
        <h1>Pair this camera</h1>
        {scanning ? (
          <QrScanner
            onCode={(p) => {
              setScanning(false)
              void verify(p)
            }}
            onCancel={() => setScanning(false)}
            onProblem={(m) => {
              setScanning(false)
              setError(m)
            }}
          />
        ) : (
          <>
            <p>
              On the laptop, in <span className="mono">services/engine</span>, run{' '}
              <span className="mono">uv run vtrack-pair-qr cam-a</span> and scan the code it shows.
            </p>
            <button type="button" className="btn btn--primary" disabled={busy || !Detector}
              onClick={() => { setError(null); setScanning(true) }}>
              {busy ? 'CHECKING…' : 'SCAN PAIRING CODE'}
            </button>
            {!Detector && (
              <p className="placeholder__note">This browser cannot scan codes. Type the token below instead.</p>
            )}
          </>
        )}

        <details className="pair__typed" open={!Detector}>
          <summary>TYPE THE TOKEN INSTEAD</summary>
          <form onSubmit={submit}>
            <p>
              The <span className="mono">cam-a</span> value in <span className="mono">DEVICE_TOKENS</span>. It is kept on
              this device only.
            </p>
            <label className="pair__label" htmlFor="pair-device">DEVICE</label>
            <input id="pair-device" className="mono" value={deviceId} onChange={(e) => setDeviceId(e.target.value)}
              autoComplete="off" spellCheck={false} />
            <label className="pair__label" htmlFor="pair-token">TOKEN</label>
            <input id="pair-token" className="mono" type="password" value={token}
              onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
            <button className="btn btn--primary" type="submit"
              disabled={busy || token.trim().length < MIN_TOKEN_LEN || !deviceId.trim()}>
              {busy ? 'CHECKING…' : 'PAIR'}
            </button>
          </form>
        </details>
        {error && <p className="error-note" role="alert">{error}</p>}
      </div>
    </div>
  )
}

/** The rear camera, read for a VTrack pairing code a few times a second. */
function QrScanner({ onCode, onCancel, onProblem }: {
  onCode: (p: Pairing) => void
  onCancel: () => void
  onProblem: (message: string) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [hint, setHint] = useState('Point the camera at the code on the laptop screen.')
  // The callbacks are new on every parent render; the camera must not restart for that.
  const onCodeRef = useRef(onCode)
  const onProblemRef = useRef(onProblem)
  onCodeRef.current = onCode
  onProblemRef.current = onProblem

  useEffect(() => {
    if (!Detector) return
    const detector = new Detector({ formats: ['qr_code'] })
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    let cancelled = false
    let done = false

    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream = s
        const video = videoRef.current
        if (!video) return
        video.srcObject = s
        void video.play().catch(() => undefined)
        timer = setInterval(() => {
          if (done || video.readyState < 2) return
          detector.detect(video).then((codes) => {
            for (const c of codes) {
              const p = parsePairingCode(c.rawValue)
              if (p && !done) {
                done = true
                // Release the camera before /capture asks for it again.
                stream?.getTracks().forEach((t) => t.stop())
                onCodeRef.current(p)
                return
              }
            }
            if (codes.length) setHint('That is not a VTrack pairing code. Run vtrack-pair-qr on the laptop.')
          }).catch(() => undefined)
        }, 300)
      })
      .catch(() => {
        if (!cancelled) onProblemRef.current('The camera could not start for scanning. Allow the camera for this page, or type the token.')
      })

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="pair__scan">
      <video ref={videoRef} className="pair__video" muted playsInline autoPlay aria-label="Camera, scanning for a pairing code" />
      <p className="placeholder__note">{hint}</p>
      <button type="button" className="btn btn--link" onClick={onCancel}>CANCEL</button>
    </div>
  )
}
