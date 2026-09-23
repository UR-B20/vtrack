import { useState } from 'react'
import { supabase } from '../../lib/supabase'

/**
 * Admin sign-in — Supabase Auth email OTP (§6.3).
 *
 * The list is personal data (brief §3.10), so it is never readable with the anon key:
 * `vehicles` has no anon policy at all, and every admin read goes through a JWT whose
 * app_metadata.role is 'admin'. That claim is granted by supabase/admin_role.sql and is
 * baked in at token issue, so a fresh sign-in is required after it is first set.
 */
export function SignIn() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function send() {
    if (!supabase) return setError('Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.')
    setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } })
    setBusy(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  async function verify() {
    if (!supabase) return
    setBusy(true); setError(null)
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
    setBusy(false)
    if (error) setError(error.message)
  }

  return (
    <div className="signin">
      <div className="signin__card">
        <span className="wordmark" style={{ fontSize: 22 }}>VTRACK</span>
        <h1>Admin console</h1>

        {!sent ? (
          <>
            <p>Sign in with a one-time code sent to your email.</p>
            <input
              type="email" value={email} placeholder="you@example.com" autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void send() }}
            />
            <button className="btn btn--primary" onClick={() => void send()} disabled={busy || !email.includes('@')}>
              {busy ? 'SENDING…' : 'SEND CODE'}
            </button>
          </>
        ) : (
          <>
            <p>Enter the code sent to <strong>{email}</strong>.</p>
            <input
              inputMode="numeric" value={code} placeholder="123456" autoFocus className="mono"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void verify() }}
            />
            <button className="btn btn--primary" onClick={() => void verify()} disabled={busy || code.trim().length < 6}>
              {busy ? 'CHECKING…' : 'SIGN IN'}
            </button>
            <button className="btn btn--link" onClick={() => { setSent(false); setCode('') }}>
              Use a different email
            </button>
          </>
        )}

        {error && <p className="error-note">{error}</p>}
      </div>
    </div>
  )
}
