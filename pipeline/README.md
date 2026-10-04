# 托福真题电子化流水线 (TOEFL Lab pipeline)

把 `819新托福真题持续更新/` 里的真题素材（PDF / DOCX / 音频）批量转成
**结构化 Markdown 电子档**，并把 **题目 ↔ 音频 ↔ 答案 ↔ 听力原文** 四者
用稳定锚点串起来。

---

## 一眼看懂

素材其实是**两个家族**，混在一起，处理方式完全不同：

| 家族 | 目录 | 题目形态 | 处理方式 |
|---|---|---|---|
| **文字版** | `2026真题持续更新中/6月`、`7月`、`8月` 等 | DOCX 内含文本层，且写明 `Audio: audio/item_level/xxx.mp3` | 全自动，直接出 Markdown |
| **图片版** | `2026真题持续更新中/1月`、`2月`、`3月`，`托福18套/`，`【201】…` | 扫描 PDF 或 DOCX 内嵌截图，**无文字层** | 抽图 → 拼图 → 多模态识别 → 回填 |

> 结论：**94 套里 10 套是文字版（已全自动出稿）**，其余为图片版，
> 走"抽图 + 识别"两步。流水线不会把图片版静默输出成空文档，
> 而是显式标 `🖼 待识别` 并把图集中导出。

---

## 快速开始

```bash
PY="C:/Users/zeroz/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
ROOT="Z:/BaiduNetdiskWorkspace/myagent-work/zcode/JunEnglish/819新托福真题持续更新"

# 1) 盘点 + 生成 Markdown（文字版一步到位）
$PY pipeline/pipeline.py --root "$ROOT" --out output --build build

# 2) 体检：题号/锚点/音频链接/答案覆盖 是否自洽
$PY pipeline/validate.py --out output --root "$ROOT"

# 3) 图片版：导出待识别清单 + 拼图
$PY pipeline/transcribe.py todo --out output --build build

# 4) 识别结果写成 build/ocr/*.jsonl 后合并，再重跑 1) 即可出全稿
$PY pipeline/transcribe.py merge --build build
```

单套调试：`--only 2026-06-22`

---

## 文件职责

| 文件 | 作用 |
|---|---|
| `scan_manifest.py` | 遍历素材，识别"套题"边界与学科/角色（题面/答案/原文/音频），产出 `build/manifest.json` |
| `extract.py` | DOCX 抽内嵌图 + 抽文本；PDF 渲染页图 + 抽文本；视频抽帧；答案文本结构化 |
| `parse_questions.py` | 四科题面 → 统一 JSON 结构（模块 / 题型分组 / 题号 / 选项 / 音频） |
| `build_markdown.py` | 装配 Markdown：锚点、答案表、听力原文、三向回链 |
| `pipeline.py` | 串起以上步骤，产出 `output/<set_id>/<set_id>.md` 与 `.json` |
| `validate.py` | 产物体检，专门抓"AI 读起来会指错题"的退化 |
| `transcribe.py` | 图片版的抽图 / 拼图 / 识别结果回填 |
| `make_sheets.py` | 拼图工具（2 图/张，实测 4 图会看不清选项） |
| `check_one.py` | 单套解析自检，打印题量与音频覆盖率 |

---

## 输出格式（为什么这么设计）

### 1. 每题一个稳定 ID，答案/音频/原文都回指它

```
L1-Q13 / L2-Q4-Q5 …   听力   （模块-题号）
R1-Q21 …              阅读
W-C3 …                写作句子建构第3题
S-TASK1-3 …           口语 Task1 第3题
```

合集素材（多套题拼一个文件，如 `8.26 国内线下合集`）会出现同号模块，
自动加 part 后缀：`L2#2-Q12`。素材自身撞号时再加 `a/b/c` 兜底 ——
**宁可 id 难看，也不能让两题共用一个锚点**。

### 2. YAML front-matter：机器先读元数据，人类再读正文

```yaml
---
set_id: 2026-06-22
source_dir: "2026真题持续更新中\6月\6.22-已经修复"
subjects: [listening, reading, writing, speaking]
question_count: 88
audio_count: 38
has_answer_key: true
---
```

