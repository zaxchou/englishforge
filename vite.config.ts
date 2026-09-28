import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import progressDb from './vite-plugin-db.mjs'

// https://vite.dev/config/
export default defineConfig({
  // progressDb：dev 与 preview（start.bat）都在同一进程里提供 /api，进度落 SQLite（server/db.mjs）
  plugins: [react(), progressDb()],
  server: {
    watch: {
      // 项目在 Z:（SMB 网络盘）上：fs.watch 在 SMB 上会抛 UNKNOWN，是未捕获错误、
      // 会直接打死整个 vite 进程（实测连续两次启动即崩）。改轮询绕开 fs.watch。
      usePolling: true,
      interval: 1000,
      ignored: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/out/**', '**/data/**'],
    },
  },
})
