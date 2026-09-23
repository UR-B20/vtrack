import { useEffect, useRef, useState } from 'react'
import { LockIcon } from '../../lib/icons'
import { updateInProgress } from '../../lib/updates'

/** capture.png: SCREEN LOCKED · HOLD 2 s TO UNLOCK. */
const HOLD_MS = 2_000
/** Unattended at the gate: it locks itself again after this long untouched. */
const RELOCK_MS = 30_000

/**
 * The camera tablet is mounted at point A and nobody watches it. Locked, the page ignores
 * every touch except a 2 s hold on the lock bar, so a passer-by cannot switch it to TAP,
 * move the lane ROI or unpair it. The first touch also takes the page fullscreen and holds
 * the current orientation, which hides the browser's own controls; Android's screen pinning
 * (README) is what stops the page being left altogether. Leaving it still asks first.
 */
export function ScreenLock({ locked, onUnlock, onLock }: {
  locked: boolean
  onUnlock: () => void
  onLock: () => void
}) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [left, setLeft] = useState(RELOCK_MS)

  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setHolding(false)
  }

  const startHold = () => {
    goFullscreen()
    setHolding(true)
    timer.current = setTimeout(() => {
      timer.current = null
      setHolding(false)
      onUnlock()
    }, HOLD_MS)
  }

  // Unlocked: any touch restarts the countdown; none for 30 s locks again.
  useEffect(() => {
    if (locked) return
    let last = Date.now()
    const touch = () => { last = Date.now() }
    window.addEventListener('pointerdown', touch, true)
    window.addEventListener('keydown', touch, true)
    const id = setInterval(() => {
      const remaining = RELOCK_MS - (Date.now() - last)
      setLeft(remaining)
      if (remaining <= 0) onLock()
    }, 1_000)
    return () => {
      window.removeEventListener('pointerdown', touch, true)
      window.removeEventListener('keydown', touch, true)
      clearInterval(id)
    }
  }, [locked, onLock])

  useEffect(() => cancelHold, [])

  if (!locked) {
    return (
      <div className="lockbar lockbar--open">
        <span>UNLOCKED · LOCKS AGAIN IN {Math.max(0, Math.ceil(left / 1000))} s</span>
        <button type="button" className="btn btn--link lockbar__now" onClick={onLock}>LOCK NOW</button>
      </div>
    )
  }

  return (
    <>
      {/* Swallows every touch on the page underneath, and the first one goes fullscreen. */}
      <div className="lockshield" onPointerDown={goFullscreen} aria-hidden="true" />
      <button
        type="button"
        className={`lockbar${holding ? ' lockbar--holding' : ''}`}
        onPointerDown={(e) => { e.preventDefault(); startHold() }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        onContextMenu={(e) => e.preventDefault()}
        aria-label="Screen locked. Press and hold for 2 seconds to unlock."
      >
        <span className="lockbar__fill" style={{ transitionDuration: holding ? `${HOLD_MS}ms` : '0ms' }} />
        <LockIcon className="lockbar__icon" />
        <span>SCREEN LOCKED · HOLD 2 s TO UNLOCK</span>
      </button>
    </>
  )
}

/** Fullscreen, then keep whatever orientation the tablet is mounted in. Both need a touch. */
function goFullscreen(): void {
  const el = document.documentElement
  if (document.fullscreenElement || !el.requestFullscreen) return
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (t: string) => Promise<void> }
      return o?.lock?.(o.type.startsWith('portrait') ? 'portrait' : 'landscape')
    })
    .catch(() => undefined)
}

/** Closing or reloading the camera page asks first (§6.2: it can't be closed by accident). */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const onBefore = (e: BeforeUnloadEvent) => {
      // A new version reloading while the lane is empty (updates.ts) must not stop at a
      // dialog on a tablet nobody is watching.
      if (updateInProgress()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [active])
}
