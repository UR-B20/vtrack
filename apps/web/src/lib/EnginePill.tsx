import { engineDetail, engineLabel, engineTone, type EngineHealth } from './engine'

/**
 * The engine status pill, shared by /display and /capture. It reports what the last /health
 * probe said — never merely that a URL is configured, which is what the M0 pill did.
 */
export function EnginePill({ health }: { health: EngineHealth }) {
  const tone = engineTone(health)
  return (
    <span className={`pill${tone ? ` pill--${tone}` : ''}`} title={engineDetail(health)}>
      <span className="pill__dot" />
      {engineLabel(health)}
    </span>
  )
}
