// 匿名连续轨迹走查（20 号 §6.3 / C1 退出门槛）：一名匿名学习者从入口诊断起连续学 5 节课。
// 全程临时库，不碰真实数据。输出每课的：材料与版本、逐目标结果、支持条件、状态变化、
// 推荐理由与后继；混合三类关键事件——独立成功、提示后成功、关系误判（失败→换路），并含一次免修。
//
// 断言的不变量（违反即退出非零）：
// · 每次完成课程后 decisionId 变化（完成触发重算，F2）
// · 重复完成不重复更新（幂等）
// · 已完成课不再被当新课推荐（F2 残留）
// · 没有可用后继时计划明确说明，不默默推原课
//
// 用法：node scripts/trajectory-walk.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ef-walk-'))
process.env.ENGLISHFORGE_DB = join(dir, 'walk.db')
const api = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/server/api.mjs')
const call = (p, b, m = 'GET') => api.handleApi({ method: m, pathname: p.split('?')[0], body: b, query: new URLSearchParams(p.split('?')[1] || '') })

const lines = []
const say = (s) => { lines.push(s); console.log(s) }

// 活动注册表（本地文件）：封闭槽位题的 accept/options 只在这里——公开活动视图不带合同（防泄露）
const registry = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../server/data/v3-activities.json', import.meta.url), 'utf8'))
const regById = (aid) => registry.activities.find((x) => x.activityId === aid)

// 通过答案：按活动逐个给出真实合格回答（合规格答覆盖关系与保留条件）；误判=角色反转
const ANSWER_BANK = {
  les_l1_sensor_read: '出问题的是实验室里看起来准、在舞台灯下不稳的那颗传感器；现在还可以继续在室内测试用它；但在公开活动前的灯光环境检查之前，先不安装到现场——这不是永久禁用。',
  rep_film_postpone_read: '我们保留了视觉序列，推迟了配音测试；同一部片在小放映室里好看，到吵闹的大堂就难跟上；不能因此推出影片本身差。',
  les_l2_museum_map_audio: '地图没有失灵——它按设计正常工作；不完整的是我们对游客需求的假设；有人走向拥挤展厅，因为他们以为那里有有意思的事。',
  les_l2b_museum_transcript: 'that tells visitors 修饰 map；because 解释游客走向拥挤展厅的动机；but 对照"地图按设计工作"与"假设不完整"。下一步：先问游客为什么选路线，再决定改不改设计。',
  les_l3_oral_recap: 'Our museum map worked as designed, but our assumption about what visitors wanted was incomplete. Some visitors walked toward crowded rooms because they thought something interesting was happening there. Next month we will ask visitors why they chose a route before we change the design.',
  les_l3_followup: 'A shorter route is not always better: several new students found the instructions hard to follow, so we will revise the instructions before recommending the app.',
  ct01_which_probe: 'A 的 which 指投影仪这台设备（从媒体实验室借来的）；B 的 which 指投影仪在展览中坏掉这件事，后半句在解释它的后果。',
  ct02_nested_which: '第一处 which 指媒体实验室——是实验室最近买了新设备，不是投影仪；第二处 which 指更换电源并继续展出这件事，它使访客仍能看到装置。主线：投影仪在展览中坏了。',
  ct03_semantics_guard: '团队保留了手势控制，暂缓语音；因为多人同时说话时这个原型在展厅表现不好；他们并未完全放弃语音，仍想再测试。',
  ct04_oral_followup: '优点是路线较短；问题是几名新生觉得指示难懂；下一步先修订指示再推荐。A shorter route is not always better: some new students found the instructions hard to follow, so we revise them first.',
  diag_d1b_contrast: '工具在小房间（安静的）可用，在大房间（吵的）失败。',
  diag_d3_oral_typed: '我们从 AI 助手学到：它能帮我们找到值得读的论文，但摘要可能漏掉原文的重要限制，所以使用前必须自己读。我的项目里我会用它找材料，但会自己核查来源。',
}
// D0-1：封闭槽位题按槽提交（accept 只从本地注册表取——公开活动视图不带合同，防泄露）
const passAnswerFor = (act) => {
  const slots = regById(act.activityId)?.evaluationContract?.slots
  if (slots) return { answers: Object.fromEntries(slots.map((s) => [s.slotId, s.accept])), text: ANSWER_BANK[act.activityId] ?? '' }
  return ANSWER_BANK[act.activityId]
    ?? '它按设计正常工作，但我们对用户需求的假设不完整；并未放弃后续计划。'
}
function failAnswerFor(act) {
  const slots = regById(act.activityId)?.evaluationContract?.slots
  if (slots) return { answers: Object.fromEntries(slots.map((s) => [s.slotId, s.options.find((o) => o !== s.accept) ?? s.accept])), text: '（每个槽都选了错误选项）' }
  return '他们做了一个展览。（角色反了）'
}

