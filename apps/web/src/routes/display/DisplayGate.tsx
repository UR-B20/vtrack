import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { clearVehicles } from '../../lib/cache'
import { displayAccess } from '../../lib/displayAuth'
import { DisplayRoute } from './DisplayRoute'
import { DisplaySignIn } from './DisplaySignIn'

/**
 * /display only runs signed in (CLAUDE.md §11, Display sign-in, 26 Oct 2026): the public
 * key reads nothing since 0004, so every query and the Realtime channel need the display
 * login's token. DisplayRoute mounts only once there is one, so all of its effects start
 * authenticated. Without Supabase configured (a laptop with no .env) it runs as before.
 */
export function DisplayGate() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!supabase)

  useEffect(() => {
    if (!supabase) return
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      // The offline copy is personal data: it leaves with the login.
      if (event === 'SIGNED_OUT') void clearVehicles()
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  if (!supabase) return <DisplayRoute />
  if (!ready) return <div className="placeholder"><span className="wordmark" style={{ fontSize: 26 }}>VTRACK</span></div>

  switch (displayAccess(session)) {
    case 'signed_out':
      return <DisplaySignIn />
    case 'no_role':
      return (
        <div className="signin">
          <div className="signin__card">
            <span className="wordmark" style={{ fontSize: 22 }}>VTRACK</span>
            <h1>Not a display login</h1>
            <p>
              Signed in as <strong>{session?.user.email}</strong>, but this login is not set up for the gate
              display. Run <span className="mono">supabase/display_role.sql</span> for this email, then sign out
              and back in.
            </p>
            <button className="btn btn--primary" onClick={() => void supabase?.auth.signOut()}>SIGN OUT</button>
          </div>
        </div>
      )
    case 'ok':
      return <DisplayRoute />
  }
}
