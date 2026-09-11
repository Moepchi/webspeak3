import { execSync } from 'node:child_process'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Identifies the build a bundle came from. Only has to differ between two
// builds — the client compares its own baked-in value against version.json to
// notice when it is running something the server no longer serves.
function resolveBuildId(): string {
  const fromCi = process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA
  if (fromCi) return fromCi.slice(0, 12)
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    // No git checkout (the Docker build copies sources in without .git).
    return String(Date.now())
  }
}

const buildId = resolveBuildId()

// version.json must never be precached, or a stuck client would ask the very
// cache it is stuck in what the server has. `.json` is not in globPatterns
// below, so Workbox leaves it alone and the fetch always hits the network.
function versionManifest(): Plugin {
  return {
    name: 'webspeak3-version-manifest',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ buildId })}\n`,
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
  plugins: [
    react(),
    versionManifest(),
    VitePWA({
      // The generated worker takes over as soon as it has installed
      // (skipWaiting + clientsClaim). It must NOT wait for the page to ask it
      // to: between 2026-09-07 and 2026-09-10 this was `prompt`, and every
      // client cached in that window froze — the new worker sat in `waiting`
      // forever because the only code that could have released it (the update
      // toast) lived in the version behind that worker. Deciding *when* to
      // reload is a UI concern and stays one: `onNeedReload` in App.tsx shows
      // the toast instead of pulling the page out from under an active
      // connection.
      registerType: 'autoUpdate',
      // We register from inside the app (virtual:pwa-register/react) rather
      // than through an injected registerSW.js, because that script would
      // reload the page on its own the moment a new worker activates.
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
        // Both are what `registerType: 'autoUpdate'` is supposed to imply, but
        // the plugin only sets them when it also injects registerSW.js (see
        // resolveOptions: `injectRegister === 'auto' || injectRegister == null`)
        // — with injectRegister: false they have to be spelled out, or the
        // generated worker is byte-identical to the `prompt` one and strands
        // clients all over again. Verified in dist/sw.js after building.
        skipWaiting: true,
        clientsClaim: true,
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