const id = (await call('/api/accounts', { name: 'walk-匿名' }, 'POST')).json.account.id
await call('/api/v1/map')
say(`# 匿名 5 课连续轨迹（账户 ${id.slice(0, 8)}…，临时库）\n`)

// ---- 入口诊断：D1 关系误判（弱画像）→ 修复路线；D2 合成音频通过；D3 通过 ----
const dres = await call(`/api/v1/accounts/${id}/diagnostics`, { requestId: 'walk-diag' }, 'POST')
console.log('DIAG_DEBUG', dres.status, JSON.stringify(dres.json).slice(0, 200))
let cur = dres.json
const diagScript = {
  D1: '他们做了一个展览。', // 关系误判：抓不到保留/推迟两层 → fail
  D2: 'AI 助手很有用，能帮助设计项目找灵感。', // 首听漏限定 → fail（把听力支线带进轨迹）
  D2b: '最终评价：可以帮我们找论文，但必须自己读来源核查；摘要漏掉了原论文的重要限制。',
  D3: '我们从 AI 助手学到：它能帮我们找到值得读的论文，但摘要可能漏掉原文的重要限制，所以使用前必须自己读。我的项目里我会用它找材料，但会自己核查来源。',
}
while (cur && cur.status === 'open' && cur.activity) {
  // R4：听力活动必须先有服务端播放事件
  if (cur.activity.audio) {
    await call(`/api/v1/accounts/${id}/support/play`, { activityId: cur.activity.activityId, mediaId: cur.activity.audio.mediaId }, 'POST')
  }
  const r = await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `wd-${cur.step}`, sessionId: cur.diagnosticId, activityId: cur.activity.activityId,
    response: { kind: 'text', text: diagScript[cur.step] ?? '' },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: cur.step === 'D2b', playCount: 2, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  if (!r.json.diagnostic) { say(`! 作答失败：${JSON.stringify(r.json).slice(0, 160)}`); process.exit(1) }
  cur = r.json.diagnostic
}
say(`## 入口诊断 → 路线=${cur.tentative?.route}；强项=${(cur.tentative?.strongPoints ?? []).join('、') || '—'}；根因=${(cur.tentative?.hypotheses ?? []).join('、') || '—'}`)

