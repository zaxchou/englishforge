#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
题目解析器 (question parser)

把四科文本 (Listening / Reading / Writing / Speaking) 解析成统一的题目结构:

    {
      "subject": "listening",
      "modules": [
        {"module": 1, "groups": [
           {"kind": "choose_response", "q_range": "1-12",
            "audio": "...mp3",            # 该组共享音频
            "questions": [{"no":1, "stem":"...", "options":{"A":"..."}}]}
        ]}
      ]
    }

设计要点
--------
1. 四科题面文本形态差异很大, 但都有稳定标记:
   - "Listening Module 1 (Questions 1-32)"  -> 模块
   - "Q13." / "Q13. stem"                 -> 题号
   - "A. xxx"                             -> 选项
   - "Audio: audio/item_level/xxx.mp3"    -> 音频链接 (最关键)
   - "Fill-in-the-Blank (Questions 1-10)" -> 题型
   - "Context:/Response:/Word Bank:"      -> 写作句子建构
   - "Task 1: Listen and Repeat"          -> 口语任务
2. 音频行紧跟在题面之后, 所以解析时用"向后看"策略把音频挂到
   最近的题/组上 —— 这是题目↔音频链接的核心。
3. 听力原文/写作范文/口语范文不在题目文件里, 由 answers 侧提供,
   这里只负责题面 + 音频。
