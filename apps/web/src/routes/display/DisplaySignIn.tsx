import { useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { signInProblem } from '../../lib/displayAuth'

/**
 * Phone B's one-time sign-in (CLAUDE.md §11, Display sign-in). The display reads the
 * approved list, which is personal data, so since 0004 it needs its own login: the one
 * created under Supabase → Authentication → Users and given the display role by
 * supabase/display_role.sql. The session is kept on the phone and refreshes itself, so
 * this screen is seen once, not every shift.
 */
export function DisplaySignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true); setError(null)
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) setError(signInProblem(error))
    } catch (thrown) {
      setError(signInProblem({ message: thrown instanceof Error ? thrown.message : String(thrown) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <form className="signin__card" onSubmit={(e) => void submit(e)}>
        <span className="wordmark" style={{ fontSize: 22 }}>VTRACK</span>
        <h1>Gate display</h1>
        <p>
          Sign in once with the display login. This phone stays signed in; the approved list is
          never shown without it.
        </p>
        <input type="email" value={email} placeholder="Display login email" autoFocus
          autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
        <input type="password" value={password} placeholder="Password"
          autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        <button className="btn btn--primary" type="submit" disabled={busy || !email.includes('@') || !password}>
          {busy ? 'SIGNING IN…' : 'SIGN IN'}
        </button>
        {error && <p className="error-note" role="alert">{error}</p>}
      </form>
    </div>
  )
}
