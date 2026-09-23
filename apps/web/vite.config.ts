import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves the app under /<repo>/. The deploy workflow sets PAGES_BASE;
// locally and in `vite preview` it stays '/' so the dev server behaves normally.
const base = process.env.PAGES_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // The display and capture nodes are installed to a tablet home screen (§6.1, §6.2).
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'VTrack',
        short_name: 'VTrack',
        description: 'Gate vehicle recognition — approved-list display and admin',
        theme_color: '#0A1A2F',
        background_color: '#0A1A2F',
        display: 'fullscreen',
        orientation: 'landscape',
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
})
