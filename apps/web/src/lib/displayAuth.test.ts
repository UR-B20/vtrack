import { describe, expect, it } from 'vitest'
import { displayAccess, signInProblem } from './displayAuth'

const as = (role?: unknown) => ({ user: { email: 'x@y.z', app_metadata: role === undefined ? {} : { role } } })

describe('displayAccess', () => {
  it('needs a session', () => {
    expect(displayAccess(null)).toBe('signed_out')
    expect(displayAccess({ user: null })).toBe('signed_out')
  })

  it('lets the display login and an admin in', () => {
    expect(displayAccess(as('display'))).toBe('ok')
    expect(displayAccess(as('admin'))).toBe('ok')
  })

  it('stops a login without either role — it would see an empty list, not a refusal', () => {
    expect(displayAccess(as())).toBe('no_role')
    expect(displayAccess(as('guard'))).toBe('no_role')
    expect(displayAccess(as(['display']))).toBe('no_role')
    expect(displayAccess({ user: { email: 'x@y.z', app_metadata: null } })).toBe('no_role')
  })
})

describe('signInProblem', () => {
  it('says what to do, not what failed', () => {
    expect(signInProblem({ message: 'Invalid login credentials', status: 400 })).toBe('Wrong email or password.')
    expect(signInProblem({ message: 'Email not confirmed' })).toMatch(/Auto Confirm User/)
    expect(signInProblem({ message: 'Failed to fetch', status: 0 })).toMatch(/internet/)
    expect(signInProblem({ message: 'Request rate limit reached', status: 429 })).toMatch(/Wait a minute/)
    expect(signInProblem({ message: 'Something odd' })).toBe('Something odd')
  })
})
