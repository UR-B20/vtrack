import { useEffect, useState } from 'react'
import { classifyHealth, probeHealth, type EngineHealth } from './engine'

/** Polls the engine's /health (§6.1: every 10 s). `null` URL → the engine is not set. */
export function useEngineHealth(url: string | null, everyMs = 10_000): EngineHealth {
  const [state, setState] = useState<EngineHealth>(url ? { status: 'checking' } : { status: 'unset' })

  useEffect(() => {
    if (!url) {
      setState({ status: 'unset' })
      return
    }
    let alive = true
    const poll = async () => {
      const probe = await probeHealth(url)
      if (alive) setState(classifyHealth(probe))
    }
    void poll()
    const id = setInterval(() => void poll(), everyMs)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [url, everyMs])

  return state
}
