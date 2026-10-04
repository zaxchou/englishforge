#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Markdown 生成器 (build_markdown)

把解析结果装配成"最适合 AI 导入"的 Markdown 电子档。

设计原则 (为什么这样排)
--------------------
1. **一题一锚点**: 每道题有稳定 id (`L1-Q13` / `R1-Q21` / `W-C1` / `S-T1-3`),
   答案、音频、原文全部反向指回这个 id。AI 引用时不会错位。
2. **YAML front-matter**: 机器先读元数据 (题量/音频/是否有答案),
   人类再读正文。分块(chunk)时元数据不丢。
3. **音频是相对路径 + 可点**: 保留素材里的 audio/item_level/... 路径,
   同时在题目处给 `[音频](#anchor)` 双向锚。
4. **答案独立成节且默认折叠**: 正文只留题干, 答案/原文放 `<details>`,
   避免训练语料把答案混进题干, 也方便人工核对。
5. **原文按段落**: 听力原文逐段保留, 并标注覆盖题号, 可反查。
"""

from __future__ import annotations
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from parse_questions import parse_subject  # noqa: E402
from blanks import fill_answers, parse_blanks  # noqa: E402
from extract import docx_text, parse_answers  # noqa: E402

SUBJ_CN = {"listening": "听力 Listening", "reading": "阅读 Reading",
           "writing": "写作 Writing", "speaking": "口语 Speaking"}
SUBJ_ORDER = ["listening", "reading", "writing", "speaking"]

# 答案文本里的分区标题 (听力原文 / 写作范文 / 口语范文)
# 必须带 re.M: 这些标题在多行文本中间, 不加会整篇匹配不上。
RE_TRANSCRIPT_HEAD = re.compile(r"^\s*Listening Transcript\s*$", re.I | re.M)
RE_SENT_ANS_HEAD = re.compile(r"^\s*Sentence Construction Answers?\s*$", re.I)
RE_WRITE_SAMPLE = re.compile(
    r"^\s*Write (an Email|for an Academic Discussion)\s*[-–—]?\s*"
    r"(Sample(?: Answer)?|Direction\s*\d.*)?:?\s*(.*)$", re.I)
RE_SPK_SAMPLE = re.compile(
    r"^\s*(Task\s*\d+)\s*[-–—]\s*(Reference Responses?|Sample.*)$", re.I)


# ------------------------------------------------------------------ 工具

def qid(subject: str, module: int | str, no: int | str, task: str = "",
        part: int = 1) -> str:
    """
    生成题目唯一 id。

    part > 1 时加后缀: 有些素材是"合集" (多套题拼在同一个文件里, 如
    8.26 国内线下合集), 会出现第二个 Module 1 / 第二个 Module 2,
    题号就会重复。不区分的话锚点会撞, AI 引用会指错题。
    """
    p = "" if part <= 1 else f"#{part}"
    if subject == "listening":
        return f"L{module}{p}-Q{no}"
    if subject == "reading":
        return f"R{module}{p}-Q{no}"
    if subject == "writing":
        return f"W-{task}{no}"
    return f"S-{task}-{no}"


# 兜底去重: 素材本身就有缺陷时会撞号 (实测 8.26 里两段不同的 lecture
# 都自称 "Module 2 Q12-Q15")。撞了就加 a/b/c 后缀, 保证锚点唯一,
# 宁可 id 难看, 也不能让两题共用一个锚点。
_SEEN_IDS: set[str] = set()


def unique_qid(base: str) -> str:
    if base not in _SEEN_IDS:
        _SEEN_IDS.add(base)
        return base
    for suf in "abcdefghijklmnopqrstuvwxyz":
        cand = f"{base}{suf}"
        if cand not in _SEEN_IDS:
            _SEEN_IDS.add(cand)
            return cand
    n = 2
    while f"{base}#{n}" in _SEEN_IDS:
        n += 1
    _SEEN_IDS.add(f"{base}#{n}")
    return f"{base}#{n}"


def anchor(i: str) -> str:
    return i.lower().replace(" ", "-")


# 听力原文索引: (module, qno) -> 锚点。渲染题目时查它做"题目→原文"回链。
_TRANSCRIPT_INDEX: dict[tuple[int, int], str] = {}


def _transcript_ref(module: int, qno: int) -> str | None:
    return _TRANSCRIPT_INDEX.get((module, qno))


def md_escape(s: str) -> str:
    """转义会破坏表格/列表的字符。"""
    return (s or "").replace("|", "\\|").replace("\n", " ").strip()


def fmt_dur(sec: Any) -> str:
    try:
        sec = int(sec)
    except (TypeError, ValueError):
        return ""
    return f"{sec // 60}:{sec % 60:02d}"


# ------------------------------------------------------------------ 听力原文

def split_transcript(answer_text: str) -> dict:
    """
    从答案文件里切出听力原文。

    原文有两种形态:
      - "Module 1 - Choose the Best Response" 下跟 "Q1. <听到的句子>"
        (这些句子就是每道 choose-response 题的音频内容)
      - "Module 1 Q13-Q14 | Conversation: xxx" 下跟逐句对话
    两者都归一成 segments, 用 q1/q2 标注覆盖题号, 可与题目反向对照。
    """
    if not answer_text or not RE_TRANSCRIPT_HEAD.search(answer_text):
        return {}
    body = answer_text.split(RE_TRANSCRIPT_HEAD.search(answer_text).group(0), 1)[1]

    segs: list[dict] = []
    cur_mod = 1
    # "Module N - Xxx" 是"小节头", 下面紧跟的 Qn. 行属于同一段,
    # 直到出现下一个头为止, 再由内容回填题号范围。
    head: dict | None = None

    def new_head(title: str) -> dict:
        h = {"kind": "head", "module": cur_mod, "title": title, "lines": []}
        segs.append(h)
        return h

    for raw in body.splitlines():
        s = raw.strip()
        if not s:
            continue

        # "Module 1 - Choose the Best Response"
        m = re.match(r"^\s*Module\s*(\d+)\s*[-–—]\s*(.+)$", s, re.I)
        if m:
            cur_mod = int(m.group(1))
            head = new_head(m.group(2).strip())
            continue

        # "Module 1 Q13-Q14 | Conversation: The Wave Restaurant"
        m = re.match(r"^\s*(?:Module\s*(\d+)\s*)?Q(\d{1,2})\s*[-–—]\s*Q?(\d{1,2})"
                     r"\s*\|\s*(.+)$", s, re.I)
        if m:
            cur_mod = int(m.group(1)) if m.group(1) else cur_mod
            head = {"kind": "segment", "module": cur_mod,
                    "q1": int(m.group(2)), "q2": int(m.group(3)),
                    "title": m.group(4).strip(), "lines": []}
            segs.append(head)
            continue

        mq = re.match(r"^\s*Q(\d{1,2})\s*[.．、]\s*(.+)$", s)
        if mq and head is not None and head["kind"] == "head":
            # 小节头下第一条 Q -> 该段起点, 后续 Q 依次收进来
            head = {"kind": "segment", "module": cur_mod,
                    "q1": int(mq.group(1)), "q2": int(mq.group(1)),
                    "title": head["title"], "lines": [_clean_sent(mq.group(2))]}
            segs[-1] = head
            continue
        if mq and head is not None and head["kind"] == "segment" \
                and re.fullmatch(r"Q%s" % mq.group(1),
                                 f"Q{head['q2'] + 1}", re.I):
            head["q2"] = int(mq.group(1))
            head["lines"].append(_clean_sent(mq.group(2)))
            continue

        if head is not None:
            head["lines"].append(s)

    # 丢掉没有内容的壳 (只出现标题没出现内容的)
    out = []
    for s in segs:
        if s["kind"] == "segment" and s["lines"]:
            out.append(s)
    return {"segments": out}


def _clean_sent(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


# ------------------------------------------------------------------ 主体

def render_set(set_id: str, source_dir: Path, subjects: dict[str, Any],
               answers: dict, answer_texts: dict[str, str],
               audio_list: list[dict], media_root: str) -> str:
    """生成单套题的完整 Markdown。"""
    audio_by_name = {a["file"]: a for a in audio_list}

    # 每套题重新计数 (批量跑时不能跨套累积)
    _SEEN_IDS.clear()
    _TRANSCRIPT_INDEX.clear()

    # ---------- front-matter ----------
    total_q = 0
    for subj, p in subjects.items():
        total_q += _count_q(p)
    n_audio = len(audio_list)

    L: list[str] = []
    L.append("---")
    L.append(f"set_id: {set_id}")
    L.append(f"title: \"2026 新托福 真题 {set_id}\"")
    L.append(f"source_dir: \"{source_dir}\"")
    L.append(f"generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    L.append("exam: TOEFL iBT (2026 新版)")
    L.append(f"subjects: [{', '.join(s for s in SUBJ_ORDER if s in subjects)}]")
    L.append(f"question_count: {total_q}")
    L.append(f"audio_count: {n_audio}")
    L.append(f"has_answer_key: {str(bool(answers)).lower()}")
    L.append("---")
    L.append("")
    L.append(f"# 2026 新托福真题 · {set_id}")
    L.append("")
    L.append("> 本文件由 `pipeline` 流水线自动生成：题面来自素材原文件，"
             "答案/原文来自官方答案文件，音频链接指向素材目录。")
    L.append("")

    # ---------- 目录 ----------
    L.append("## 目录")
    L.append("")
    for subj in SUBJ_ORDER:
        if subj not in subjects:
            continue
        L.append(f"- [{SUBJ_CN[subj]}](#{anchor(SUBJ_CN[subj])})")
    L.append("- [答案与参考](#答案与参考)")
    L.append("")

    # ---------- 音频索引 ----------
    if audio_list:
        L.append("## 音频索引")
        L.append("")
        item_level = [a for a in audio_list if "item_level" in a["file"].replace("\\", "/")]
        whole = [a for a in audio_list if a not in item_level]
        if item_level:
            L.append(f"**逐题音频（{len(item_level)}）** — 命名规则："
                     "`listening_m<模块>_q<起>_<止>_<场景>.mp3`，"
                     "题号即文件名中的 `q` 段，可与下方题号直接对应。")
            L.append("")
            L.append("| 学科 | 模块 | 题号 | 场景 | 文件 | 时长 |")
            L.append("|---|---|---|---|---|---|")
            for a in sorted(item_level, key=_audio_sort_key):
                subj, mod, q1, q2, scene = _parse_audio_name(a["file"])
                rng = f"{q1}" if q1 == q2 else f"{q1}-{q2}"
                L.append(f"| {subj} | {('M' + str(mod)) if mod else '—'} "
                         f"| {rng if q1 else '—'} | {scene or '—'} "
                         f"| `{md_escape(a['file'])}` "
                         f"| {fmt_dur(a.get('duration_sec'))} |")
            L.append("")
        if whole:
            L.append(f"**整段音频（{len(whole)}）**")
            L.append("")
            for a in whole:
                L.append(f"- `{md_escape(a['file'])}` — {fmt_dur(a.get('duration_sec'))}")
            L.append("")

    # ---------- 先建"题目→原文"索引, 渲染正文时才能回链 ----------
    tr_all = split_transcript(answer_texts.get("listening", "") or "")
    for s in tr_all.get("segments", []):
        aid = f"tr-m{s['module']}-q{s['q1']}"
        for qn in range(s["q1"], s["q2"] + 1):
            _TRANSCRIPT_INDEX.setdefault((s["module"], qn), aid)

    # ---------- 四科正文 ----------
    for subj in SUBJ_ORDER:
        if subj not in subjects:
            continue
        L.append(f"## {SUBJ_CN[subj]}")
        L.append("")
        L.extend(_render_subject(subj, subjects[subj], answers.get(subj),
                                 answer_texts.get(subj, ""), set_id,
                                 audio_by_name, audio_list))

    # ---------- 答案与参考 ----------
    L.append("## 答案与参考")
    L.append("")
    L.extend(_render_answers(answers, answer_texts, set_id))

    L.append("")
    L.append("---")
    L.append("")
    L.append(f"<sub>由 pipeline 生成 · 源目录 `{source_dir}`</sub>")
    return "\n".join(L) + "\n"


def _count_q(p: dict) -> int:
    if "modules" in p:
        return sum(len(g["questions"]) for m in p["modules"] for g in m["groups"])
    return sum(len(t.get("sentences", [])) + len(t.get("items", []))
               for t in p.get("tasks", []))


def _audio_sort_key(a: dict):
    subj, mod, q1, q2, _ = _parse_audio_name(a["file"])
    order = {"听力": 0, "阅读": 1, "写作": 2, "口语": 3}
    return (order.get(subj, 9), mod or 0, q1 or 0)


def _parse_audio_name(fn: str) -> tuple[str, int, int, int, str]:
    """
    从音频文件名解析 (学科, 模块, 起始题, 结束题, 场景)。

    听力: listening_m1_q13_q14_conversation_x.mp3
    口语: speaking_listen_repeat_q01.mp3 / speaking_take_interview_q03.mp3
    """
    base = os.path.basename(fn)
    low = base.lower()
    subj = "听力" if low.startswith("listening") else (
        "口语" if low.startswith("speaking") else
        "写作" if low.startswith("writing") else "阅读")

    m = re.search(r"_m(\d)_q(\d{1,2})(?:_q(\d{1,2}))?_([a-z_]*)", base, re.I)
    if m:
        return (subj, int(m.group(1)), int(m.group(2)),
                int(m.group(3)) if m.group(3) else int(m.group(2)),
                m.group(4).replace("_", " "))

    # 口语: 没有模块号, 场景在 q 号之前
    m2 = re.search(r"speaking_(?P<scene>[a-z_]+?)_q(\d{1,2})", base, re.I)
    if m2:
        q = int(m2.group(2))
        return ("口语", 0, q, q, m2.group("scene").replace("_", " "))

    m3 = re.search(r"_q(\d{1,2})", base, re.I)
    if m3:
        q = int(m3.group(1))
        return (subj, 0, q, q, "")
    return (subj, 0, 0, 0, "")


# ------------------------------------------------------------------ 各科渲染

def _render_subject(subj: str, parsed: dict, ans: dict | None,
                    ans_text: str, set_id: str, audio_by_name: dict,
                    audio: list | None = None) -> list[str]:
    L: list[str] = []
    ansmap = _answer_lookup(ans)

    if "modules" in parsed:
        for m in parsed["modules"]:
            head = f"### Module {m['module']}"
            if m.get("part", 1) > 1:
                # 合集素材里同号模块再次出现, 标成"第 N 套"避免和前面混淆
                head += f"（第 {m['part']} 套 · Part {m['part']}）"
            if m.get("q_range"):
                head += f"（Q{m['q_range']}）"
            L.append(head)
            L.append("")
            # 整段音频 (图片版素材没有逐题音频, 只有按 part 分段的 m4a)
            if subj == "listening":
                for a in _module_audio_hint(audio, m["module"]):
                    dur = a.get("duration_sec")
                    ds = f" — {int(dur) // 60}:{int(dur) % 60:02d}" if dur else ""
                    L.append(f"🔊 音频（整段）：[`{a['file']}`]{ds}")
                    L.append("")
            for g in m["groups"]:
                # 填空题组没有 questions 列表, 答案要直接挂组上,
                # 才能生成"答案版"原文 (见 _render_group)。
                # 必须**按组切片**: 模块内多个填空组共用一个模块的答案表,
                # 不切片会把 1-10 的答案喂给 11-20 那组, 逐空全错位。
                if g.get("kind") == "fill_in_blank" and not g.get("questions"):
                    q1, q2 = _parse_qrange(g.get("q_range", ""))
                    picked = []
                    for qn in range(q1, q2 + 1):
                        a = ansmap.get((m["module"], qn))
                        if a:
                            picked.append({"no": qn, "a": a})
                    g["answers"] = picked
                L.extend(_render_group(subj, m["module"], g, ansmap,
                                       m.get("part", 1)))
            L.append("")
    else:
        for t in parsed.get("tasks", []):
            L.extend(_render_task(subj, t, ansmap))
            L.append("")
    return L


def _answer_lookup(ans: dict | None) -> dict[tuple[str, int], str]:
    """
    (module, qno) -> answer

    键里带学科: 阅读 M1-Q15 和听力 M1-Q15 是两道完全不同的题,
    早期版本只用 (module, qno) 做键, 导致阅读题被挂上听力答案
    (实测 R2-Q15 拿到了听力 M2 的答案和原文)。
    """
    out: dict[tuple[str, int, int], str] = {}
    if not ans:
        return out
    for mod, lst in ans.items():
        mnum = 1 if mod == "module1" else 2
        for it in lst:
            out[(mnum, it["q"])] = it["a"]
    return out


GROUP_CN = {
    "choose_response": "选择最佳回应",
    "conversation": "对话",
    "announcement": "通知",
    "lecture": "讲座",
    "podcast": "播客",
    "talk": "讲话",
    "fill_in_blank": "填空",
    "multiple_choice": "选择",
    "listening_segment": "听力片段",
    "unknown": "题目",
}


def _group_title(g: dict) -> str:
    """
    组标题: 题型 + 题号 + 场景。
    场景名若和题型同义 (如 choose_response) 就不重复写。
    """
    kind = g.get("kind", "")
    kind_cn = GROUP_CN.get(kind, kind)
    bits = [kind_cn]
    if g.get("q_range"):
        bits.append(f"Q{g['q_range']}")
    title = g.get("title") or ""
    if title:
        # 去掉与题型重复的英文说法
        t = re.sub(r"^(listening|speaking)[\s_]+", "", title, flags=re.I)
        t = re.sub(r"^(choose|choose the best)[\s_]*response$", "", t, flags=re.I)
        t = t.strip(" _-")
        if t and t.lower() != kind_cn.lower():
            bits.append(t)
    return " · ".join(b for b in bits if b)


def _parse_qrange(rng: str) -> tuple[int, int]:
    """'1-10' -> (1, 10);  '15' -> (15, 15);  解析失败 -> (0, 0)"""
    m = re.match(r"\s*(\d+)\s*[-–—]\s*(\d+)\s*$", rng or "")
    if m:
        return int(m.group(1)), int(m.group(2))
    m = re.match(r"\s*(\d+)\s*$", rng or "")
    if m:
        return int(m.group(1)), int(m.group(1))
    return 0, 0


def _fill_answers_for(g: dict, q1: int, q2: int) -> list[str]:
    """
    取该填空题组的答案列表 (按 Q 序)。

    答案由 parse_answers 挂在组上 (见 build_markdown 里的回填);
    没有时回落到全局答案表, 按 (module, qno) 取。
    """
    out = g.get("answers") or []
    if out:
        return [a["a"] if isinstance(a, dict) else str(a) for a in out]
    return []


def _render_group(subj: str, module: int, g: dict, ansmap: dict,
                  part: int = 1) -> list[str]:
    L: list[str] = []
    L.append(f"#### {_group_title(g)}")
    L.append("")

    if g.get("instruction"):
        L.append(f"> 任务指令：{g['instruction']}")
        L.append("")

    if g.get("passage"):
        title = g.get("title") or "passage"
        # 填空题组: 同时给"空白版"(做题) 和"答案版"(对答案/背词)。
        # 下划线格数与字母线索是命题人给的做题提示, 两版都原样保留。
        filled, rep = (None, [])
        if g.get("kind") == "fill_in_blank" and g.get("q_range"):
            q1, q2 = _parse_qrange(g["q_range"])
            if q1:
                filled, rep = fill_answers(
                    g["passage"], _fill_answers_for(g, q1, q2))
        if filled and filled.strip() != g["passage"].strip():
            L.append("<details open>")
            L.append(f"<summary>材料原文（{title}）· 空白版</summary>")
            L.append("")
            L.append(g["passage"])
            L.append("")
            L.append("</details>")
            L.append("")
            L.append("<details open>")
            L.append(f"<summary>材料原文（{title}）· 答案版</summary>")
            L.append("")
            L.append(filled)
            L.append("")
            L.append("</details>")
            L.append("")
            if rep:
                L.append("**逐空对照**")
                L.append("")
                L.append("| 题 | 线索 | 格数 | 答案 | 状态 |")
                L.append("|---|---|---|---|---|")
                for r in rep:
                    qno = q1 + r["no"] - 1 if q1 else r["no"]
                    L.append(f"| Q{qno} | `{r['clue'] or '—'}` | {r['blanks']} "
                             f"| {md_escape(r['answer']) or '—'} "
                             f"| {'✅' if r['filled'] else '⚠ ' + r.get('why', '')} |")
                L.append("")
        else:
            L.append("<details>")
            L.append(f"<summary>材料原文（{title}）</summary>")
            L.append("")
            L.append(g["passage"])
            L.append("")
            L.append("</details>")
            L.append("")
    elif g.get("passage_image"):
        # 素材把材料做成了截图 (邮件/影评/短信/通知), 文字层里没有正文。
        # 这时必须说清"原文待识别", 而不是留空 —— 留空会被误当成
        # "这篇没有材料", 题库就废了。
        L.append("> 🖼 **材料原文待识别** — 素材里这一段是截图"
                 f"（{g.get('instruction') or g.get('title') or '材料'}），"
                 "文字层未提供正文。")
        L.append("")

    for q in g["questions"]:
        i = unique_qid(qid(subj, module, q["no"], part=part))
        L.append(f'<a id="{anchor(i)}"></a>')
        L.append("")
        # "Choose the best response." 这类选答题本来就没有题干 (题干是听力),
        # 不要写"(无题干，见选项)"这种占位话 —— 直接只给选项。
        stem = (q.get("stem") or "").strip()
        L.append(f"##### {i} · {stem}" if stem else f"##### {i}")
        L.append("")
        if q.get("options"):
            for k in sorted(q["options"]):
                L.append(f"- **{k}.** {q['options'][k]}")
            L.append("")
        # 音频锚: 题目 -> 音频。素材未提供逐题时间戳, 这里只给文件名+覆盖题号。
        au = q.get("audio")
        if au:
            shared = _is_shared(g, au)
            note = "（本段共用）" if shared else ""
            L.append(f"🔊 音频：[`{os.path.basename(au)}`]{note}")
            L.append("")
        # 原文锚: 题目 -> 听力原文。
        # 只有听力题才该有原文回链 —— 阅读/写作/口语挂听力原文是错的。
        tref = (_transcript_ref(module, q["no"])
                if subj == "listening" else None)
        if tref:
            L.append(f"📄 原文：[`{tref}`](#{tref})")
            L.append("")
        a = ansmap.get((module, q["no"]))
        if a:
            L.append(f"✅ 参考答案：**{a}**")
            L.append("")

    return L


def _is_shared(g: dict, audio: str) -> bool:
    return len([q for q in g["questions"] if q.get("audio") == audio]) > 1


def _module_audio_hint(audio: list[dict], module: int) -> list[dict]:
    """
    找出属于某个模块的**整段音频**。

    图片版素材的音频不是逐题的 (没有题号), 而是按 part 分成的整段 m4a:
        3.15 听力part1/3.15 听力part1.m4a      -> Module 1
        3.15  听力 part2/3.15 听力 part2.m4a   -> Module 2
    判据: 文件名里带 part1/part2 或 m1/m2, 否则带 module 号。
    对不上就不挂 —— 宁可不给音频, 也不给出错的音频。
    """
    out = []
    for a in audio or []:
        f = (a.get("file") or "").lower()
        base = f.rsplit("/", 1)[-1]
        if not base.endswith((".mp3", ".m4a", ".wav", ".ogg")):
            continue
        want = None
        if re.search(r"part\s*0?1|m1\b|module\s*1", base):
            want = 1
        elif re.search(r"part\s*0?2|m2\b|module\s*2", base):
            want = 2
        if want == module:
            out.append(a)
    return out


def _render_task(subj: str, t: dict, ansmap: dict) -> list[str]:
    L: list[str] = []
    typ = t.get("type", "") or t.get("task", "")
    title = t.get("title", "")
    L.append(f"### {title or typ}")
    L.append("")

    if t.get("prompt_lines"):
        for p in t["prompt_lines"]:
            L.append(f"> {p}")
        L.append("")

    # 写作: 邮件 / 学术讨论 —— 题面是一整段任务说明
    if typ in ("email", "academic_discussion"):
        if t.get("instruction"):
            L.append(f"> {t['instruction']}")
            L.append("")
        if t.get("task"):
            for ln in str(t["task"]).splitlines():
                ln = ln.strip()
                if not ln:
                    continue
                if ln.startswith("- "):
                    L.append(f"> {ln}")
                else:
                    L.append(f"> {ln}")
            L.append("")
        extra = []
        if t.get("audience"):
            extra.append(f"**收件人**：{t['audience']}")
        if t.get("subject_line"):
            extra.append(f"**主题**：{t['subject_line']}")
        if t.get("author"):
            extra.append(f"**出题人**：{t['author']}")
        if t.get("prompt"):
            extra.append(f"**题目**：{t['prompt']}")
        for e in extra:
            L.append(f"- {e}")
        if extra:
            L.append("")
        for resp in t.get("responses", []):
            L.append(f"> **{resp.get('speaker', '')}**：{resp.get('text', '')}")
            L.append("")
        return L

    # 写作句子建构: OCR 版用 items[context/pattern/bank], 文字版用 sentences[]
    items = t.get("items") or []
    if items and items[0].get("context") is not None:
        for it in items:
            i = unique_qid(qid(subj, 0, it["no"], "C"))
            L.append(f'<a id="{anchor(i)}"></a>')
            L.append("")
            L.append(f"##### {i}")
            L.append("")
            if it.get("context"):
                L.append(f"- **语境**：{it['context']}")
            if it.get("pattern"):
                L.append(f"- **待填句型**：`{it['pattern']}`")
            if it.get("bank"):
                L.append(f"- **词库**：{it['bank']}")
            L.append("")
        return L

    if typ == "sentence_construction":
        for s in t.get("sentences", []):
            i = unique_qid(qid(subj, 0, s["no"], "C"))
            L.append(f'<a id="{anchor(i)}"></a>')
            L.append("")
            L.append(f"##### {i}")
            L.append("")
            if s.get("context"):
                L.append(f"- **语境**：{s['context']}")
            if s.get("response_slots"):
                L.append(f"- **待填句型**：`{s['response_slots']}`")
            if s.get("word_bank"):
                L.append(f"- **词库**：{' / '.join(s['word_bank'])}")
            L.append("")
        return L

    if t.get("instruction"):
        L.append(f"> {t['instruction']}")
        L.append("")
    if t.get("note"):
        L.append(f"> ⚠ {t['note']}")
        L.append("")

    for instruction in t.get("instructions", []):
        L.extend(["> " + instruction, ""])
    if t.get("material_note"):
        L.extend(["> ⚠ " + t["material_note"], ""])
    tkey = re.sub(r"\s+", "", t.get("task", "T")) or "T"
    for it in t.get("items", []):
        i = unique_qid(qid(subj, 0, it["no"], tkey))
        L.append(f'<a id="{anchor(i)}"></a>')
        L.append("")
        head = f"##### {i}"
        if it.get("stem"):
            head += f" · {it['stem']}"
        L.append(head)
        L.append("")
        if it.get("prompt") and it["prompt"] != "Listen and repeat only once.":
            L.append(f"{it['prompt']}")
            L.append("")
        if it.get("visual"):
            L.append(f"> 🖼 {it['visual']}")
            L.append("")
        for k, v in (it.get("options") or {}).items():
            L.append(f"- **{k}.** {v}")
        if it.get("options"):
            L.append("")
        if it.get("audio"):
            L.append(f"🔊 音频：[`{os.path.basename(it['audio'])}`]" + (" · 整段未分段" if it.get("audio_module_level") else ""))
        elif it.get("audio_issue"):
            L.append("> ⚠ " + it["audio_issue"])
            L.append("")
        a = ansmap.get((0, it["no"]))
        if a:
            L.append(f"✅ 参考答案：**{a}**")
            L.append("")
    return L


# ------------------------------------------------------------------ 答案节

def _render_answers(answers: dict, answer_texts: dict, set_id: str) -> list[str]:
    L: list[str] = []
    for subj in SUBJ_ORDER:
        ans = answers.get(subj)
        if not ans:
            continue
        L.append(f"### {SUBJ_CN[subj]} 答案")
        L.append("")
        L.append("<details>")
        L.append("<summary>展开答案表</summary>")
        L.append("")
        for mod, lst in ans.items():
            if not lst:
                continue
            mname = "Module 1" if mod == "module1" else "Module 2（加试）"
            L.append(f"**{mname}**")
            L.append("")
            # 表格形式便于 AI 稳定解析
            L.append("| 题号 | 答案 |")
            L.append("|---|---|")
            for it in lst:
                L.append(f"| {it['q']} | {md_escape(str(it['a']))} |")
            L.append("")
        L.append("</details>")
        L.append("")

    # 听力原文
    # 只认 listening 学科: 有些答案文件没有按学科分节, 整份文本会被
    # 复制进四个学科的 answer_texts, 若逐个学科都渲染, 同一段原文会
    # 在文里出现 4 次, 锚点也跟着重复 4 次。
    tr = split_transcript(answer_texts.get("listening", "") or "")
    if tr.get("segments"):
        L.append("### 听力原文 Listening Transcript")
        L.append("")
        for s in tr["segments"]:
            L.append(f'<a id="tr-m{s["module"]}-q{s["q1"]}"></a>')
            L.append("")
            L.append(f"**Module {s['module']} · Q{s['q1']}"
                     + (f"-{s['q2']}" if s['q2'] != s['q1'] else "")
                     + f" — {s['title']}**")
            L.append("")
            for ln in s["lines"]:
                L.append(f"> {ln}")
                L.append(">")
            L.pop()
            L.append("")
    return L
