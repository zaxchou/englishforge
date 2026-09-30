// /api/v1 新域路由（curriculum-v4 实施合同 15 §8）。
//
// 与旧 /api/accounts/:id/sync 完全并行：旧契约一个字都不动，新域新表新语义。
// 错误码沿用 handleApi 的 {status, json:{error}}；合同错误码写在 message 前缀里，
// 例如 'REQUEST_ID_REUSED_WITH_DIFFERENT_BODY: …'。
import { ApiError, getAccount } from './db.mjs'
import { ensureV3Schema, oldRecordMap } from './v3db.mjs'
import { mapIndex, rowToObjective } from './v3map.mjs'

export const V3_ROUTES = [
  ['GET', '/api/v1/health', () => {
    ensureV3Schema()
    return { ok: true, domain: 'curriculum-v4', stage: 'W0-W2', time: Date.now() }
  }],

  // W1：能力目标与来源账本（R01）。未核验的组/目标明示状态，绝不显示“已覆盖”
  ['GET', '/api/v1/map', (ctx) => {
    return mapIndex({
      group: ctx.query.get('group') || undefined,
      status: ctx.query.get('status') || undefined,
    })
  }],
  ['GET', '/api/v1/map/objectives/:objectiveId', (ctx) => {
    mapIndex() // 触发种子幂等落库
    const rows = ensureV3Schema().prepare('SELECT * FROM objective_versions WHERE objective_id = ? ORDER BY version DESC')
      .all(ctx.params.objectiveId)
    if (!rows.length) throw new ApiError(404, 'OBJECTIVE_NOT_FOUND: ' + ctx.params.objectiveId)
    return { objective: rowToObjective(rows[0]), allVersions: rows.map((r) => r.version) }
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
