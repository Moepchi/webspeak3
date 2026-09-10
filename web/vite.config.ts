import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      // We register the service worker ourselves (see useSwUpdatePrompt in
      // App.tsx) via the virtual:pwa-register/react module so we can show a
      // "new version available" toast instead of updating silently — a
      // stale-cache tab would otherwise keep running old JS/CSS until the
      // user manually reloads (or worse, clears storage), which bit us
      // repeatedly while verifying deploys.
      injectRegister: false,
      // Dev-time Workbox would sit in front of Vite's own HMR/WS traffic and
      // stale-cache the app shell while iterating — only ever ship the SW in
      // production builds.
      devOptions: { enabled: false },
      includeAssets: ['favicon.ico', 'apple-touch-icon.png'],
      manifest: {
        name: 'WebSpeak3',
        short_name: 'WebSpeak3',
        description: 'An independent, self-hosted web client for TeamSpeak 3 servers.',
        theme_color: '#03060d',
        background_color: '#03060d',
        display: 'standalone',
        start_url: '.',
        icons: [
          { src: 'favicon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the built app shell (JS/CSS/HTML/icons) only. The gateway's
        // /ws endpoint and any file-transfer/API traffic must never be
        // intercepted or cached — Workbox's default fetch handler already
        // ignores non-GET and non-http(s) requests (ws:// isn't touched), so
        // no extra runtimeCaching exclusions are needed here.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
  // Set by the GitHub Pages workflow to the repo subpath (e.g. /webspeak3/);
  // the normal Docker build serves from the domain root and leaves this unset.
  base: process.env.VITE_BASE_PATH || '/',
})
