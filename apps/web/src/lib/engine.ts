/**
 * engine.ts — the browser's client for the VTrack Engine (CLAUDE.md §5.5).
 *
 * Public HTTPS in production, localhost in M1. Never a LAN address (§1). The pure parts —
 * classifyHealth, engineLabel, errorDetail — carry the tests; the fetches are thin.
 */

import type { Decision, DenyReason } from './types'
import type { Pairing } from './device'

export interface RecogniseResult {
  event_id: string | null
  decision: Decision | null
  reason: DenyReason | null
  plate_norm: string | null
  plate_display?: string
  confidence?: number | null
  checksum_ok?: boolean | null
  repaired_from?: string | null
  flags?: { verify: boolean }
  bbox?: [number, number, number, number] | null
  latency_ms: number
  deduped: boolean
}

export interface Health {
  engine: 'local' | 'cloud'
  model: string | null
  model_status: 'loading' | 'ready' | 'error'
  model_error: string | null
  db: 'ok' | 'error'
  db_error: string | null
  devices: Record<string, string>
  uptime_s: number
  version: string
}

export class EngineError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

/** FastAPI answers `{detail: "…"}`, or `{detail: [{msg}]}` for a malformed request. */
export function errorDetail(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const msgs = detail.map((d) => (d as { msg?: string })?.msg).filter(Boolean)
    if (msgs.length) return msgs.join('; ')
  }
  return `the engine answered HTTP ${status}`
}

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted) throw new EngineError(0, `the engine did not answer within ${timeoutMs / 1000} s`)
    throw new EngineError(0, `cannot reach the engine at ${new URL(url).origin} — is it running?`)
  } finally {
    clearTimeout(timer)
  }
}

async function jsonOrNull(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`

export async function recognise(
  baseUrl: string, pairing: Pairing, frame: Blob, capturedAt: Date, timeoutMs = 8000,
): Promise<RecogniseResult> {
  const form = new FormData()
  form.append('image', frame, 'frame.jpg')
  form.append('device_id', pairing.deviceId)
  form.append('captured_at', capturedAt.toISOString())
  const res = await request(join(baseUrl, '/recognise'), {
    method: 'POST', headers: { 'X-Device-Token': pairing.token }, body: form,
  }, timeoutMs)
  const body = await jsonOrNull(res)
  if (!res.ok) throw new EngineError(res.status, errorDetail(body, res.status))
  return body as RecogniseResult
}

export async function sendHeartbeat(
  baseUrl: string, pairing: Pairing, role: string, version: string, timeoutMs = 5000,
): Promise<void> {
  const res = await request(join(baseUrl, '/heartbeat'), {
    method: 'POST',
    headers: { 'X-Device-Token': pairing.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: pairing.deviceId, role, version }),
  }, timeoutMs)
  if (!res.ok) throw new EngineError(res.status, errorDetail(await jsonOrNull(res), res.status))
}

export type HealthProbe = { httpStatus: number; body: Health | null } | { error: string }

export async function probeHealth(baseUrl: string, timeoutMs = 5000): Promise<HealthProbe> {
  try {
    const res = await request(join(baseUrl, '/health'), { method: 'GET' }, timeoutMs)
    return { httpStatus: res.status, body: (await jsonOrNull(res)) as Health | null }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export type EngineHealth =
  | { status: 'unset' }
  | { status: 'checking' }
  | { status: 'ok'; engine: 'local' | 'cloud' }
  | { status: 'not_ready'; engine: 'local' | 'cloud' | null; reason: string }
  | { status: 'unreachable'; reason: string }

/**
 * What a /health probe means for a status pill. Only a 200 with a body is OK: the engine
 * answers 503 whenever it could not decide AND store a frame, and says why in the body.
 */
export function classifyHealth(probe: HealthProbe): EngineHealth {
  if ('error' in probe) return { status: 'unreachable', reason: probe.error }
  const { httpStatus, body } = probe
  if (httpStatus === 200 && body) return { status: 'ok', engine: body.engine }
  if (!body) return { status: 'unreachable', reason: `the engine answered HTTP ${httpStatus}` }
  const reason =
    body.db_error ??
    body.model_error ??
    (body.model_status === 'loading' ? 'the plate model is still loading' : `HTTP ${httpStatus}`)
  return { status: 'not_ready', engine: body.engine ?? null, reason }
}

/** The words on the pill. Colour is only ever a second channel (§6.1). */
export function engineLabel(h: EngineHealth): string {
  switch (h.status) {
    case 'unset': return 'ENGINE · NOT SET'
    case 'checking': return 'ENGINE · CHECKING'
    case 'ok': return `ENGINE · ${h.engine.toUpperCase()} OK`
    case 'not_ready': return 'ENGINE · NOT READY'
    case 'unreachable': return 'ENGINE · UNREACHABLE'
  }
}

/** pill modifier: green dot only when OK, deny colour when it is broken, plain otherwise. */
export function engineTone(h: EngineHealth): '' | 'ok' | 'offline' {
  if (h.status === 'ok') return 'ok'
  if (h.status === 'not_ready' || h.status === 'unreachable') return 'offline'
  return ''
}
