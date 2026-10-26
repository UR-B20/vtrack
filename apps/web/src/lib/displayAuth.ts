/**
 * displayAuth.ts — who may open /display (CLAUDE.md §11, Display sign-in, 26 Oct 2026). Pure.
 *
 * Since 0004_display_sign_in.sql the public anon key reads nothing: phone B signs in once
 * with its own Supabase login, whose app_metadata.role is 'display' (supabase/display_role.sql).
 * An admin may open the display too. A login with neither role — anyone can create one
 * through the admin sign-in — sees no rows, so the screen says why instead of standing empty.
 */

/** The fields of a Supabase session this needs; Session satisfies it. */
export interface SessionLike {
  user?: { email?: string | null; app_metadata?: Record<string, unknown> | null } | null
}

export type DisplayAccess = 'signed_out' | 'no_role' | 'ok'

export const DISPLAY_ROLES: readonly string[] = ['display', 'admin']

export function displayAccess(session: SessionLike | null): DisplayAccess {
  if (!session?.user) return 'signed_out'
  const role = session.user.app_metadata?.role
  return typeof role === 'string' && DISPLAY_ROLES.includes(role) ? 'ok' : 'no_role'
}

/** A Supabase Auth error, in words the person at the gate can act on. */
export function signInProblem(error: { message?: string; status?: number; code?: string }): string {
  const m = error.message ?? ''
  if (/invalid login credentials/i.test(m) || error.code === 'invalid_credentials') {
    return 'Wrong email or password.'
  }
  if (/email not confirmed/i.test(m) || error.code === 'email_not_confirmed') {
    return 'This login is not confirmed yet. In Supabase → Authentication → Users, confirm it (or create it again with "Auto Confirm User" ticked).'
  }
  if (/failed to fetch|networkerror|load failed|fetch/i.test(m) || error.status === 0) {
    return 'Cannot reach Supabase — check this phone’s internet connection.'
  }
  if (error.status === 429 || /rate limit/i.test(m)) {
    return 'Too many attempts. Wait a minute and try again.'
  }
  return m || 'Sign-in failed.'
}
