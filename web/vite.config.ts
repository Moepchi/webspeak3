import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Set by the GitHub Pages workflow to the repo subpath (e.g. /webspeak3/);
  // the normal Docker build serves from the domain root and leaves this unset.
  base: process.env.VITE_BASE_PATH || '/',
})
