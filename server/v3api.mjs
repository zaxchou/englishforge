// /api/v1 新域路由（curriculum-v4 实施合同 15 §8）。
//
// 与旧 /api/accounts/:id/sync 完全并行：旧契约一个字都不动，新域新表新语义。
// 错误码沿用 handleApi 的 {status, json:{error}}；合同错误码写在 message 前缀里，
// 例如 'REQUEST_ID_REUSED_WITH_DIFFERENT_BODY: …'。
import { ApiError, getAccount } from './db.mjs'
import { ensureV3Schema, oldRecordMap } from './v3db.mjs'

export const V3_ROUTES = [
  ['GET', '/api/v1/health', () => {
    ensureV3Schema()
    return { ok: true, domain: 'curriculum-v4', stage: 'W0-W2', time: Date.now() }
  }],

  // W0：旧数据只读映射 —— 迁移判定的透明化，不写任何新状态（15 §13）
  ['GET', '/api/v1/accounts/:id/legacy-map', (ctx) => {
    requireAccount(ctx.params.id)
    const map = oldRecordMap(ctx.params.id)
    if (!map) throw new ApiError(404, 'ACCOUNT_NOT_FOUND: ' + ctx.params.id)
    return map
  }],
]

export function requireAccount(id) {
  const a = getAccount(id)
  if (!a) throw new ApiError(404, 'ACCOUNT_NOT_FOUND: ' + id)
  return a
}