"""

from __future__ import annotations
import os
import re
from typing import Any

# ---------------------------------------------------------------- 词法

# 模块头有两种写法:
#   "Listening Module 1 (Questions 1-32)"  (6.22 等, 带学科前缀)
#   "Module 1"                            (6.10 等, 单独一行, 前面是 "Listening")
# 但 "Module 2 Q1. stem" 是第三种写法 —— 模块号带题号, 归题号分支处理,
# 所以这里用负向断言把它排除掉, 否则模块分支会先抢走, 题就丢了。
RE_MODULE   = re.compile(
    r"^\s*(?:(?:Listening|Reading|Writing|Speaking)\s+)?Module\s*(\d+)\b"
    r"(?!\s+Q?\d{1,2}\s*[.．、])", re.I)
# 口语任务头。素材两种写法都有:
#   "Task 1: Listen and Repeat"   带冒号 (6.22 等)
#   "Task 1 Listen and Repeat"    不带冒号 (6.7 等)
# 冒号必须可选, 否则后者整段口语解析成 0 题。
RE_TASKHEAD = re.compile(
    r"^\s*(Task\s*\d+)\s*(?:[:：\-–—]\s*)?(.{2,}?)\s*$", re.I)
# 有些素材不写 "Task N", 只给任务名 (6.8 的 Speaking.docx 就是)。
# 但 "Listen and repeat only once." 这种**题目说明**长得很像任务名,
# 不能当任务头 —— 否则会把 Task 1 提前切掉, 后面 7 道题全跑到新任务里。
_TASKNAME = re.compile(
    r"^\s*(?:Listen\s+and\s+Repeat|Take\s+an\s+Interview|Interview)"
    r"\s*[:：\-–—]?\s*(?P<rest>.*)$", re.I)
RE_QNUM     = re.compile(r"^\s*[#\s]*Q?(\d{1,2})\s*[.．、]\s*(.*)$", re.I)
# "Module 2 Q1. stem" —— 模块号与题号同一行, 用捕获组把题号部分切出来
RE_QNUM_INLINE = re.compile(
    r"^(\s*Module\s*\d+\s+)(?=Q?\d{1,2}\s*[.．、])", re.I)
RE_AUDIO    = re.compile(r"^\s*(?:Listening|Speaking|Reading|Writing\s+)?Audio\s*[:：]\s*(\S+)", re.I)
RE_OPT      = re.compile(r"^\s*([A-D])\s*[.．、]\s*(.+?)\s*$")
RE_PASSAGE  = re.compile(
    r"^\s*(Fill-in-the-Blank|C-Test|Multiple Choice|Academic Reading"
    r"|Choose the Best Response|Daily Life|Academic Reading Passage"
    r"|Complete the Words)"
    r"\s*(?:\(([^)]*)\))?\s*(?::\s*(.*))?$", re.I)
RE_SENT     = re.compile(r"^\s*Sentence Construction\s*(\d+)\s*$", re.I)
RE_CTX      = re.compile(r"^\s*(Context|Response|Word Bank)\s*[:：]\s*(.*)$", re.I)
RE_RANGE    = re.compile(r"Questions?\s*(\d+)\s*[-–—]\s*(\d+)", re.I)
# 听力/口语里的音频文件名自带题号, 例如
#   listening_m1_q13_q14_conversation_wave_restaurant.mp3
#   speaking_listen_repeat_q03.mp3
# 用它可以在题面没写 "Audio:" 时, 反推出这道题属于哪段音频。
RE_AUDIO_NAME = re.compile(
    r"(?P<mod>m[12])_q(?P<q1>\d{1,2})(?:_q(?P<q2>\d{1,2}))?_(?P<kind>[a-z_]+)", re.I)

# 听力音频文件名里的场景词 -> 题型标签
AUDIO_KIND_MAP = [
    ("choose_response", "choose_response", "Choose the Best Response"),
    ("conversation",   "conversation",   "Conversation"),
    ("announcement",   "announcement",   "Announcement"),
    ("lecture",        "lecture",        "Lecture"),
    ("podcast",        "podcast",        "Podcast"),
    ("talk",           "talk",           "Talk"),
]


def classify_audio_kind(filename: str) -> str:
    """从音频文件名判断这一段属于哪种听力题型。"""
    low = filename.lower()
    for key, canon, _label in AUDIO_KIND_MAP:
        if key in low:
            return canon
    return "listening_segment"


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("\t", " ")).strip()


# ---------------------------------------------------------------- 通用块解析

def _parse_options(lines: list[str], i: int) -> tuple[dict[str, str], int]:
    """从第 i 行开始吃连续选项行。
    - 允许选项之间夹空行（07-11 听力 PDF 的 A 与 B 之间有空行,
      旧逻辑遇到空行即停 -> 只剩 A；Audio 行后的前导空行同理）。
    - 允许选项文本自身跨行（07-11 阅读 "A. ... per \nweek."）:
      非空非选项行并入最后一个选项, 之后若接上选项则继续。
    - 跳过空行/延续行后若不再出现选项行则停止。"""
    opts: dict[str, str] = {}
    last: str | None = None
    j = i
    while j < len(lines):
        m = RE_OPT.match(lines[j])
        if m:
            last = m.group(1).upper()
            opts[last] = _clean(m.group(2))
            j += 1
            continue
        if lines[j].strip() == "":
            k = j
            while k < len(lines) and lines[k].strip() == "":
                k += 1
            if k < len(lines) and RE_OPT.match(lines[k]):
                j = k
                continue
            if opts:
                break
            j = k
            continue
        # 非空非选项行: 选项文本的换行延续（遇题号/Audio/模块/题型头即停）
        if last is not None:
            k = j
            while (k < len(lines) and lines[k].strip()
                   and not RE_OPT.match(lines[k])
                   and not RE_QNUM.match(lines[k]) and not RE_QNUM_INLINE.match(lines[k])
                   and not RE_AUDIO.match(lines[k])
                   and not RE_MODULE.match(lines[k]) and not RE_PASSAGE.match(lines[k])):
                opts[last] = (opts[last] + " " + lines[k].strip()).strip()
                k += 1
            if k == j:
                break            # 首行就是题号/Audio/头 -> 选项区结束（必须前进, 否则死循环）
            j = k
            continue
        break
    return opts, j


def _attach_audio(lines: list[str], i: int) -> tuple[str | None, int]:
    """吃掉紧邻的 Audio: 行。"""
    if i < len(lines):
        m = RE_AUDIO.match(lines[i])
        if m:
            return m.group(1), i + 1
    return None, i


# ---------------------------------------------------------------- 听力

def parse_listening(text: str) -> dict:
    """
    听力按"音频段"分组。

    实际素材里听力题面没有分组标题, 但每段音频都是独立文件, 文件名
    自带题号与场景 (listening_m1_q13_q14_conversation_xxx.mp3)。
    所以这里以音频为锚点建组: 扫到 Audio: 行就开新组, 组内题目共享
    这段音频。这样题目↔音频是结构化的一对多关系, 不靠猜。
    """
    lines = [l.rstrip() for l in text.splitlines()]
    modules: list[dict[str, Any]] = []
    cur_mod: dict | None = None
    cur_group: dict | None = None
    part = 0
    pending_audio: str | None = None
    i = 0

    def flush_para_quiet():
        """听力解析器没有段落缓冲, 留个空函数让分支代码写法统一。"""
        return None

    def ensure_group(audio: str | None):
        nonlocal cur_group
        cur_group = {
            "kind": classify_audio_kind(audio) if audio else "listening_segment",
            "q_range": "",
            "title": _audio_title(audio),
            "audio": audio,
            "questions": [],
        }
        cur_mod["groups"].append(cur_group)
        return cur_group

    while i < len(lines):
        line = lines[i]

        # 模块头。
        # 素材里同一模块可能有两种写法并存:
        #   "Module 2"                 独立一行 (声明)
        #   "Module 2 Q1. ..."         行内带题号 (每题都重复模块号)
        # 若每见一次 "Module N" 就新建模块, 会出现几十个空的 module 2。
        # 规则: 模块号已存在且当前模块还没有题 -> 复用; 否则才是新 part。
        m = RE_MODULE.match(line)
        if m:
            num = int(m.group(1))
            same = [mm for mm in modules if mm["module"] == num]
            if same and same[-1]["groups"]:
                # 已有题 -> 视为新的一套 (合集素材)
                part = same[-1]["part"] + 1
            elif same:
                part = same[-1]["part"]
                cur_mod = same[-1]
                cur_group = None
                i += 1
                continue
            else:
                part = 1
            flush_para_quiet()
            cur_mod = {"module": num, "part": part, "groups": [],
                       "q_range": "", "audio": pending_audio}
            pending_audio = None
            mr = RE_RANGE.search(line)
            if mr:
                cur_mod["q_range"] = f"{int(mr.group(1))}-{int(mr.group(2))}"
            modules.append(cur_mod)
            cur_group = None
            i += 1
            continue

        # 独立成行的 Audio:
        #  - 出现在模块头之前 (如 "Listening Audio: audio/listening_audio_01.mp3"
        #    然后才是 "Module 1") -> 暂存, 等模块开出来再挂上去
        #  - 出现在模块内 -> 忽略, 组级音频由题目的 Audio 决定
        ma = RE_AUDIO.match(line)
        if ma:
            if cur_mod is None:
                pending_audio = ma.group(1)
            i += 1
            continue

        # 题号。三种写法都要认:
        #   "Q13. stem"
        #   "Module 2 Q1. stem"   <- 模块号与题号写在同一行 (6.10 等)
        #   "1. stem"             <- 无 Q 前缀 (口语 Task 1)
        mq = RE_QNUM.match(line)
        if not mq:
            mq2 = RE_QNUM_INLINE.match(line)
            if mq2 and cur_mod is not None:
                # 行内模块号 -> 若与当前模块不同, 切到对应模块
                # (同号就复用, 避免每题都开一个新 part)
                inline_mod = int(re.search(r"Module\s*(\d+)", mq2.group(1), re.I).group(1))
                if inline_mod != cur_mod["module"]:
                    target = next((mm for mm in reversed(modules)
                                   if mm["module"] == inline_mod
                                   and mm["groups"]), None)
                    if target is None:
                        part += 1
                        cur_mod = {"module": inline_mod, "part": part,
                                   "groups": [], "q_range": "",
                                   "audio": pending_audio}
                        pending_audio = None
                        modules.append(cur_mod)
                    else:
                        cur_mod = target
                    cur_group = None
                line = line[mq2.end():]  # 去掉 "Module N " 前缀再继续解析
                mq = RE_QNUM.match(line)
        if mq and cur_mod is not None:
            start = i
            no, stem = int(mq.group(1)), _clean(mq.group(2))

            # 题干延续行: Q 行后的纯文本行（非选项/Audio/新题号）并入题干。
            # 07-04 听力的题干带引号长句、07-11 的 Q15 在题干与 Audio 之间
            # 有空行 —— 旧逻辑遇到空行/异形行即停, 选项整块丢失。
            # 跳过空行前瞻: 首个非空行若是选项/Audio/新题号则停在这里
            # (i 停在其前一行, 供 _attach_audio/_parse_options 从 i+1 接手),
            # 否则并入题干继续。
            k = i + 1
            while k < len(lines):
                nxt = lines[k]
                if not nxt.strip():
                    k += 1
                    continue
                if (RE_OPT.match(nxt) or RE_AUDIO.match(nxt)
                        or RE_QNUM.match(nxt) or RE_QNUM_INLINE.match(nxt)
                        or RE_PASSAGE.match(nxt) or RE_MODULE.match(nxt)
                        or re.match(r"^\s*(Read|Listen to)\b", nxt)):
                    break
                stem += " " + nxt.strip()
                k += 1
                if len(stem) > 400:      # 兜底, 防吞掉整个文件
                    break
            i = k - 1

            # 题干之后可能紧跟 Audio 行 (素材的主要排法)
            audio, i = _attach_audio(lines, i + 1)

            q = {"no": no, "stem": stem, "options": {}, "audio": audio}
            opts, j = _parse_options(lines, i)
            if opts:
                q["options"] = opts
                i = j

            if cur_mod is None:
                i = start + 1
                continue

            # 以音频为锚点归组: 同一段音频的题聚成一组。
            # 找不到音频 (极老素材) 时按题号连续性归到当前组。
            target = None
            if audio:
                for g in cur_mod["groups"]:
                    if g.get("audio") == audio:
                        target = g
                        break
                if target is None:
                    target = ensure_group(audio)
            else:
                target = cur_group
                if target is None or (
                        target["questions"]
                        and target["questions"][-1]["no"] != no - 1):
                    target = ensure_group(None)
            target["questions"].append(q)
            cur_group = target

            if i <= start:
                i = start + 1
            continue

        i += 1

    # 回填每组题号范围
    for m in modules:
        for g in m["groups"]:
            qs = [q["no"] for q in g["questions"]]
            if qs:
                g["q_range"] = (f"{min(qs)}-{max(qs)}" if min(qs) != max(qs)
                                else str(min(qs)))
            # 素材只给整段音频时 (如 6.10 的 listening_audio_01.mp3),
            # 该模块下所有题都指向同一段, 题级链接不能空着。
            if m.get("audio") and not g.get("audio"):
                g["audio"] = m["audio"]
                g["audio_module_level"] = True
        # 题目没单独音频的, 继承组级/模块级
        for g in m["groups"]:
            for q in g["questions"]:
                if not q.get("audio"):
                    q["audio"] = g.get("audio")

    return {"subject": "listening", "modules": modules}


def _audio_title(audio: str | None) -> str:
    """
    从音频文件名取可读标题。

    素材文件名已自带场景 (…_conversation_wave_restaurant.mp3), 题面本身
    没有标题, 所以只取场景部分, 不要把 listening/choose_response 这类
    与题型标签重复的前缀拼进标题。
    """
    if not audio:
        return ""
    stem = os.path.splitext(os.path.basename(audio))[0]
    m = re.search(r"_m\d+_q\d+(?:_q\d+)?_(?P<scene>[a-z_]+)$", stem, re.I)
    scene = m.group("scene") if m else stem
    for junk in ("listening", "speaking"):
        scene = re.sub(rf"^{junk}_", "", scene, flags=re.I)
    words = [w for w in scene.split("_") if w]
    if not words:
        return ""
    return " ".join(w.capitalize() for w in words)



def _canon_kind(kind: str) -> str:
    k = kind.strip().lower()
    if "fill" in k or "c-test" in k or "complete" in k:
        return "fill_in_blank"
    if "multiple" in k or "academic" in k:
        return "multiple_choice"
    if "choose" in k:
        return "choose_response"
    return k.replace(" ", "_")


# 判断一行是否"裸文章标题"：短、无句号、不是选项/指令、也不是题号行。
# 必须严格 —— 这里误判一次 (比如把填空说明当成标题) 就会把整篇文章
# 的正文并到错误分组, 后面所有题都挂错原文。宁可漏判, 让人工补。
_BARE_HEAD_MAX = 80


def _is_article_head(s: str) -> bool:
    if not s or len(s) > _BARE_HEAD_MAX:
        return False
    # 结构性标记一律否决
    if "[[IMG" in s or s.startswith(("•", "-", "*")):
        return False
    if re.match(r"^\s*[A-D]\s*[.．、]", s):        # 选项
        return False
    if re.match(r"^\s*(Read|Skim|Listen)\b", s, re.I):   # 指令
        return False
    if re.match(r"^\s*(Fill|Multiple|Academic|Choose|Daily|Complete|C-Test|"
                r"TOEFL|Module)\b", s, re.I):
        return False
    if re.match(r"^\s*\d+[a-z]?\s*[.．、]", s):     # 题号
        return False
    # 句子形态 (含常见句读) 一律否决
    if re.search(r"[.!?,;]\s*\S", s):
        return False
    # 标题通常 Title Case 或含题号区间; 只要有题号区间就认
    if RE_RANGE.search(s):
        return True
    # 其余要求: 首词大写 且 词数不多 (像标题而不像句子)
    words = s.split()
    if not (1 <= len(words) <= 9):
        return False
    if not s[0].isupper():
        return False
    return True


# 结构化材料的内嵌小标题, 出现在 DOCX 表格单元格里, 抽取后与正文连成一行。
# 用于把"一段塞了好几篇材料"的阅读块切回一材料一题组。
RE_INLINE_SUBHEAD = re.compile(
    r"(?<=[\s.])(?P<h>"
    r"(?:Notice|Agenda|Schedule|Outline|Syllabus\s+Excerpt|Syllabus|"
    r"Course\s+Description|Course\s+Outline|Meeting\s+days|"
    r"Free\s+Will\s+and\s+Determinism)"
    r")\s*:", re.I)


def split_inline_materials(passage: str) -> list[tuple[str, str]]:
    """
    把挤在一起的若干段材料按内嵌小标题切开。

    素材里这种形态很常见: 表格型材料 (产品标签 / 课程表 / 议程) 经
    docx_text 抽取后, 多段材料会连成一大段, 后面几十道选择题全都挂
    在"第一段"名下 —— 做题时根本不知道该看哪段。
    返回 [(小标题, 该段正文), ...]; 切不开则返回单段。
    """
    if not passage:
        return []
    hits = list(RE_INLINE_SUBHEAD.finditer(passage))
    if not hits:
        return [("", passage.strip())]

    segs: list[tuple[str, str]] = []
    head = passage[:hits[0].start()].strip()
    if head:
        segs.append(("", head))
    for i, m in enumerate(hits):
        start = m.start("h")
        end = hits[i + 1].start() if i + 1 < len(hits) else len(passage)
        body = passage[start:end].strip()
        title, _, rest = body.partition(":")
        segs.append((title.strip(), rest.strip()))
    return segs


# ---------------------------------------------------------------- 阅读

def parse_reading(text: str) -> dict:
    lines = [l.rstrip() for l in text.splitlines()]
    modules: list[dict[str, Any]] = []
    cur_mod = None
    cur_group = None
    part = 0
    i = 0
    pending_para: list[str] = []
    pending_img: list[bool] = []   # 与 pending_para 同步: 该段是否"纯图片材料"
    last_instruction: str = ""     # 最近一次 "Read an email." 之类指令

    def flush_para():
        """
        把攒下的非题目行并进当前组的材料。

        IMG 单独处理: [[IMG]] 出现在哪, 说明"那一段材料是截图"。
        它属于**读到它时所在的组**。若此时还没开新组(比如
        "Read an email." 之后紧跟 [[IMG]] 再跟 Q21), 应该留给
        即将被自动创建的 MC 组, 而不是塞进上一组填空文章里 ——
        否则 Q11-20 明明有文字原文, 却被误标成"图片"。
        """
        nonlocal pending_para
        if not pending_para:
            return
        img_here = any("[[IMG" in p for p in pending_para)
        text_parts = [_clean(p.replace("[[IMG]]", ""))
                      for p in pending_para]
        txt = _clean(" ".join(t for t in text_parts if t))
        if cur_group is not None and not (img_here and not txt):
            if txt:
                cur_group["passage"] = (
                    cur_group.get("passage", "") + " " + txt).strip()
        pending_img.append(img_here and not txt)
        pending_para = []

    while i < len(lines):
        line = lines[i]
        s = line.strip()

        m = RE_MODULE.match(line)
        if m:
            flush_para()
            num = int(m.group(1))
            # 合集素材: 同一 Module 号再次出现 = 新的一套, 用 part 区分
            if any(mm["module"] == num for mm in modules):
                part += 1
            else:
                part = 1
            cur_mod = {"module": num, "part": part, "groups": []}
            modules.append(cur_mod)
            cur_group = None
            i += 1
            continue

        # 题型/材料头
        mg = RE_PASSAGE.match(line)
        if mg and cur_mod is not None:
            flush_para()
            kind = mg.group(1).strip()
            rng = mg.group(2) or ""
            title = _clean(mg.group(3) or "")
            mr = RE_RANGE.search(rng) or RE_RANGE.search(line)
            q1, q2 = (int(mr.group(1)), int(mr.group(2))) if mr else (None, None)
            # 标题里常重复题号区间 ("Bird Migration (Questions 31-35)"),
            # 去掉后由 q_range 统一呈现, 避免同一信息出现两次。
            title = re.sub(r"\s*\(?\s*Questions?\s*\d+\s*[-–—]\s*\d+\s*\)?",
                           "", title, flags=re.I).strip()
            cur_group = {
                "kind": _canon_kind(kind),
                "q_range": f"{q1}-{q2}" if q1 else "",
                "title": title,
                "passage": "",
                "questions": [],
            }
            cur_mod["groups"].append(cur_group)
            i += 1
            continue

        # 裸文章标题 (无 "Academic Reading"/题号 前缀, 如 "The Mystery of
        # Dark Galaxies")。素材里这类标题下就是文章正文, 若不建组, 正文会
        # 被 pending_para 攒着最后并到上一组, 该篇的题就挂不上原文。
        # 判定要严: 结构化材料(产品标签/课程大纲)里满是 "Label:"/"Contains"
        # 这类字段名, 误判一次就会把整段正文并到错误分组。
        if cur_mod is not None and cur_group is not None \
                and cur_group["kind"] == "fill_in_blank" \
                and cur_group.get("questions") == [] \
                and _is_article_head(s):
            flush_para()
            mr = RE_RANGE.search(s)
            cur_group = {
                "kind": "multiple_choice",
                "q_range": (f"{int(mr.group(1))}-{int(mr.group(2))}"
                            if mr else ""),
                "title": re.sub(r"\s*\(?\s*Questions?\s*\d+\s*[-–—]\s*\d+\s*\)?",
                                "", s, flags=re.I).strip(),
                "passage": "",
                "questions": [],
                "auto": True,
            }
            # 别把 [[IMG]] 占位当成标题
            if "[[IMG" in cur_group["title"]:
                cur_group["title"] = ""
            cur_mod["groups"].append(cur_group)
            last_instruction = ""
            i += 1
            continue

        # 阅读指令 (如 "Read an email." / "Read a notice.")
        # 指令只对"紧随其后"的材料有效, 所以每次见到都要刷新 last_instruction;
        # 同一段里的 Q21/Q22 共用一条, 换段 (Read a review.) 才另开一组。
        if re.match(r"^\s*(Read|Skim|Read and (skim|read))\b", s, re.I):
            flush_para()
            last_instruction = _clean(s)
            i += 1
            continue

        mq = RE_QNUM.match(line)
        if not mq:
            # "Module 2 Q1. ..." —— 模块号与题号同一行
            mq2 = RE_QNUM_INLINE.match(line)
            if mq2 and cur_mod is not None:
                inline_mod = int(re.search(r"Module\s*(\d+)", mq2.group(1), re.I).group(1))
                if inline_mod != cur_mod["module"]:
                    flush_para()
                    part = (part + 1
                            if any(mm["module"] == inline_mod for mm in modules)
                            else 1)
                    cur_mod = {"module": inline_mod, "part": part, "groups": []}
                    modules.append(cur_mod)
                    cur_group = None
                line = line[mq2.end():]
                s = line.strip()
                mq = RE_QNUM.match(line)
        if mq and cur_mod is not None:
            start = i
            flush_para()
            no, stem = int(mq.group(1)), _clean(mq.group(2))
            # 选择题若没有归属分组 (如 Q21-30 日常话题块), 自动开一个,
            # 否则这些题会被塞进上一个 Fill-in-the-Blank 组, 语义就错了。
            # 日常话题块里每段材料各带一个 "Read a ..." 指令, 遇到新指令
            # 也要另开一组, 否则 Q21-30 会挤成一段, 材料与题目错配。
            need_new = (cur_group is None
                        or cur_group["kind"] == "fill_in_blank"
                        or (last_instruction
                            and cur_group.get("instruction") != last_instruction))
            if need_new and cur_mod is not None:
                # 标题不能沿用填空组的文章名 (如 "Academic Success Skills"),
                # 否则会误导以为这些题出自同一篇文章。
                cur_group = {
                    "kind": "multiple_choice",
                    "q_range": "",
                    "title": "" if cur_group is not None else "Multiple Choice",
                    "passage": "",
                    "questions": [],
                    "auto": True,
                }
                # 若刚 flush 出来的段落是"纯图片材料", 归属给这个新组
                if any(pending_img):
                    cur_group["passage_image"] = True
                if last_instruction:
                    cur_group["instruction"] = last_instruction
                pending_img.clear()
                cur_mod["groups"].append(cur_group)
            # 指令已被本组消费, 清空避免把后续题重复切组
            last_instruction = ""
            q = {"no": no, "stem": stem, "options": {}}
            # 题干延续行（同听力解析器）: 阅读题干也会被 PDF 换行截断,
            # 07-04 阅读 Q25 "He \nshould enroll in" 的选项整块丢失。
            k = i + 1
            while k < len(lines):
                nxt = lines[k]
                if not nxt.strip():
                    k += 1
                    continue
                if (RE_OPT.match(nxt) or RE_AUDIO.match(nxt)
                        or RE_QNUM.match(nxt) or RE_QNUM_INLINE.match(nxt)
                        or RE_PASSAGE.match(nxt) or RE_MODULE.match(nxt)
                        or re.match(r"^\s*(Read|Listen to)\b", nxt)):
                    break
                stem += " " + nxt.strip()
                k += 1
                if len(stem) > 400:
                    break
            i = k - 1
            q["stem"] = stem
            opts, j = _parse_options(lines, i + 1)
            if opts:
                q["options"] = opts
                i = j
            else:
                i += 1
            # 自动分组时补 q_range
            if cur_group.get("auto") and not cur_group["q_range"]:
                qs = [x["no"] for x in cur_group["questions"]]
                cur_group["q_range"] = f"{min(qs)}-{max(qs)}" if qs else str(no)
            cur_group["questions"].append(q)
            if i <= start:
                i = start + 1
            continue

        if s:
            pending_para.append(s)
        i += 1

    flush_para()

    # 后处理: 表格型材料常把好几段挤在一段里 (见 split_inline_materials)。
    # 拆开后按段落顺序重新分配题目, 一段材料对一组题。
    _split_dense_material_groups(modules)
    # 插入题的四个位置已在原文标成 [A]..[D]，无独立选项行也能忠实导入。
    # 不推测无位置标记题的插入点。
    for m in modules:
        for g in m["groups"]:
            for q in g["questions"]:
                if ("four locations" in q.get("stem", "") and not q.get("options")
                        and all("[" + k + "]" in g.get("passage", "") for k in "ABCD")):
                    q["options"] = {k: "[" + k + "]" for k in "ABCD"}

    from static_references import selection_from_source
    selection_from_source({"modules": modules}, text)

    return {"subject": "reading", "modules": modules}


def _split_dense_material_groups(modules: list[dict]) -> None:
    """
    一个组里如果含多段材料, 就按段落拆成多个组, 题目顺序对号入座。

    触发条件要保守: 只有"材料段数 >= 2 且组内题数 >= 4"才拆,
    否则会把正常的单篇长文误拆 (一篇 15 题的文章不该被切成三段)。
    """
    for m in modules:
        new_groups: list[dict] = []
        for g in m["groups"]:
            segs = split_inline_materials(g.get("passage", "") or "")
            qs = g["questions"]
            if len(segs) < 2 or len(qs) < 4:
                new_groups.append(g)
                continue
            # 有多少题, 就按比例分给多少段; 后面的段可为空
            per = (len(qs) + len(segs) - 1) // len(segs)
            for i, (title, body) in enumerate(segs):
                chunk = qs[i * per:(i + 1) * per] if i < len(segs) - 1 \
                    else qs[i * per:]
                if not chunk and not body:
                    continue
                new_groups.append({
                    "kind": g["kind"],
                    "q_range": f"{min(c['no'] for c in chunk)}-{max(c['no'] for c in chunk)}"
                               if chunk else "",
                    "title": title or g.get("title", ""),
                    "passage": body,
                    "questions": chunk,
                    "auto": True,
                    "split_from": g.get("title", ""),
                })
        m["groups"] = new_groups


# ---------------------------------------------------------------- 写作

def parse_writing(text: str) -> dict:
    lines = [l.rstrip() for l in text.splitlines()]
    tasks: list[dict[str, Any]] = []

    cur_sent: dict | None = None
    cur_task: dict | None = None
    pending_ctx = pending_resp = pending_bank = None
    in_sample = False

    def flush_sent():
        nonlocal cur_sent, pending_ctx, pending_resp, pending_bank
        if cur_sent and cur_task is not None:
            cur_sent["context"] = _clean(pending_ctx or "")
            cur_sent["response_slots"] = _clean(pending_resp or "")
            cur_sent["word_bank"] = [w.strip() for w in
                                     re.split(r"[|]", pending_bank or "") if w.strip()]
            cur_task["sentences"].append(cur_sent)
        cur_sent, pending_ctx, pending_resp, pending_bank = None, None, None, None

    for raw in lines:
        s = raw.strip()
        if not s:
            continue

        ms = RE_SENT.match(s)
        if ms:
            flush_sent()
            # "Sentence Construction" 只在第一次出现时建任务,
            # 后续同名小节都并入同一任务 (否则会生成 10 个重复 task)。
            if cur_task is None or cur_task.get("type") != "sentence_construction":
                cur_task = {"type": "sentence_construction",
                            "title": "Sentence Construction", "sentences": []}
                tasks.append(cur_task)
            cur_sent = {"no": int(ms.group(1))}
            continue

        if re.match(r"^Sample (?:Email|Academic Discussion Response)$", s, re.I):
            in_sample = True
            if cur_task is not None: cur_task.setdefault('reference_lines', [])
            continue
        if in_sample and not re.match(r"^(Write an Email|Write for an Academic Discussion|Academic Discussion|Email)$", s, re.I):
            if cur_task is not None: cur_task.setdefault('reference_lines', []).append(_clean(s))
            continue
        # 写作任务标题 (email / academic discussion)。
        # 只认"独立成行且较短"的那种, 否则 "Write an email to customer
        # service. In your email, do the following:" 这种题面说明
        # 会被误当成新任务, 凭空多出一个 task。
        if (re.match(r"^\s*(Write an Email|Write for an Academic Discussion|"
                     r"Academic Discussion|Email)\s*$", s, re.I)
                or (re.match(r"^\s*(Write an Email|Write for an Academic Discussion)\b",
                             s, re.I) and len(s) <= 60
                    and not s.rstrip().endswith((".", ":")))):
            flush_sent()
            in_sample = False
            cur_task = {"type": _canon_write_type(s), "title": _clean(s),
                        "sentences": []}
            tasks.append(cur_task)
            continue

        # 题面说明行 (属于当前任务)
        if re.match(r"^\s*(Write an email|Write as much|In your email|"
                    r"your email|Read the|Directions?|"
                    r"Here is|You (are|have|should)|Some people)\b", s, re.I):
            if cur_task is not None:
                cur_task.setdefault("prompt_lines", []).append(_clean(s))
            continue

        m = RE_CTX.match(s)
        if m:
            k, v = m.group(1).lower(), m.group(2)
            if k == "context":
                pending_ctx = v
            elif k == "response":
                pending_resp = v
            elif k == "word bank":
                pending_bank = v
            continue

        # A bank on the next line belongs to the current sentence, not task body.
        if cur_sent is not None and pending_bank is not None and '|' in s:
            pending_bank = (pending_bank + ' ' + s).strip()
            continue
        if cur_task is not None:
            cur_task.setdefault("body", []).append(_clean(s))

    flush_sent()
    return {"subject": "writing",
            "tasks": [t for t in tasks if t.get("sentences") or t.get("body")]}


def _canon_write_type(title: str) -> str:
    t = title.lower()
    if "email" in t:
        return "email"
    if "academic" in t or "discussion" in t:
        return "academic_discussion"
    if "sentence" in t:
        return "sentence_construction"
    return "writing_task"


# ---------------------------------------------------------------- 口语

def parse_speaking(text: str) -> dict:
    lines = [l.rstrip() for l in text.splitlines()]
    tasks: list[dict[str, Any]] = []
    cur = None
    i = 0
    pending_audio = None

    while i < len(lines):
        s = lines[i].strip()
        mt = RE_TASKHEAD.match(s)
        if not mt and _TASKNAME.match(s):
            # 素材里有的文件不写 "Task 1", 直接给任务名:
            #   "Listen and Repeat" / "Take an Interview" (6.8 等)
            # 不兜这一种, 整份口语 0 题 —— 因为下面所有小题都挂在 cur 下面。
            rest = (_TASKNAME.match(s).group("rest") or "").strip()
            # rest 是一句话 (如 "only once.") -> 这是题目说明, 不是任务名
            if not rest or len(rest.split()) <= 4 and not rest.endswith("."):
                mt = re.match(r"^\s*(?P<task>Task\s*\d+|Listen and Repeat"
                              r"|Take an Interview|Interview)"
                              r"\s*[:：\-–—]?\s*(?P<title>.*)$", s, re.I)
        if mt:
            task_txt = (mt.groupdict().get("task") or "").strip()
            title = _clean(mt.groupdict().get("title") or "")
            # "Task 1 Listen and Repeat" -> task=TASK1, title=Listen and Repeat
            tm = re.match(r"^\s*Task\s*(\d+)\s*(.*)$", task_txt, re.I)
            if tm:
                tno = int(tm.group(1))
                title = (title or tm.group(2)).strip()
            else:
                tno = len(tasks) + 1
                title = title or task_txt
            cur = {"task": f"TASK{tno}", "title": title, "instructions": [], "items": []}
            pending_audio = None
            tasks.append(cur)
            i += 1
            continue

        if cur is not None:
            ma = RE_AUDIO.match(s)
            if ma:
                pending_audio = ma.group(1)
                i += 1
                continue
            mq = RE_QNUM.match(lines[i])
            if mq:
                start = i
                no = int(mq.group(1))
                stem = _clean(mq.group(2))
                # "1. Response: ________" 整行就是答题栏, 不是题干。
                # 不拆开的话 prompt 会变成 "Response: ____", 读起来不是题目。
                mresp = re.match(r"^Response\s*[:：]\s*(.*)$", stem, re.I)
                if mresp:
                    inline_response = _clean(mresp.group(1))
                    stem = ""
                else:
                    inline_response = None
                j = i + 1
                audio = pending_audio
                pending_audio = None
                response = inline_response or ""
                while j < len(lines):
                    ls = lines[j].strip()
                    if RE_AUDIO.match(ls):
                        # Audio-before-question layout: do not steal the next numbered audio.
                        candidate = RE_AUDIO.match(ls).group(1)
                        qmatch = re.search(r"_q0*(\d+)(?:\D|$)", candidate, re.I)
                        if qmatch and int(qmatch.group(1)) != no:
                            break
                        if audio:  # an explicit leading audio is already assigned
                            break
                        audio = candidate
                        j += 1
                        continue
                    mr = re.match(r"^\s*Response\s*[:：]\s*(.*)$", ls, re.I)
                    if mr:
                        response = _clean(mr.group(1))
                        j += 1
                        continue
                    if RE_QNUM.match(lines[j]) or RE_TASKHEAD.match(ls) or _TASKNAME.match(ls):
                        break
                    if ls:
                        stem = (stem + " " + _clean(ls)).strip()
                    j += 1
                cur["items"].append({"no": no, "prompt": stem,
                                     "response": response, "audio": audio})
                i = j if j > start else start + 1
                continue
            if s and not cur["items"]:
                cur["instructions"].append(s)
        i += 1

    result = {"subject": "speaking", "tasks": tasks}
    ids = [(t["task"], it["no"]) for t in tasks for it in t["items"]]
    if len(ids) != len(set(ids)):
        result["blocked_reason"] = "源口语文本任务边界不完整，同任务题号重复；需对照原页重新识别，暂不开放作答"
    return result


# ---------------------------------------------------------------- 入口

PARSERS = {
    "listening": parse_listening,
    "reading": parse_reading,
    "writing": parse_writing,
    "speaking": parse_speaking,
}


def parse_subject(subject: str, text: str,
                  audio_catalog: list[str] | None = None) -> dict:
    """
    解析某一科的题面。

    audio_catalog: 该套题目录下实际存在的音频文件名 (相对路径)。
    有些素材 (如 6.10) 题面里根本没写 "Audio:" 行, 只有 audio/ 目录,
    这时用目录里的文件名兜底挂上, 否则题目↔音频链会整段空掉。
    """
    fn = PARSERS[subject]
    out = fn(text)
    out["source_text_len"] = len(text)
    if audio_catalog and subject in ("listening", "speaking"):
        _attach_audio_by_catalog(out, subject, audio_catalog)
    return out


AUDIO_KW = {"listening": ("listening", "listen"),
            "speaking": ("speaking", "speak", "口语")}


def _attach_audio_by_catalog(parsed: dict, subject: str,
                             catalog: list[str]) -> None:
    """题面没写音频路径时, 按文件名关键词兜底关联。"""
    from audio_integrity import audio_subject
    cands = [c for c in catalog if audio_subject(c) == subject]
    if not cands:
        return
    # 优先带模块号的 (listening_audio_01 / listening_m1_...)
    def rank(c: str) -> tuple:
        m = re.search(r"_m(\d+)", os.path.basename(c), re.I)
        return (0 if m else 1, int(m.group(1)) if m else 99, c)
    cands.sort(key=rank)

    if "modules" in parsed:
        for mod in parsed["modules"]:
            mod.setdefault("audio", None)
            if not mod.get("audio"):
                # 找该模块号对应的音频; 没有就退回第一段
                want = f"_m{mod['module']}_"
                hit = next((c for c in cands if want in c.replace("\\", "/")), None)
                # A question-level clip is not a whole-module fallback.
                whole = [c for c in cands if not re.search(r"_q\d+", c, re.I)]
                mod["audio"] = next((c for c in whole if want in c.replace(chr(92), "/")), None)
                if not mod["audio"] and len(whole) == 1 and len(parsed["modules"]) == 1:
                    mod["audio"] = whole[0]
            for g in mod["groups"]:
                g.setdefault("audio", None)
                if not g.get("audio"):
                    g["audio"] = mod["audio"]
                for q in g["questions"]:
                    if not q.get("audio"):
                        q["audio"] = g["audio"]
    else:
        for t in parsed.get("tasks", []):
            for it in t.get("items", []):
                if not it.get("audio"):
                    kind = "listen_repeat" if t.get("task") == "TASK1" else "take_interview" if t.get("task") == "TASK2" else None
                    want = re.compile(r"speaking_" + str(kind) + r"_q0*" + str(it.get("no")) + r"(?:\D|$)", re.I) if kind else None
                    hit = next((c for c in cands if want and want.search(c)), None)
                    it["audio"] = hit  # unknown mapping stays missing; never cycle to first clip


def summarize(parsed: dict) -> str:
    n_q = 0
    if "modules" in parsed:
        for m in parsed["modules"]:
            for g in m["groups"]:
                n_q += len(g["questions"])
    if "tasks" in parsed:
        for t in parsed["tasks"]:
            n_q += len(t.get("sentences", [])) + len(t.get("items", []))
    return f"{parsed['subject']}: {n_q} 题"
