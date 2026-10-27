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

/** The full address of a route on this site — what an emailed sign-in link must point at.
 *  On Pages that is https://ur-b20.github.io/vtrack/admin, not the bare origin, which has
 *  no site at all ("Site not found"). */
export function absoluteHref(route: Route, origin: string): string {
  return new URL(hrefFor(route), origin).href
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

/**
 * Whether the ?dev=1 panels exist in this build at all: always in `pnpm dev`; in a production
 * build only when VITE_DEV_PANELS=1 was set at build time (deploy.yml). The Simulate panel can
 * put a green PROCEED on the guard's screen from the screen itself, and the capture panel can
 * save every frame to Downloads, so a build for the gate can switch them off for good: with
 * this false, ?dev=1 does nothing. (The code is still in the bundle; it is never rendered.)
 */
export const DEV_PANELS_BUILT: boolean =
  Boolean(import.meta.env.DEV) || import.meta.env.VITE_DEV_PANELS === '1'

/** ?dev=1 gates the Simulate / SETUP panels — never rendered without it (§8, M0), and never
 *  at all in a build without them (DEV_PANELS_BUILT). */
export function isDevMode(): boolean {
  return DEV_PANELS_BUILT && new URLSearchParams(window.location.search).get('dev') === '1'
}
