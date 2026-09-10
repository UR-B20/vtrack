import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { CAMERA_DEVICE_ID, HEARTBEATS_ENABLED, SITE, supabase } from '../../lib/supabase'
import { findVehicle, loadVehicles, refreshVehicles, REFRESH_MS, type CachedList } from '../../lib/cache'
import { isMuted, playDecision, setMuted, unlockAudio } from '../../lib/sounds'
import { isDevMode } from '../../lib/router'
import type { EventRow, VehiclePublic } from '../../lib/types'
import { clearAt, initialState, reduce, stageEvent, type Action, type MachineState } from './displayMachine'
import { TopBar } from './TopBar'
import { Stage } from './Stage'
import { Rail } from './Rail'
import { OfflineBanner } from './OfflineBanner'
import { ManualMode } from './ManualMode'
import { SimulatePanel } from './SimulatePanel'
import { storedActor, type GuardActionRequest } from './GuardActions'

/** Drives the hold/clear windows and the "READ n.n s AGO" line. */
const TICK_MS = 250
/** How often we ask the devices table whether the camera is still alive (§6.1). */
const HEARTBEAT_POLL_MS = 10_000

/**
 * The gate display at point B.
 *
 * The reducer in displayMachine.ts owns everything that depends only on events. This
 * component owns the I/O — Realtime, the vehicle cache, connectivity — and keeps those
 * flags out of the machine, which is why the machine stays pure and fully tested.
 */
