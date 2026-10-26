import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * Content-Security-Policy for a production build, as a <meta> tag: GitHub Pages cannot set
 * headers. It is the second line of defence against an injected script reaching the
 * camera token or a signed-in session: only this origin's own scripts run, and the page may
 * talk only to its Supabase project (REST, Auth, Realtime) and the engine. Not applied in
 * `pnpm dev`, which needs HMR's inline script and websocket.
 */
export function cspContent(env: Record<string, string | undefined>): string {
  const connect = ["'self'"]
  for (const raw of [env.VITE_SUPABASE_URL, env.VITE_ENGINE_URL]) {
    if (!raw) continue
    try {
      const u = new URL(raw)
      connect.push(u.origin)
      if (u.protocol === 'https:') connect.push(`wss://${u.host}`)
      if (u.protocol === 'http:') connect.push(`ws://${u.host}`)
    } catch {
      /* not a URL: leave it out; the engine pill will say it is unreachable */
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",   // React inline style attributes
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
}

function csp(env: Record<string, string | undefined>): PluginOption {
  return {
    name: 'vtrack-csp',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: cspContent(env) },
        injectTo: 'head-prepend',
      }]
    },
  }
}

// GitHub Pages serves the app under /<repo>/. The deploy workflow sets PAGES_BASE;
// locally and in `vite preview` it stays '/' so the dev server behaves normally.
const base = process.env.PAGES_BASE ?? '/'

export default defineConfig(({ command, mode }) => {
  // A device token authorises writing decisions to the guard's screen, and anything VITE_*
  // is compiled into the JavaScript bundle — which on Pages is public. Refuse to build one
  // in. Relying on dead-code elimination to drop it is not enough: Vite inlines the string
  // before the minifier decides what is dead. Tokens are paired per device instead and kept
  // in that device's localStorage (src/lib/device.ts); VITE_DEVICE_TOKEN is a dev-server
  // convenience only. CI proves this guard exists (.github/workflows/ci.yml).
  const env = loadEnv(mode, dirname(fileURLToPath(import.meta.url)), 'VITE_')
  if (command === 'build' && mode === 'production' && env.VITE_DEVICE_TOKEN) {
    throw new Error(
      'VITE_DEVICE_TOKEN is set — refusing a production build, because it would ship the ' +
        'token in public JavaScript. Remove it from apps/web/.env and pair the device from ' +
        'its screen instead.',
    )
  }

  return {
    base,
    plugins: [
      react(),
      csp(env),
      VitePWA({
        // A new version waits until the screen is idle (src/lib/updates.ts): never mid-vehicle.
        registerType: 'prompt',
        injectRegister: false,
        // The display and capture nodes are installed to a tablet home screen (§6.1, §6.2).
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'VTrack',
          short_name: 'VTrack',
          description: 'Gate vehicle recognition — approved-list display and admin',
          theme_color: '#0A1A2F',
          background_color: '#0A1A2F',
          display: 'fullscreen',
          // No orientation here: /display is landscape and /capture portrait, one app. Each
          // route locks its own once it is fullscreen.
          start_url: base,
          scope: base,
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          // Supabase REST/Realtime must never be served from a cache — a stale
          // vehicle list has to come from IndexedDB via cache.ts, which knows how
          // old it is and says so on screen. See §6.1 MANUAL MODE.
          navigateFallbackDenylist: [/^\/api/],
        },
        devOptions: { enabled: false },
      }),
    ],
    server: { port: 5173 },
  }
})
