/**
 * sounds.ts — the gate chimes (CLAUDE.md §6.1).
 *
 *   allow  two rising tones
 *   deny   one low tone, twice
 *   check  a single mid tone
 *
 * Web Audio, no files: nothing to download on mobile data, nothing to 404 on Pages.
 * On by default with a mute toggle in the top bar, persisted in localStorage — the
 * guard may not be looking at the screen, so sound is part of the redundant encoding
 * (colour + word + icon + sound), not decoration.
 */

import type { Decision } from './types'

const MUTE_KEY = 'vtrack:muted'

let ctx: AudioContext | null = null

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  ctx ??= new Ctor()
  return ctx
}

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0')
  } catch {
    /* storage blocked — the toggle still works for this session */
  }
}

/**
 * Browsers suspend an AudioContext until a user gesture. Call this from the first
 * click or key press so the very first chime of a shift is not the one that is missed.
 */
export function unlockAudio(): void {
  const ac = audioContext()
  if (ac && ac.state === 'suspended') void ac.resume()
}

export function audioNeedsUnlock(): boolean {
  return ctx !== null && ctx.state === 'suspended'
}

/** One tone. `at` is an offset in seconds from now. */
function tone(ac: AudioContext, freq: number, at: number, durationS: number, gain = 0.14): void {
  const osc = ac.createOscillator()
  const env = ac.createGain()
  const start = ac.currentTime + at

  osc.type = 'sine'
  osc.frequency.setValueAtTime(freq, start)

  // Short attack and release: a click-free chime that carries over a floodlit gate.
  env.gain.setValueAtTime(0.0001, start)
  env.gain.exponentialRampToValueAtTime(gain, start + 0.012)
  env.gain.exponentialRampToValueAtTime(0.0001, start + durationS)

  osc.connect(env).connect(ac.destination)
  osc.start(start)
  osc.stop(start + durationS + 0.02)
}

const CHIME: Record<Decision, (ac: AudioContext) => void> = {
  // Two rising tones — "go".
  allow: (ac) => { tone(ac, 660, 0, 0.12); tone(ac, 880, 0.13, 0.18) },
  // One low tone, twice — unmistakably not the allow.
  deny: (ac) => { tone(ac, 220, 0, 0.20, 0.18); tone(ac, 220, 0.26, 0.26, 0.18) },
  // A single mid tone — asking for attention, not announcing a verdict.
  check: (ac) => { tone(ac, 494, 0, 0.28, 0.13) },
}

export function playDecision(decision: Decision): void {
  if (isMuted()) return
  const ac = audioContext()
  if (!ac) return
  if (ac.state === 'suspended') {
    void ac.resume()
    return   // this one is lost; the unlock hint tells the guard to tap once
  }
  try {
    CHIME[decision](ac)
  } catch {
    /* audio must never take the display down */
  }
}
