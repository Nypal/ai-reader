import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,  // Listen on 0.0.0.0 so the app is accessible from other devices on the LAN
  },
})
