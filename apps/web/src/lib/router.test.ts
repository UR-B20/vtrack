import { describe, expect, it } from 'vitest'
import { absoluteHref, hrefFor, routeFromPath } from './router'

describe('router', () => {
  it('finds the route in a path', () => {
    expect(routeFromPath('/admin')).toBe('admin')
    expect(routeFromPath('/capture/')).toBe('capture')
    expect(routeFromPath('/nowhere')).toBe('display')
  })

  it('builds the full address an emailed sign-in link returns to', () => {
    // BASE_URL is '/' under test; on Pages it is '/vtrack/', giving …/vtrack/admin.
    expect(hrefFor('admin')).toBe('/admin')
    expect(absoluteHref('admin', 'https://ur-b20.github.io')).toBe('https://ur-b20.github.io/admin')
    expect(absoluteHref('admin', 'http://localhost:5173')).toBe('http://localhost:5173/admin')
  })
})
