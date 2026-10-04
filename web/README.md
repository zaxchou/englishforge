# TOEFL Lab · 研读桌正式版

设计基线 = `design-exploration/desk-refined.html`（用户选定「研读桌」布局 + 练习跑道字体）。
**必须通过本地服务打开**（双击 HTML 无法访问题库、媒体与记录保存）：

```bash
cd toefl-lab
node server.mjs            # http://localhost:8018
```

## 与旧原型的差别

| | 旧原型（prototype-workbuddy.html） | 正式版（index.html） |
|---|---|---|
| 题面/答案 | 14 道演示题 + 循环假选项 | 真实题库（data/ 全部 94 套，经 /api/set） |
| 进度/错题/统计 | localStorage 假种子 | records/records.json（服务端持久化，无演示种子） |
| 音频 | 模拟进度条 | 真实 mp3（/media/set/<id>/…，支持拖动/倍速） |
| 视频课 | 抽样假数据 + 「素材待接入」 | 223 节真实课程目录（vince mp4 可直接播） |
| 判分 | 固定假答案 | 官方答案真实判分；缺答案如实显示、不判 |
| AI 批改 | 假的评分卡 | 未接入，如实显示 |

## 数据流

- 题库：`/api/catalog`（真实统计）+ `/api/set/<id>`
- 课程：`/api/courses`（`pipeline/scan_courses.py` 产物）+ `/api/handout/<lessonId>`（讲义文本/页图）
- 媒体：`/media/set|vince|ndf|slides/...`（源素材只读映射，绝不把绝对路径发给浏览器）
- 记录：`/api/records`（GET 读 / POST 合并；文件在 `records/records.json`，与可再生的 build/ 分离）

## 身份规则（改代码前必读）

qid = `套题/科目/模块/题型/题号`，例：
- `2026-06-07/listening/m1/mc/12`（听力同号在 m1/m2 各自独立）
- `2026-06-07/reading/m1/fill/3` 与 `.../m1/mc/25`（填空与选择分型）
- `2026-06-07/writing/email/email/1`（email/学术讨论是任务级虚拟条目）
同号不同模块/题型绝不共享进度。教学映射只认 `web/curated.json`（人工核读层）。

## 旧版

`prototype-workbuddy.html` 是 WorkBuddy 时期的静态原型备份，仅留作对照，其中的
「评分维度（ETS 官方）」等说明未经官方核验，不要当事实引用。
