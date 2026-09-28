# ⚒️ EnglishForge

跟着张俊杰老师的「英语发明者思维」做大量训练的**本地优先 Web 应用**。
核心原理只有一句：**一个含义对应一个形式**——每个思维点练到不假思索。

> 训练闭环：今日队列（到期复习 + 当前知识点 + 情境任务）→ 逐题作答事件 → 题级间隔复习（1/2/4/7/15 天）→ 四维能力证据（形式识别 / 含义理解 / 有提示表达 / 延迟保持）。

## 快速开始

```bash
npm install     # 首次
npm run dev     # 开发模式 → http://localhost:5173
```

或使用生产构建（更快）：

```bash
npm run build
npm run preview  # → http://localhost:4173
```

Windows 一键启动：双击 `start.bat`（npm install 判断 + preview + 自动开浏览器）。

## 功能现状

- **题库 376 题 / 7 种题型**：含义选择 / 点词挑错 / 词块拼句 / 配对 / 分类 / 听力辨义 / **开口跟读**（录音识别，宽松判定）
- **破惯性纠错题**（💥 张老师体系的灵魂题型）
- **今日队列**：10 个短任务（最多 7 个到期 + 至少 3 个变化任务），生成后冻结、刷新可续
- **题级复习调度**：首次独立正确 → 次日复习；未到期刷题不升级；首错保留原错、变式补练；连续三次首错自动降难
- **能力证据**：未练习 / 建立中 / 初步稳定 / 持续巩固四状态，全部从作答事件推导，不用总分糊弄
- **存档**：v2 版本化（`sf-progress-v2`），v1 自动迁移且保留原件；逐题落盘、断点恢复、幂等计分；支持存档导出/导入（导入前自动备份）
- **账户 + 进度数据库**：进度同时写入 SQLite 数据库（`data/englishforge/englishforge.db`，默认在仓库外）。数据库不可用时自动退回纯本地模式，练习不受影响；覆盖/清空/导入前自动留快照，可回捞。查询：`python scripts/db.py`（详见 [docs/数据库与账户.md](docs/数据库与账户.md)）
- **系统自带 AI 修内容**：服务端内置模型通道（密钥运行时从仓库外读，永不入库）；审核页「系统自检」可让系统自己查重、找"打架"的题、给缺逐项纠正的题补上「你选的那条等于在说什么意思」（写进账户，做错题时立刻看到）
- **题库属于账户**（内容层，`items` 表）：语料派生的题由 `python scripts/push-items.py` 导进账户（幂等、带批次可对照），与仓库自带的老题一起进抽题池；审核结论写回题库，清空进度**不会**清掉题库。管线各段的连通性核对见 [docs/管线连通性-审查.md](docs/管线连通性-审查.md)
- **语音**：浏览器 Web Speech API（免费）；**推荐 Edge 打开，自动换微软在线自然语音**

## 内容（M1 进行中）

- **第 7 课《英语是直线型思维》**：11 个思维点 · 约 300 题
- **第 10 课《动词不只是动作》**：6 个思维点 · 约 80 题
- 下一步：第 8 课（词性总图）→ 第 9 课 → 第 11 课时态矩阵

## 开发

```bash
npm test        # vitest 回归（92 条：调度 / 证据 / 判定 / 迁移 / 题库结构 / 数据库 API）
npm run lint    # oxlint
```

```
src/
  types.ts               数据模型（v2 事件 / 题级状态 / 冻结队列）
  content/adapt.ts       题目适配器（选项/词块 ID 化 + v2 元数据默认值）
  content/validation.ts  题库结构校验（测试门槛）
  learning/scheduler.ts  今日队列 + 题级复习规则 + 变式补练
  learning/evidence.ts   四维能力证据推导
  learning/grading.ts    按 ID 判定 + 跟读分档
  store/migrations.ts    v1→v2 迁移 / 逐题落盘 / 导入导出
  store/db.ts            进度数据库客户端（增量推事件 / 取并集 / 离线回退）
  store/useDbSync.ts     启动接管决策 + 防抖落库 + 账户切换
  data/                  课程注册表 + 各课题库
  components/            Quiz / PathHome / Dashboard / AccountPanel / 图表与提示组件
server/
  db.mjs                 SQLite 数据层（schema / 聚合视图 / 快照）
  api.mjs                /api 路由（纯函数 handleApi，测试直接调它）
vite-plugin-db.mjs       dev 与 preview 同进程挂载 /api
scripts/db.py            进度数据库查询 CLI（只读：summary/objectives/errors/items/batches/sql）
scripts/push-items.py    把 out/ 里生成的题导进账户题库（幂等 + 批次）
scripts/audit-bank.py    仓库题库内容自检（查重 / 打架 / 句子复用；与 app 内同一套规则）
server/llm.mjs           服务端模型通道（密钥只从仓库外读，不落库）
server/content-ai.mjs    系统 AI 给题补逐项纠正（带质量闸门）
```

文档：`docs/数据库与账户.md`、`P0-交付说明-变更迁移与已知限制.md`、`UI-v5-参考图框架重构报告.md`、`SOFT-GLASS-UI-改版报告-v4.md`、`REVIEW-张老师视角x高级教师视角.md`、`design-v5/`（界面截图）。

题库规则：所有解析都能追溯到张老师课稿的说法；不引入课外语法表述。
