/**
 * updates.ts — a new version of the app is applied only when the screen is idle.
 *
 * The gate tablets run one page for days. With vite-plugin-pwa's `autoUpdate` a new build
 * could take over at any moment — mid-vehicle on /capture, over a red DENY on /display. So
 * the service worker waits (`registerType: 'prompt'`), and each screen says when it is idle:
 * the lane empty on /capture, standby on /display. The page then reloads into the new
 * version, which restores its pairing, lane ROI and background from storage.
 *
 * It also checks for a new version hourly, since a page that is never reloaded would
 * otherwise never look.
 */

import { useEffect, useState } from 'react'
import { registerSW } from 'virtual:pwa-register'

const HOURLY = 60 * 60 * 1000
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null
let waiting = false
let applying = false

/** True while the page reloads into a new version: the leave guard must not stop that. */
export const updateInProgress = () => applying
const listeners = new Set<() => void>()

export function startUpdates(): void {
  if (applyUpdate || !('serviceWorker' in navigator)) return
  applyUpdate = registerSW({
    onNeedRefresh() {
      waiting = true
      listeners.forEach((l) => l())
    },
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update().catch(() => undefined), HOURLY)
    },
  })
}

/** Apply a waiting update as soon as `idle` is true. */
export function useApplyUpdateWhenIdle(idle: boolean): void {
  const [pending, setPending] = useState(waiting)
  useEffect(() => {
    const on = () => setPending(true)
    listeners.add(on)
    return () => void listeners.delete(on)
  }, [])
  useEffect(() => {
    if (pending && idle && applyUpdate && !applying) {
      applying = true
      void applyUpdate(true)
    }
  }, [pending, idle])
}