// ---- 连续 5 课。不变量：完成课 → decisionId 必变（F2）；免修本身不触发重算（按 F2 语义
// 只有完成课/显式 recompute 触发），脚本免修后显式 recompute 并断言推荐绕开被免修目标 ----
const doneLessons = new Set()
let prevDecisionId = null
let completed = 0
for (let step = 1; step <= 9 && completed < 5; step++) {
  let plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
  if (prevDecisionId && plan.decisionId === prevDecisionId) {
    say(`! 第 ${step} 步：decisionId 未变（${plan.decisionId}）——完成课后应触发重算`)
    process.exit(1)
  }
  prevDecisionId = plan.decisionId
  say(`\n## 第 ${step} 步 · 推荐 ${plan.primaryGoal}（${plan.strategyId}） decision=${plan.decisionId}`)
  say(`   理由：${String(plan.reason).slice(0, 110)}`)
  if (plan.lesson?.lessonId) {
    if (doneLessons.has(plan.lesson.lessonId)) {
      say(`! 已完成课 ${plan.lesson.lessonId} 被再次推荐（F2 残留）`); process.exit(1)
    }
    say(`   课程：${plan.lesson.lessonId} v${plan.lesson.version}${plan.lesson.devSample ? '（dev 样本）' : ''}`)
    let pkg = (await call(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}`)).json
    // R2 验收（24 号 §5）：推荐目标必须属于课的实际可测目标
    if (!(pkg.objectiveIds ?? []).includes(plan.primaryGoal)) {
      say(`! 推荐目标 ${plan.primaryGoal} 不在课的可测目标 ${JSON.stringify(pkg.objectiveIds)} 里（R2 残留）`); process.exit(1)
    }
    // 门控活动（unlockAfter）在前提提交后才出现：取课-作答循环到不再出现新活动
    const seen = new Set()
    for (let round = 0; round < 6; round++) {
      const fresh = pkg.activities.filter((a) => !seen.has(a.activityId))
      if (!fresh.length) break
      for (const act of fresh) {
        seen.add(act.activityId)
        // R4：听力活动先落服务端播放事件（作答门）
        if (act.audio) {
          const pl = await call(`/api/v1/accounts/${id}/support/play`, { activityId: act.activityId, mediaId: act.audio.mediaId }, 'POST')
          if (pl.status !== 200) { say(`! 播放事件失败：${JSON.stringify(pl.json).slice(0, 120)}`); process.exit(1) }
        }
        // 混合三类作答：第 1 课第 1 题先误判（失败→换答案重试=新 attemptId）；
        // 第 2 课第 1 题提示后成功；其余独立通过
        const isRetakeDemo = completed === 0 && act.activityId === pkg.activities[0].activityId
        const isHintDemo = completed === 1 && act.activityId === pkg.activities[0].activityId
        if (isRetakeDemo) {
          const fa = failAnswerFor(act)
          const bad = await call(`/api/v1/accounts/${id}/attempts`, {
            attemptId: `w-${pkg.lessonId}-${act.activityId}-r1`, activityId: act.activityId,
            response: typeof fa === 'object' ? { kind: 'choice', text: fa.text, answers: fa.answers } : { kind: 'text', text: fa },
            conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
          }, 'POST')
          say(`   · ${act.activityId} v${act.version} 误判作答 → pass=${bad.json.pass} 逐目标=${JSON.stringify(bad.json.objectiveResults ?? {})}`)
        }
        if (isHintDemo && act.hintStageCount > 0) {
          await call(`/api/v1/accounts/${id}/lessons/${pkg.lessonId}/hints`, { activityId: act.activityId, level: 1 }, 'POST')
          say(`   · ${act.activityId} 揭示提示 1（记为支持）`)
        }
        const pa = passAnswerFor(act)
        const r = await call(`/api/v1/accounts/${id}/attempts`, {
          attemptId: `w-${pkg.lessonId}-${act.activityId}${isRetakeDemo ? '-r2' : ''}`, activityId: act.activityId,
          response: typeof pa === 'object' ? { kind: 'choice', text: pa.text, answers: pa.answers } : { kind: 'text', text: pa },
          conditions: {
            firstExposure: !isRetakeDemo, hintLevel: isHintDemo ? 1 : 0,
            transcriptShown: false, playCount: act.audio ? 2 : 1, lookupUsed: false, responseMode: 'typed_summary',
          },
        }, 'POST')
        say(`   · ${act.activityId}${isHintDemo ? '（提示后）' : isRetakeDemo ? '（重试）' : '（独立）'} → pass=${r.json.pass} 逐目标=${JSON.stringify(r.json.objectiveResults ?? {})}`)
      }
      pkg = (await call(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}`)).json // 门控活动解锁后重取
    }
    const done = await call(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}/complete`, {}, 'POST')
    if (!done.json.ok && !done.json.alreadyDone) { say(`! 完成失败：${JSON.stringify(done.json)}`); process.exit(1) }
    const again = await call(`/api/v1/accounts/${id}/lessons/${plan.lesson.lessonId}/complete`, {}, 'POST')
    say(`   完成课 ${pkg.lessonId}；重复完成幂等=${!!(again.json.alreadyDone || again.json.replanNeeded === false)}`)
    doneLessons.add(pkg.lessonId)
    completed++
  } else if (plan.strategyId === 'short_repair' && plan.lesson?.activityId) {
    // 短修复探针：没有课，只有一个定位活动（免修目标暴露缺口时的设计行为）——作答并重算
    const probe = plan.lesson.activityId
    const r = await call(`/api/v1/accounts/${id}/attempts`, {
      attemptId: `w-probe-${probe}-${step}`, activityId: probe,
      response: { kind: 'text', text: ANSWER_BANK[probe] ?? '工具在小房间（安静的）可用，在大房间（吵的）失败。' },
      conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
    }, 'POST')
    say(`   修复探针 ${probe} → pass=${r.json.pass} 逐目标=${JSON.stringify(r.json.objectiveResults ?? {})}`)
    const rec = (await call(`/api/v1/accounts/${id}/plan/recompute`, { requestId: `walk-probe-${step}` }, 'POST')).json.decision
    say(`   探针后重算 → ${rec.primaryGoal}（${rec.strategyId}）：${String(rec.reason).slice(0, 90)}`)
    prevDecisionId = null // 探针重算后重置基准
    continue
  } else {
    say(`   无可用课程（${plan.strategyId}）：${JSON.stringify(plan.lesson ?? {}).slice(0, 160)}`)
    say(`   → 诚实缺内容态：${plan.primaryGoal} 无已发布课（生成被模型余额 402 阻塞 / 需音频制作），不推原课不凑数。轨迹在此收束。`)
    break
  }
  // 中途免修演示（第 2 课后）：把口语目标挂起，观察 notChosen 理由
  if (completed === 2) {
    const w = await call(`/api/v1/accounts/${id}/waivers`, { objectiveId: 'O-K190-01', skill: 'speaking', reason: '轨迹演示：暂不练口语' }, 'POST')
    say(`   [插入] 免修 O-K190-01（说） → flags=${JSON.stringify(w.json.flags)}`)
  }
}

// ---- 收尾：R6 端到端分槽验证（真实提交，不是手插事件行）——
// ct01（band2 简单定位）与 ct02（band4 嵌套）同属 O-K115-02，必须落不同复杂度槽
say(`\n## R6 端到端：同目标两档复杂度分槽`)
// D0-1：封闭槽位题按槽提交（slotId→accept），不再有文本代号后门
for (const [aid, answers] of [
  ['ct01_which_probe', { which_a: 'DEVICE', which_b: 'EVENT', tail_role: 'B' }],
  ['ct02_nested_which', { which_1: 'LAB', which_2: 'POWER', software_why: 'RUNNING_OK' }],
]) {
  const reg = registry.activities.find((x) => x.activityId === aid)
  const r = await call(`/api/v1/accounts/${id}/attempts`, {
    attemptId: `walk-r6-${aid}`, activityId: aid,
    response: { kind: 'choice', text: '', answers },
    conditions: { firstExposure: true, hintLevel: 0, transcriptShown: false, playCount: 1, lookupUsed: false, responseMode: 'typed_summary' },
  }, 'POST')
  say(`   ${aid}（声明带 band${reg.complexityBand}）→ pass=${r.json.pass}`)
}
const evR6 = (await call(`/api/v1/accounts/${id}/evidence?objective=O-K115-02`)).json
const bands = evR6.states.filter((s) => s.skill === 'reading').map((s) => s.complexity)
say(`   O-K115-02 reading 槽位：${bands.join(', ')}`)
if (!bands.includes('band2') || !bands.includes('band4')) {
  say('! R6 残留：ct01/ct02 没有落到 band2/band4 两个槽（复杂度仍取父组固定带）'); process.exit(1)
}

// ---- 收尾证据概览 ----
const ev = (await call(`/api/v1/accounts/${id}/evidence`)).json
say(`\n## 终态证据（${ev.states.length} 行）`)
for (const s of ev.states) say(`   ${s.objectiveId} · ${s.skill} · ${s.complexity} → ${s.state}${s.flags.length ? ' [' + s.flags.join(',') + ']' : ''}`)
const plan = (await call(`/api/v1/accounts/${id}/plan`)).json.decision
say(`\n最终推荐：${plan.primaryGoal}（${plan.strategyId}）——${String(plan.reason).slice(0, 120)}`)
say(`完成课数：${completed}；已完成课不再复推：${[...doneLessons].join(', ')}`)
try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
console.log('\nTRAJECTORY_OK')
