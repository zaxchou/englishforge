import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import progressDb from './vite-plugin-db.mjs'

// https://vite.dev/config/
export default defineConfig({
  // progressDb：dev 与 preview（start.bat）都在同一进程里提供 /api，进度落 SQLite（server/db.mjs）
  plugins: [react(), progressDb()],
})
