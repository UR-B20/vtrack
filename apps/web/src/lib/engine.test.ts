import { describe, expect, it } from 'vitest'
import {
  classifyHealth, engineDetail, engineLabel, engineSite, engineTone, errorDetail, type Health,
} from './engine'

const health = (over: Partial<Health> = {}): Health => ({
  engine: 'local', model: 'yolo + cct', model_status: 'ready', db: 'ok', reason: null,
  uptime_s: 5, version: 'm2+e47732b', ...over,
})
const CLOUD = 'https://vtrack-engine.onrender.com'

describe('classifyHealth', () => {
  it('is OK only on a 200 with a body', () => {
    expect(classifyHealth({ httpStatus: 200, body: health() }, CLOUD)).toEqual(
      { status: 'ok', site: 'cloud', reader: 'local', version: 'm2+e47732b' })
  })

  it('explains a public reason code in words', () => {
    // The public /health carries no error text (brief §3.10), only a code.
    const h = classifyHealth({ httpStatus: 503, body: health({ db: 'error', reason: 'db_auth' }) }, CLOUD)
    expect(h).toEqual({ status: 'not_ready', engine: 'local', reason: 'Supabase refused the engine\'s key' })
  })

  it('names the database problem first', () => {
    const h = classifyHealth({ httpStatus: 503, body: health({ db: 'error', db_error: 'SUPABASE_SERVICE_KEY is not set' }) })
    expect(h).toEqual({ status: 'not_ready', engine: 'local', reason: 'SUPABASE_SERVICE_KEY is not set' })
  })

  it('reports a model still loading', () => {
    const h = classifyHealth({ httpStatus: 503, body: health({ model_status: 'loading', model: null }) })
    expect(h).toMatchObject({ status: 'not_ready', reason: 'the plate model is still loading' })
  })

  it('treats a network failure as unreachable, with the reason', () => {
    expect(classifyHealth({ error: 'cannot reach the engine' })).toEqual({ status: 'unreachable', reason: 'cannot reach the engine' })
  })

  it('treats a bodiless error as unreachable', () => {
    expect(classifyHealth({ httpStatus: 502, body: null }).status).toBe('unreachable')
  })
})

describe('engineLabel / engineTone', () => {
  it('never claims OK without a healthy probe — the M0 pill said CLOUD OK whenever a URL was set', () => {
    expect(engineLabel({ status: 'unset' })).toBe('ENGINE · NOT SET')
    expect(engineLabel({ status: 'checking' })).toBe('ENGINE · CHECKING')
    expect(engineLabel({ status: 'unreachable', reason: 'x' })).toBe('ENGINE · UNREACHABLE')
    expect(engineLabel({ status: 'not_ready', engine: 'local', reason: 'x' })).toBe('ENGINE · NOT READY')
    expect(engineLabel({ status: 'ok', site: 'local', reader: 'local', version: null })).toBe('ENGINE · LOCAL OK')
    expect(engineLabel({ status: 'ok', site: 'cloud', reader: 'local', version: null })).toBe('ENGINE · CLOUD OK')
  })

  it('names where the engine runs, not which reader it uses', () => {
    expect(engineSite('http://localhost:8000')).toBe('local')
    expect(engineSite('http://127.0.0.1:8000')).toBe('local')
    expect(engineSite(CLOUD)).toBe('cloud')
    const h = classifyHealth({ httpStatus: 200, body: health() }, CLOUD)
    expect(engineLabel(h)).toBe('ENGINE · CLOUD OK')
    expect(engineDetail(h)).toBe('open-source plate model · m2+e47732b')
  })

  it('shows green only when OK', () => {
    expect(engineTone({ status: 'ok', site: 'cloud', reader: 'local', version: null })).toBe('ok')
    expect(engineTone({ status: 'unreachable', reason: 'x' })).toBe('offline')
    expect(engineTone({ status: 'unset' })).toBe('')
  })
})

describe('errorDetail', () => {
  it('reads the engine\'s own message', () => {
    expect(errorDetail({ detail: 'frame is 12.3 s old' }, 422)).toBe('frame is 12.3 s old')
  })
  it('joins a validation error list', () => {
    expect(errorDetail({ detail: [{ msg: 'Field required' }, { msg: 'bad' }] }, 422)).toBe('Field required; bad')
  })
  it('falls back to the status', () => {
    expect(errorDetail(null, 500)).toBe('the engine answered HTTP 500')
  })
})
