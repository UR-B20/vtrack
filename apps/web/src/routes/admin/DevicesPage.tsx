import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { newDeviceToken, tokenHash } from '../../lib/deviceToken'
import { ago, DEVICE_COLUMNS, seenState, takesToken, type DeviceRow, type Seen } from './devices'

const REFRESH_MS = 10_000

const SEEN: Record<Seen, { label: string; badge: string }> = {
  online: { label: 'ONLINE', badge: 'active' },
  offline: { label: 'OFFLINE', badge: 'expired' },
  never: { label: 'NEVER SEEN', badge: 'expiring' },
  not_reported: { label: 'DOES NOT REPORT', badge: 'muted' },
}

function explain(error: { code?: string; message: string }): string {
  if (/token_rotated_at/.test(error.message) || error.code === '42703') {
    return 'This database is missing migration 0005 — run supabase/migrations/0005_device_tokens.sql.'
  }
  if (error.code === '42501' || /permission denied/i.test(error.message)) {
    return 'Not allowed. Sign in with the admin login, and check migration 0005 was run.'
  }
  return error.message
}

/**
 * /admin → Devices (CLAUDE.md §6.3, §11 Device tokens): when each device last reported and
 * which version it runs, and a new token for the camera. The token is made here, shown
 * once, and only its sha256 is saved; the engine accepts it within seconds and the old one
 * stops working.
 */
export function DevicesPage() {
  const [rows, setRows] = useState<DeviceRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ deviceId: string; token: string } | null>(null)

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('devices').select(DEVICE_COLUMNS).order('id')
    if (error) setError(explain(error))
    else { setError(null); setRows((data ?? []) as DeviceRow[]) }
    setNow(Date.now())
  }, [])

  useEffect(() => {
    void load()
    const id = setInterval(() => void load(), REFRESH_MS)
    return () => clearInterval(id)
  }, [load])

  async function rotate(row: DeviceRow) {
    if (!supabase) return
    const ok = window.confirm(
      `Make a new token for ${row.id}?\n\n` +
      `Its current token stops working within a few seconds, so ${row.id} stops sending until ` +
      'it is paired again with the new one. Do this when the gate is quiet.')
    if (!ok) return
    setBusy(row.id); setError(null)
    try {
      const token = newDeviceToken()
      const { data, error } = await supabase
        .from('devices')
        .update({ token_hash: await tokenHash(token), token_rotated_at: new Date().toISOString() })
        .eq('id', row.id)
        .select('id')
      if (error) setError(explain(error))
      else if (!data || data.length === 0) setError('Nothing was changed — this login is not allowed to set tokens.')
      else setIssued({ deviceId: row.id, token })
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <h1 className="admin__h1">Devices</h1>
      <p className="admin__sub">
        Camera A reports every 10 seconds while its page is open; the engine every 10 minutes. The gate display
        only listens, so it never reports here.
      </p>

      {error && <p className="error-note" style={{ marginBottom: 16 }}>{error}</p>}

      {issued && (
        <div className="token-reveal" role="status">
          <div className="token-reveal__head">NEW TOKEN FOR {issued.deviceId.toUpperCase()} · SHOWN ONCE</div>
          <div className="token-reveal__token mono" aria-label="New device token">{issued.token}</div>
          <ol className="token-reveal__steps">
            <li>On the device, at <span className="mono">/capture</span>: unlock (hold the bottom bar 2 s), then tap
              <b> UNPAIR</b>. Until you do, it keeps trying the old token and the next vehicle gets no result.</li>
            <li>Choose <b>TYPE THE TOKEN INSTEAD</b>: device <span className="mono">{issued.deviceId}</span>, and the token
              above exactly, dashes included.</li>
            <li>Close this box. The token is not saved anywhere — if it is lost, make another.</li>
          </ol>
          <div className="token-reveal__actions">
            <button className="btn btn--paper" onClick={() => void navigator.clipboard?.writeText(issued.token)}>COPY</button>
            <button className="btn btn--navy" onClick={() => setIssued(null)}>DONE — CLOSE</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="vehicles devices">
          <thead>
            <tr><th>DEVICE</th><th>ROLE</th><th>WHERE</th><th>LAST SEEN</th><th>VERSION</th><th>TOKEN</th></tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const seen = SEEN[seenState(d, now)]
              return (
                <tr key={d.id}>
                  <td><b>{d.name ?? d.id}</b><div className="mono devices__id">{d.id}</div></td>
                  <td className="mono">{d.role}</td>
                  <td className="mono">{[d.site, d.lane].filter(Boolean).join(' / ') || '—'}</td>
                  <td>
                    <span className={`badge badge--${seen.badge}`}>{seen.label}</span>
                    {d.last_seen_at && <div className="mono devices__id">{ago(d.last_seen_at, now)}</div>}
                  </td>
                  <td className="mono">{d.version ?? '—'}</td>
                  <td>
                    {takesToken(d) ? (
                      <>
                        <div className="devices__token">
                          {d.token_rotated_at
                            ? `Set here ${new Date(d.token_rotated_at).toLocaleString('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                            : 'From the engine settings (DEVICE_TOKENS)'}
                        </div>
                        <button className="btn btn--paper" disabled={busy !== null} onClick={() => void rotate(d)}>
                          {busy === d.id ? 'SETTING…' : 'NEW TOKEN'}
                        </button>
                      </>
                    ) : (
                      <span className="devices__token">{d.role === 'display' ? 'Signs in instead' : '—'}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="table-foot">{rows.length} DEVICES · REFRESHES EVERY 10 S</div>
      </div>
    </>
  )
}
