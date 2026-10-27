import { useCallback, useEffect, useState } from 'react'
import { ENGINE_URL, LANE, SITE } from '../../lib/supabase'
import { classifyHealth, engineLabel, probeHealth, type Health, type HealthProbe } from '../../lib/engine'
import { thresholdRows, uptime } from './settings'

/**
 * /admin → Settings (CLAUDE.md §6.3): what the engine runs with, read from its public
 * /health and explained. Documented, not edited: a threshold is changed in the engine's
 * environment variables on Render, which restarts it.
 */
export function SettingsPage() {
  const [probe, setProbe] = useState<HealthProbe | null>(null)

  const load = useCallback(async () => {
    if (ENGINE_URL) setProbe(await probeHealth(ENGINE_URL))
  }, [])
  useEffect(() => { void load() }, [load])

  const body: Health | null = probe && 'body' in probe ? probe.body : null
  const status = !ENGINE_URL ? 'ENGINE · NOT SET'
    : probe === null ? 'ENGINE · CHECKING' : engineLabel(classifyHealth(probe, ENGINE_URL))

  return (
    <>
      <h1 className="admin__h1">Settings</h1>
      <p className="admin__sub">
        Read from the engine. To change a value, edit its variable in Render (the engine&rsquo;s Environment page);
        Render restarts the engine with it.
      </p>

      <div className="admin__toolbar">
        <span className="badge badge--muted">{status}</span>
        <span className="admin__spacer" />
        <button className="btn btn--paper" onClick={() => void load()}>REFRESH</button>
      </div>

      <div className="table-wrap" style={{ marginBottom: 22 }}>
        <table className="vehicles settings">
          <tbody>
            <tr><th>ENGINE</th><td className="mono">{ENGINE_URL ?? '—'}</td></tr>
            <tr><th>PLATE READER</th><td>{body ? `${body.engine === 'cloud' ? 'Plate Recognizer (cloud)' : 'Open-source model on the engine'}${body.model ? ` · ${body.model}` : ''}` : '—'}</td></tr>
            <tr><th>MODEL</th><td className="mono">{body?.model_status ?? '—'}</td></tr>
            <tr><th>DATABASE</th><td className="mono">{body?.db ?? '—'}{body?.reason ? ` · ${body.reason}` : ''}</td></tr>
            <tr><th>VERSION</th><td className="mono">{body?.version ?? '—'}</td></tr>
            <tr><th>RUNNING FOR</th><td className="mono">{uptime(body?.uptime_s)}</td></tr>
            <tr><th>THIS SITE</th><td className="mono">{SITE} · lane {LANE}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="table-wrap">
        <table className="vehicles settings">
          <thead>
            <tr><th>THRESHOLD</th><th>VALUE</th><th>RENDER VARIABLE</th><th>WHAT IT DOES</th></tr>
          </thead>
          <tbody>
            {thresholdRows(body?.thresholds).map((r) => (
              <tr key={r.key}>
                <td><b>{r.label}</b></td>
                <td className="mono">{r.value}</td>
                <td className="mono settings__env">{r.env}</td>
                <td className="settings__meaning">{r.meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
