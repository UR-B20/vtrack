/**
 * router.tsx — three routes, no dependency.
 *
 * /display, /capture, /admin. Paths are resolved relative to import.meta.env.BASE_URL so
 * the same build works on localhost and under GitHub Pages' /<repo>/ prefix; the deploy
 * workflow copies index.html to 404.html, which is what makes a deep link survive a
 * cold load on Pages.
 */

import { useCallback, useEffect, useState } from 'react'

export type Route = 'display' | 'capture' | 'admin'

const ROUTES: Route[] = ['display', 'capture', 'admin']
const DEFAULT_ROUTE: Route = 'display'

const base = import.meta.env.BASE_URL || '/'

/** Strip the deploy base prefix from a pathname. */
function stripBase(pathname: string): string {
  const b = base.endsWith('/') ? base : `${base}/`
  const p = pathname.startsWith(b) ? pathname.slice(b.length) : pathname.replace(/^\//, '')
  return p.replace(/\/+$/, '')
}

export function routeFromPath(pathname: string): Route {
  const segment = stripBase(pathname).split('/')[0] ?? ''
  return (ROUTES as string[]).includes(segment) ? (segment as Route) : DEFAULT_ROUTE
}

export function hrefFor(route: Route): string {
  return `${base.endsWith('/') ? base : `${base}/`}${route}`
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: Route) => {
    window.history.pushState({}, '', hrefFor(next) + window.location.search)
    setRoute(next)
  }, [])

  return [route, navigate]
}

/** ?dev=1 gates the Simulate panel — never rendered without it (§8, M0). */
export function isDevMode(): boolean {
  return new URLSearchParams(window.location.search).get('dev') === '1'
}
