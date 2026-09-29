import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
// vitest/config 的 defineConfig = vite 的 + test 字段类型（无独立 vitest.config 时测试读这里）
import { defineConfig } from 'vitest/config'
import progressDb from './vite-plugin-db.mjs'

// HTTPS（可选）：局域网明文 http:// 下浏览器禁用麦克风与语音识别（localhost 例外），
// 跟读题在 NAS 地址上就录不了音。设了这两个环境变量（证书路径）就让 preview 走 TLS；
// 由部署侧提供自签证书（deploy/production/，不进仓库）。本地 dev 不受影响。
const tlsKey = process.env.ENGLISHFORGE_TLS_KEY
const tlsCert = process.env.ENGLISHFORGE_TLS_CERT
const https = tlsKey && tlsCert
  ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }
  : undefined

// https://vite.dev/config/
export default defineConfig({
  // progressDb：dev 与 preview（start.bat）都在同一进程里提供 /api，进度落 SQLite（server/db.mjs）
  plugins: [react(), progressDb()],
  preview: { https },
  test: {
    // releases/ 是发布包（内含 server/*.test.mjs 的**拷贝**），在包外环境跑必挂、还会
    // 污染统计（实测：打包后第一次发布脚本被它搅黄）；dist/node_modules 同理排除。
    exclude: ['**/node_modules/**', '**/releases/**', '**/dist/**', '**/.git/**', '**/.zcode/**'],
  },
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
