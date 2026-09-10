import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { Vehicle } from '../../lib/types'
import { SignIn } from './SignIn'
import { VehiclesTable } from './VehiclesTable'
import { VehicleDrawer, type VehicleDraft } from './VehicleDrawer'
import type { importableRows } from './csv'

type Page = 'vehicles' | 'events' | 'devices' | 'settings'

/** The nav of admin.png. Only Vehicles is M0 — the rest arrive with the engine. */
const NAV: { key: Page; label: string; milestone?: string }[] = [
  { key: 'vehicles', label: 'VEHICLES' },
  { key: 'events', label: 'EVENTS', milestone: 'M3' },
  { key: 'devices', label: 'DEVICES', milestone: 'M3' },
  { key: 'settings', label: 'SETTINGS', milestone: 'M3' },
]

function isAdmin(session: Session | null): boolean {
  return session?.user?.app_metadata?.role === 'admin'
}

export function AdminRoute() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)
  const [vehicles, setVehicles] = useState<Vehicle[]>([])
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ vehicle: Vehicle | null } | null>(null)
  const [page] = useState<Page>('vehicles')

  useEffect(() => {
    if (!supabase) { setReady(true); return }
    void supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const load = useCallback(async () => {
    if (!supabase) return
    const { data, error } = await supabase.from('vehicles').select('*').order('plate_norm')
    if (error) setError(error.message)
    else { setError(null); setVehicles((data ?? []) as Vehicle[]) }
  }, [])

  useEffect(() => { if (isAdmin(session)) void load() }, [session, load])

  const existing = useMemo(() => new Set(vehicles.map((v) => v.plate_norm)), [vehicles])

  const onSave = useCallback(async (draft: VehicleDraft): Promise<string | null> => {
    if (!supabase) return 'Supabase is not configured.'
    const payload = {
      plate_norm: draft.plate_norm, plate_display: draft.plate_display,
      owner_name: draft.owner_name, org_unit: draft.org_unit,
      vehicle_type: draft.vehicle_type, pass_type: draft.pass_type, status: draft.status,
      valid_from: draft.valid_from, valid_until: draft.valid_until, notes: draft.notes,
    }
    const { error } = draft.id
      ? await supabase.from('vehicles').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', draft.id)
      : await supabase.from('vehicles').insert(payload)
    if (error) return error.message
    await load()
    return null
  }, [load])

  const onDelete = useCallback(async (id: string): Promise<string | null> => {
    if (!supabase) return 'Supabase is not configured.'
    const { error } = await supabase.from('vehicles').delete().eq('id', id)
    if (error) return error.message
    await load()
    return null
  }, [load])

  const onImport = useCallback(async (rows: ReturnType<typeof importableRows>): Promise<string | null> => {
    if (!supabase) return 'Supabase is not configured.'
    if (rows.length === 0) return null
    const { error } = await supabase.from('vehicles').insert(rows)
    if (error) return error.message
    await load()
    return null
  }, [load])

  if (!ready) return <div className="placeholder"><span className="wordmark" style={{ fontSize: 26 }}>VTRACK</span></div>
  if (!session) return <SignIn />

  if (!isAdmin(session)) {
    return (
      <div className="signin">
        <div className="signin__card">
          <span className="wordmark" style={{ fontSize: 22 }}>VTRACK</span>
          <h1>Not an admin</h1>
          <p>
            You are signed in as <strong>{session.user.email}</strong>, but this account does not carry the
            admin role. Run <span className="mono">supabase/admin_role.sql</span> for this email, then sign out
            and back in — the role is baked into the token when it is issued.
          </p>
          <button className="btn btn--primary" onClick={() => void supabase?.auth.signOut()}>SIGN OUT</button>
        </div>
      </div>
    )
  }

  return (
    <div className="admin">
      <nav className="admin__side">
        <div className="admin__brand">
          <div className="wordmark" style={{ fontSize: 22 }}>VTRACK</div>
          <div className="admin__brand-sub">ADMIN CONSOLE</div>
        </div>

        <div className="admin__nav">
          {NAV.map((item) => (
            <button
              key={item.key} className="admin__navitem"
              aria-current={page === item.key ? 'page' : undefined}
              disabled={Boolean(item.milestone)}
              title={item.milestone ? `Arrives in ${item.milestone}` : undefined}
            >
              {item.label}
              {item.milestone && <small>{item.milestone}</small>}
            </button>
          ))}
        </div>

        <div className="admin__user">
          {session.user.email} · admin
          <button className="admin__signout" onClick={() => void supabase?.auth.signOut()}>SIGN OUT</button>
        </div>
      </nav>

      <main className="admin__main">
        {error && <p className="error-note" style={{ marginBottom: 16 }}>{error}</p>}
        <VehiclesTable
          vehicles={vehicles}
          onEdit={(vehicle) => setDrawer({ vehicle })}
          onAdd={() => setDrawer({ vehicle: null })}
          onImport={onImport}
        />
      </main>

      {drawer && (
        <VehicleDrawer
          vehicle={drawer.vehicle}
          existing={existing}
          onSave={onSave}
          onDelete={onDelete}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  )
}
