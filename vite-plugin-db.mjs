// 把进度数据库挂进 Vite：`npm run dev` 和 `start.bat`（vite preview）都用同一个进程，
// 不需要另开服务，也不引任何依赖。
//
// 数据库打不开时（比如换了 Node 版本、node:sqlite 不可用）不装死：
// 仍返回 JSON 错误，前端会切到「离线模式」继续用浏览器存档，进度不丢。
//
// 注意：这里用动态 import，并且测试环境下直接不装 —— 否则 vitest 一加载 vite.config.ts
// 就会把生产数据库打开（测试绝不该碰真实用户数据）。
export default function progressDb() {
  async function install(server) {
    if (process.env.VITEST || process.env.NODE_ENV === 'test') return
    let api, db
    try {
      api = await import('./server/api.mjs')
      db = await import('./server/db.mjs')
      db.getDb()
    } catch (err) {
      console.error('[englishforge] 进度库打不开，前端将退回浏览器本地存档：', err?.message ?? err)
      server.middlewares.use((req, res, next) => {
        if (!(req.url ?? '').startsWith('/api/')) return next()
        res.statusCode = 503
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: '进度库不可用：' + String(err?.message ?? err) }))
      })
      return
    }
    server.middlewares.use(api.apiMiddleware())
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    console.log(`[englishforge] 进度库已就绪 ${db.DB_PATH}  (${t})`)
  }
  return {
    name: 'englishforge-progress-db',
    configureServer: install,
    configurePreviewServer: install,
  }
}
