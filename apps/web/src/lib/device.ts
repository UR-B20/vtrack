/**
 * device.ts — which device this screen is, and its token.
 *
 * A token authorises writing decisions onto the guard's screen, so it is never compiled into
 * the app: anything VITE_* ends up in public JavaScript, and vite.config.ts refuses a
 * production build that would contain one. Each device is paired once, from its own screen,
 * and keeps its token in its own storage.
 *
 * Keys are per ROLE. /capture and /display share one origin on localhost:5173 during
 * development; a single key would let pairing one overwrite the other, and the engine would
 * then refuse every frame as coming from the wrong device.
 */

export type DeviceRole = 'capture' | 'display'

export interface Pairing {
  deviceId: string
  token: string
}

/** Matches the engine's own floor (auth.py MIN_TOKEN_LEN). */
export const MIN_TOKEN_LEN = 16

export const storageKey = (role: DeviceRole) => `vtrack:device:${role}`

/** Validate a stored or typed pairing. Pure. */
export function parsePairing(raw: string | null | undefined): Pairing | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<Pairing>
    const deviceId = typeof v.deviceId === 'string' ? v.deviceId.trim() : ''
    const token = typeof v.token === 'string' ? v.token.trim() : ''
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(deviceId)) return null
    if (token.length < MIN_TOKEN_LEN || token.includes('<')) return null
    return { deviceId, token }
  } catch {
    return null
  }
}

export function loadPairing(role: DeviceRole): Pairing | null {
  try {
    return parsePairing(localStorage.getItem(storageKey(role)))
  } catch {
    return null // storage blocked — the pairing screen explains
  }
}

export function savePairing(role: DeviceRole, pairing: Pairing): boolean {
  try {
    localStorage.setItem(storageKey(role), JSON.stringify(pairing))
    return true
  } catch {
    return false
  }
}

export function clearPairing(role: DeviceRole): void {
  try {
    localStorage.removeItem(storageKey(role))
  } catch {
    /* nothing to clear */
  }
}