分块（chunk）时元数据不丢，检索时可直接按 `set_id` 定位。

### 3. 三向回链

每道题下面直接给出答案、音频、原文入口：

```markdown
##### L1-Q13 · Why is the man surprised?

- **A.** Attendance at an event was higher than expected.
- **B.** He has been asked to host an awards ceremony.
…
🔊 音频：[`listening_m1_q13_q14_conversation_wave_restaurant.mp3`]
📄 原文：[`tr-m1-q13`](#tr-m1-q13)
✅ 参考答案：**D**
```

### 4. 听力以"音频段"为骨架

素材的听力题面没有分组标题，但音频文件名自带题号与场景：

```
listening_m1_q13_q14_conversation_wave_restaurant.mp3
              ↑    ↑ ↑
              模块  起 止      → 场景: conversation / wave / restaurant
```

解析时**以音频为锚点建组**，于是自动得到：
`对话 · Q13-14 · Conversation Wave Restaurant`，
题号区间与音频天然对齐，不靠猜。

### 5. 答案与原文默认折叠

正文只留题干，答案表和听力原文放 `<details>`：
避免训练语料把答案混进题干，同时方便人工核对。

---

## 两种答案排版都吃得下

素材里答案格式不统一，解析器两套都支持并合并去重：

```
A) 紧凑式（6.22 等）        B) 分行式（1.28 等）
Reading Module 1            阅读
Fill-in-the-Blank Q1-Q10:   1. encourage 2. aspects … 20. time
1 losses; 2 species; …      21b 22d 23b
```

坑位记录（都已处理）：

- `2. aspects` 曾被误判成选项 `A` → 改为"一次抓完整词再判定词/字母"
- 填空 `1 losses` 与选择 `Q21 C` **共用题号** → 去重键改为 `(题号, 题型)`
- `Q21 C` 数字后只有空格没标点 → 标点必须可选，否则整段选择题丢失
- 原文区的 `Q1. …` 会被当成答案 → 遇 `Listening Transcript` 即停止解析答案

---

## 体检项（`validate.py`）

专抓"看起来成功、实际读错"的退化：

1. front-matter 字段完整
2. **锚点唯一** —— 重复会导致跳转串题
3. **题号唯一**
4. 音频链接指向的文件真实存在（素材在网络盘，先建全局索引再校验，避免每次全盘遍历）
5. 原文回链指向真实存在的锚点
6. 答案表条数 vs 行内答案数（差太多说明答案没挂上题）

当前：**94 套全部通过，问题 0，警告 0**。

---

## 已知边界

- **图片版素材**（约 84 套）目前只到"抽图 + 拼图"这一步，
  题目文字需多模态识别后回填。`transcribe.py todo` 会把它们列成 `🖼 待识别`。
- **逐题时间戳**：素材只给整段音频，没有题级时间轴，
  Markdown 只给文件名 + 覆盖题号，不编造时间点。
- 口语题目在部分素材是**录屏视频**（如 `1.28套一口语.mov`），
  画面带动画，场景切分阈值需按素材调（实测 0.02 阈值 + 30 灰度差去重可用）。
- `Z:` 是网络盘且**只能新建、不能改删**。输出请写到本地目录，
  不要往 `Z:` 上覆盖既有文件。

---

## 环境

```bash
# 已在 venv 中：PyMuPDF(fitz)、pypdf、Pillow、numpy；系统需有 ffmpeg/ffprobe
PY="C:/Users/zeroz/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
```

---

## 新题库入库质量标准

新增题库和现有题库修订，统一遵循 [`docs/真题电子化入库标准-v1.md`](../docs/真题电子化入库标准-v1.md)。重点发布条件：题目编号、材料、答案来源和互动方式可追溯；音频/视频必须与题目范围匹配。长音频超过 120 秒须提供人工核验切点映射或独立整段练习流程；否则对应科目标记 blocked，并从可练数量和完成率中排除。`validate.py` 的结构通过、媒体文件存在或 ASR 相似度高，都不能单独证明题目可用。