export function DisplayRoute() {
  // Declared before useReducer: React invokes the reducer during the mount pass, so a
  // ref declared afterwards is still in its temporal dead zone when the reducer runs.
  const pendingEffects = useRef<{ type: 'sound'; decision: EventRow['decision'] }[]>([])

  const [state, rawDispatch] = useReducer(
    (s: MachineState, a: Action) => {
      const step = reduce(s, a)
      // Effects are collected during the reduce and played after commit, so the reducer
      // itself stays pure and React's double-invoke in StrictMode cannot double-chime.
      pendingEffects.current.push(...step.effects)
      return step.state
    },
    initialState,
  )

  const [now, setNow] = useState(() => Date.now())
  const [muted, setMutedState] = useState(isMuted)
  const [cache, setCache] = useState<CachedList>({ rows: [], syncedAt: null, count: 0, syncError: null })
  const [channelReady, setChannelReady] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [cameraOnline, setCameraOnline] = useState(true)
  const [cameraSince, setCameraSince] = useState<number | null>(null)
  const dev = useMemo(isDevMode, [])

  const dispatch = useCallback((action: Action) => rawDispatch(action), [])

  // Play whatever the last reduce asked for.
  useEffect(() => {
    const effects = pendingEffects.current
    pendingEffects.current = []
    for (const effect of effects) playDecision(effect.decision)
  })

  // ── clock ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now()
      setNow(t)
      dispatch({ type: 'tick', now: t })
    }, TICK_MS)
    return () => clearInterval(id)
  }, [dispatch])

  // ── the offline list, refreshed every 5 minutes while online (§6.1) ──────
  useEffect(() => {
    let alive = true
    void loadVehicles().then((c) => { if (alive) setCache(c) })
    const sync = () => {
      void refreshVehicles()
        .then((c) => { if (alive) setCache(c) })
        .catch((e: unknown) => {
          // refreshVehicles handles its own failures; this is the last line of defence
          // so a rejection can never leave the guard looking at a silently empty list.
          console.warn('[vtrack] vehicle list refresh rejected:', e)
          if (alive) setCache((prev) => ({ ...prev, syncError: 'the vehicle list refresh failed unexpectedly' }))
        })
    }
    sync()
    const id = setInterval(sync, REFRESH_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // ── realtime: the last five for the rail, then live inserts and updates ──
  useEffect(() => {
    const client = supabase
    if (!client) return
    let alive = true

    void client
      .from('events')
      .select('*')
      .eq('site', SITE)
      .order('ts', { ascending: false })
      .limit(5)
      .then(({ data }) => {
        // Rail only — hydrate never stages, so a reload cannot flash a stale green.
        if (alive && data) dispatch({ type: 'hydrate', events: data as EventRow[] })
      })

    const channel = client
      .channel('events')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'events', filter: `site=eq.${SITE}` },
        (payload) => {
          const row = payload.new as EventRow | undefined
          if (row?.id) dispatch({ type: 'event', event: row, now: Date.now() })
        },
      )
      .subscribe((status) => setChannelReady(status === 'SUBSCRIBED'))

    return () => { alive = false; void client.removeChannel(channel) }
  }, [dispatch])

  // ── camera liveness ─────────────────────────────────────────────────────
  // M0 has no capture node and no engine, so nothing writes devices.last_seen_at. A
  // staleness rule would therefore pin the OFFLINE banner on over every simulated
  // state. The poll is written and ready for M3; until heartbeats exist the camera
  // state comes from the ?dev=1 toggle, which is also how gate-offline.png is reached.
  useEffect(() => {
    const client = supabase
    if (!HEARTBEATS_ENABLED || !client) return
    let alive = true
    const poll = async () => {
      const { data } = await client
        .from('devices_public')
        .select('last_seen_at')
        .eq('id', CAMERA_DEVICE_ID)
        .maybeSingle()
      if (!alive) return
      const seen = data?.last_seen_at ? Date.parse(data.last_seen_at as string) : null
      setCameraSince(seen)
      setCameraOnline(seen !== null && Date.now() - seen <= 30_000)
    }
    void poll()
    const id = setInterval(() => void poll(), HEARTBEAT_POLL_MS)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // ── derived ─────────────────────────────────────────────────────────────
  const current = stageEvent(state)
  const dueAt = clearAt(state)
  const realtimeDown = Boolean(supabase) && !channelReady
  const showManual = realtimeDown || manualOpen
  const vehicle: VehiclePublic | null = useMemo(
    () => findVehicle(cache.rows, current?.plate_norm ?? null),
    [cache.rows, current?.plate_norm],
  )

  // A new vehicle arriving takes the screen back, unless the guard is mid-search.
  const searchingRef = useRef(false)
  useEffect(() => {
    if (current && manualOpen && !searchingRef.current) setManualOpen(false)
  }, [current, manualOpen])

  // ── wake lock: the gate screen must not sleep (§6.1) ────────────────────
  useEffect(() => {
    let sentinel: WakeLockSentinel | null = null
    const acquire = async () => {
      try {
        if (document.visibilityState === 'visible') sentinel = await navigator.wakeLock?.request('screen')
      } catch { /* unsupported or denied — not fatal */ }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => { document.removeEventListener('visibilitychange', acquire); void sentinel?.release() }
  }, [])

  // Browsers hold audio until a gesture; take the first one we get.
  useEffect(() => {
    const unlock = () => unlockAudio()
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  // ── guard actions ───────────────────────────────────────────────────────
  const recordAction = useCallback(async (request: GuardActionRequest, eventId: string | null) => {
    dispatch({ type: 'guard_action' })
    if (!supabase) return
    // guard_actions is the one table anon may write (0002_policies.sql) — the audit
    // trail must survive even when everything else is read-only.
    await supabase.from('guard_actions').insert({
      event_id: eventId, action: request.action, reason: request.reason, actor: request.actor,
    })
  }, [dispatch])

  const onAct = useCallback(
    (request: GuardActionRequest) => { void recordAction(request, current?.id ?? null) },
    [recordAction, current?.id],
  )

  const onConfirm = useCallback((plateNorm: string) => {
    // M1 sends this to the engine's POST /manual, which writes a source='manual' event.
    // Until that exists, record the confirmation and clear the stage — the guard has
    // decided, which is what the hold rule is waiting for.
    void recordAction(
      { action: 'confirmed', reason: `Confirmed as ${plateNorm}`, actor: storedActor() || null },
      current?.id ?? null,
    )
  }, [recordAction, current?.id])

  const onLocalEvent = useCallback(
    (event: EventRow) => dispatch({ type: 'event', event, now: Date.now() }),
    [dispatch],
  )

  return (
    <div className="display">
      <TopBar
        now={now}
        cameraOnline={cameraOnline}
        muted={muted}
        onToggleMute={() => { const next = !muted; setMuted(next); setMutedState(next); unlockAudio() }}
      />

      <div className="main">
        <OfflineBanner
          cameraOffline={!cameraOnline}
          realtimeDown={realtimeDown}
          cameraSince={cameraSince}
          cacheSyncedAt={cache.syncedAt}
          now={now}
        />

        {showManual ? (
          <div onFocusCapture={() => { searchingRef.current = true }}>
            <ManualMode
              rows={cache.rows}
              syncedAt={cache.syncedAt}
              syncError={cache.syncError}
              forced={realtimeDown}
              onClose={() => { searchingRef.current = false; setManualOpen(false) }}
            />
          </div>
        ) : (
          <Stage
            event={current}
            vehicle={vehicle}
            lastReadLocal={state.stageLastReadLocal}
            clearAt={dueAt}
            stageSince={state.stageSince}
            now={now}
            lastRead={state.rail[0] ?? null}
            cacheSyncedAt={cache.syncedAt}
            cacheCount={cache.count}
            cacheError={cache.syncError}
            onAct={onAct}
            onConfirm={onConfirm}
          />
        )}
      </div>

      <Rail events={state.rail} dimmed={showManual} onTypeAPlate={() => setManualOpen(true)} />

      {dev && (
        <SimulatePanel
          current={current}
          onLocalEvent={onLocalEvent}
          cameraOnline={cameraOnline}
          onToggleCamera={() => {
            setCameraOnline((v) => {
              if (v) setCameraSince(Date.now() - 31_000)
              return !v
            })
          }}
        />
      )}
    </div>
  )
}
