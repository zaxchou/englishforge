#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
主流程 (pipeline)

    素材目录 -> 盘点 -> 抽文本/图片 -> 解析题目 -> 装配 Markdown -> 校验

对"文字版"素材 (docx/pdf 内含文本层) 全自动, 直接出 Markdown。
对"图片版"素材 (题目是扫描图) 先抽图, 由 transcribe 阶段识别后回填,
没有识别结果时会在 Markdown 里标注 [待识别] 并给出图片索引, 不阻塞整批。

用法:
    python pipeline.py --root <素材根> --out output [--only 2026-06-22] [--force]
"""

from __future__ import annotations
import argparse
import os
import json
import re
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from extract import docx_text, pdf_text, ffprobe_duration, IMAGE_EXT  # noqa: E402
from parse_questions import parse_subject, summarize                  # noqa: E402
from build_markdown import render_set, SUBJ_ORDER, SUBJ_CN           # noqa: E402
from scan_manifest import classify_subject                            # noqa: E402
import scan_manifest                                                  # noqa: E402
from audio_integrity import audio_subject, sanitize_speaking

AUDIO_EXT = {".m4a", ".mp3", ".ogg", ".wav"}
VIDEO_EXT = {".mp4", ".mov", ".ts"}
DOC_EXT = {".pdf", ".docx"}
# 明显不是题目正文
JUNK_RE = re.compile(r"评分|标准|课程|词汇|语法|网课|一览|汇总", re.I)

# item_level 逐题音频文件名自带题号区间: listening_m1_q07_q08_conversation_xxx.mp3
RE_AUDIO_ITEM = re.compile(
    r"^listening_m(\d+)_q(\d+)(?:_q(\d+))?_", re.I)

# 时长超过该秒数的音频视为"整段"（整个听力部分一条录音，无题级切点）
WHOLE_AUDIO_SEC = 900


def _norm_ans(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def normalize_answers(rec: dict) -> None:
    """官方答案表统一清洗（输出前必跑）：
    1. choice: 只留合法形态——单字母（容忍尾标点 'B.' 'C;'）或「完整选项
       文本」（须与该科目某选项 norm 相等，如 07-13 的陈述句型键）；
       其余（'Q'、'| Ant Mandibles...' 等解析垃圾）删除。
    2. fill: 去掉 '数字+空格' 题号前缀（'1 losses'->'losses'）与尾标点。
    3. 组内 answers 同样清洗后与顶层**双向修补**：两边取干净的，
       组内缺的从顶层补、顶层错的以组内正的覆盖。
    4. questions 按 no 排序（解析顺序偶有乱序，如 06-08 [23,25,24]）。
    清洗后仍缺失的题，前端如实显示「缺官方答案」，不虚构。"""
    # 选项文本索引: (subj, mk) -> set(norm 文本)
    opt_texts: dict[tuple, set] = {}
    for subj, sub in rec.get("subjects", {}).items():
        for m in sub.get("modules", []):
            mk = "m" + str(m.get("module"))
            for g in m.get("groups", []):
                for q in g.get("questions", []):
                    for v in (q.get("options") or {}).values():
                        opt_texts.setdefault((subj, mk), set()).add(_norm_ans(v))

    def clean_choice(v: str, subj: str, mk: str):
        v = (v or "").strip()
        m = re.fullmatch(r"\(?([A-Da-d])[\.\);\s]*", v)
        if m:
            return m.group(1).upper()
        if _norm_ans(v) in opt_texts.get((subj, mk), ()):
            return v
        # 跨题切割残留: 'D; 17' / 'A. 24' —— 首字母 + 标点/题号碎片
        m = re.match(r"^\(?([A-Da-d])[\.\);\]]+\s*[,;]?\s*\d{0,2}\s*[\.。]?$", v)
        if m:
            return m.group(1).upper()
        return None

    def clean_fill(v: str):
        v = re.sub(r"^\d{1,2}\s+", "", (v or "").strip())
        return v.rstrip(".。;；、, ").strip()

    answers = rec.setdefault("answers", {})
    # 题面实际题型: (subj, mk, no) -> 'fill' | 'choice'。答案条目的 kind 字段
    # 可能标错（'D; 17' 被标成 fill），清洗以题面为准。
    qtype: dict[tuple, str] = {}
    for subj, sub in rec.get("subjects", {}).items():
        for m in sub.get("modules", []):
            mk = "m" + str(m.get("module"))
            for g in m.get("groups", []):
                k = "fill" if g.get("kind") == "fill_in_blank" else "choice"
                for q in g.get("questions", []):
                    qtype[(subj, mk, q.get("no"))] = k
    for subj, mods in list(answers.items()):
        for mod, lst in mods.items():
            mk_short = "m" + mod.replace("module", "")   # module1 -> m1, 与 qtype/opt_texts 键一致
            out = []
            for a in lst:
                q = a.get("q")
                v = a.get("a")
                if not isinstance(q, int) or v is None:
                    continue
                kind = qtype.get((subj, mk_short, q), a.get("kind") or "choice")
                if kind == "fill":
                    v2 = clean_fill(v)
                    if v2:
                        out.append({"q": q, "a": v2, "kind": "fill"})
                else:
                    v2 = clean_choice(v, subj, mk_short)
                    if v2:
                        out.append({"q": q, "a": v2, "kind": "choice"})
            answers[subj][mod] = out

    # 组内 answers 清洗 + 双向修补
    for subj, sub in rec.get("subjects", {}).items():
        for m in sub.get("modules", []):
            amk = "module" + str(m.get("module"))
            mk = "m" + str(m.get("module"))
            for g in m.get("groups", []):
                is_fill = g.get("kind") == "fill_in_blank"
                ga = g.get("answers")
                if ga:
                    out = []
                    for a in ga:
                        no = a.get("no")
                        v = a.get("a")
                        if no is None or v is None:
                            continue
                        v2 = clean_fill(v) if is_fill else clean_choice(v, subj, mk)
                        if v2:
                            out.append({"no": no, "a": v2})
                    g["answers"] = out
                # 双向修补（仅 fill 组带组内 answers）
                if is_fill and g.get("answers"):
                    start = None
                    for q in g.get("questions", []):
                        pass
                    top = {a.get("q"): a.get("a") for a in answers.get(subj, {}).get(amk, [])
                           if a.get("kind") == "fill"}
                    # 组起点: q_range 首号
                    gk = str(g.get("q_range") or "")
                    m0 = re.match(r"^(\d+)", gk)
                    start = int(m0.group(1)) if m0 else 1
                    byno = {a.get("no"): a.get("a") for a in g["answers"]}
                    for i, no in enumerate(range(start, start + len(g["answers"]))):
                        mine = byno.get(no)
                        theirs = top.get(no)
                        if mine is None and theirs is not None:
                            byno[no] = theirs
                        elif mine is not None and theirs is not None and _norm_ans(mine) != _norm_ans(theirs):
                            # 择净: 无题号前缀、非空者胜（两者已清洗, 组内优先）
                            top[no] = mine
                    g["answers"] = [{"no": k, "a": v} for k, v in sorted(byno.items())]
                    merged = dict(top)
                    merged.update({a["no"]: a["a"] for a in g["answers"]})
                    answers.setdefault(subj, {}).setdefault(amk, [])
                    have = {a.get("q") for a in answers[subj][amk] if a.get("kind") == "fill"}
                    for no, v in merged.items():
                        if no not in have:
                            answers[subj][amk].append({"q": no, "a": v, "kind": "fill"})
                    answers[subj][amk] = [
                        ({"q": a["q"], "a": merged.get(a["q"], a["a"]), "kind": "fill"}
                         if a.get("kind") == "fill" else a)
                        for a in answers[subj][amk]]
            # 题号排序
            for g in m.get("groups", []):
                qs = g.get("questions")
                if qs and all(isinstance(q.get("no"), int) for q in qs):
                    qs.sort(key=lambda q: q["no"])


def remap_listening_audio(rec: dict) -> int:
    """音频↔题目对应修复（三步）：
    1. 逐题音频按文件名题号区间重映射——文件可能在任意目录（audio/item_level/
       或 音频/），按 basename 索引；题面自带的 Audio: 行路径常与实际不符。
    2. 剩余引用做路径改写：basename 存在于素材里但相对路径不同 → 改写为实际
       路径（听力与口语都处理）。
    3. 整段判定：题目引用的音频时长 > WHOLE_AUDIO_SEC（整套听力一条录音）→
       从题上摘除，改挂组级 audio_module_level，如实标注，不伪造题级切点。
    返回改动条数。"""
    n = 0
    lst = rec["subjects"].get("listening")
    # basename -> 音频记录（同名取第一个）
    idx: dict[str, dict] = {}
    for a in rec.get("audio", []):
        b = a["file"].replace("\\", "/").rsplit("/", 1)[-1].lower()
        idx.setdefault(b, a)

    # ---- 1) 文件名题号区间逐题映射 ----
    by_mod: dict[int, list[tuple[int, int, str]]] = {}
    for b, a in idx.items():
        m = RE_AUDIO_ITEM.match(b)
        if m:
            mod, q1 = int(m.group(1)), int(m.group(2))
            q2 = int(m.group(3) or m.group(2))
            by_mod.setdefault(mod, []).append((q1, q2, a["file"]))
    if lst and by_mod:
        for mod in lst.get("modules", []):
            ranges = by_mod.get(int(mod.get("module", 0)), [])
            if not ranges:
                continue
            for g in mod.get("groups", []):
                for q in g.get("questions", []):
                    try:
                        no = int(q.get("no", 0))
                    except (TypeError, ValueError):
                        continue
                    for q1, q2, f in ranges:
                        if q1 <= no <= q2:
                            if q.get("audio") != f:
                                q["audio"] = f
                                n += 1
                            break

    # ---- 2) 路径改写（听力 + 口语）：basename 存在但路径不同 ----
    def fix_path(ref: str | None) -> str | None:
        if not ref:
            return ref
        rp = ref.replace("\\", "/")
        b = rp.rsplit("/", 1)[-1].lower()
        if b in idx and idx[b]["file"] != rp:
            return idx[b]["file"]
        return ref
    if lst:
        for mod in lst.get("modules", []):
            for g in mod.get("groups", []):
                fixed_group = fix_path(g.get("audio"))
                if fixed_group != g.get("audio"):
                    g["audio"] = fixed_group
                    n += 1
                for q in g.get("questions", []):
                    fixed = fix_path(q.get("audio"))
                    if fixed != q.get("audio"):
                        q["audio"] = fixed
                        n += 1
    for t in rec.get("subjects", {}).get("speaking", {}).get("tasks", []):
        for it in t.get("items", []):
            fixed = fix_path(it.get("audio"))
            if fixed != it.get("audio"):
                it["audio"] = fixed
                n += 1

    # ---- 3) 整段音频：从题上摘除，挂组级 ----
    if lst:
        for mod in lst.get("modules", []):
            for g in mod.get("groups", []):
                qs = g.get("questions", [])
                if not qs:
                    continue
                auds = {q.get("audio") for q in qs if q.get("audio")}
                if len(auds) != 1:
                    continue
                f = next(iter(auds))
                meta = idx.get(f.replace("\\", "/").rsplit("/", 1)[-1].lower())
                dur = (meta or {}).get("duration_sec") or 0
                if dur > WHOLE_AUDIO_SEC:
                    for q in qs:
                        if q.get("audio"):
                            q["audio"] = None
                            n += 1
                    # 组级音频可能来自题面 Audio: 行（同一整段文件）——
                    # 无论谁先挂的, 都要如实标注"整段未分段"
                    if g.get("audio") != f or not g.get("audio_module_level"):
                        g["audio"] = f
                        g["audio_module_level"] = True
                        n += 1

    # ---- 4) 兜底: 整段 part 音频 (无题号切点) 按路径里的 partN/mN 挂到缺音频的模块 ----
    # 03-15 这类套题只有 "3.15 听力part1.m4a" 整段文件; JSON 不存音频清单,
    # 题面也没有 Audio: 行。如实挂到模块级 (audio_module_level), 不伪造题级切点。
    whole = [a["file"] for a in rec.get("audio", [])
             if "/item_level/" not in a["file"].replace("\\", "/")
             and a["ext"] in AUDIO_EXT and audio_subject(a["file"]) == "listening"]
    if whole and lst:
        for mod in lst.get("modules", []):
            qs = [q for g in mod.get("groups", [])
                  for q in g.get("questions", [])]
            if not qs or any(q.get("audio") for q in qs):
                continue
            if any(g.get("audio") for g in mod.get("groups", [])):
                continue
            try:
                mno = int(mod.get("module", 0))
            except (TypeError, ValueError):
                continue
            hit = None
            for f in whole:
                low = f.lower()
                if re.search(r"part\s*0*%d(?!\d)" % mno, low) or \
                   re.search(r"\bm\s*0*%d(?!\d)" % mno, low):
                    hit = f
                    break
            if hit:
                for g in mod.get("groups", []):
                    if not g.get("audio"):
                        g["audio"] = hit
                        g["audio_module_level"] = True
    return n


def read_text(path: Path) -> str:
    if path.suffix.lower() == ".docx":
        return docx_text(path)
    if path.suffix.lower() == ".pdf":
        return pdf_text(path)
    return ""


def collect_audio(abs_dir: Path) -> list[dict]:
    """收集目录及子目录下的音频, 标注时长。"""
    out = []
    for p in sorted(abs_dir.rglob("*")):
        if not p.is_file() or p.name.startswith("._"):
            continue
        if p.suffix.lower() not in (AUDIO_EXT | VIDEO_EXT):
            continue
        rec = {"file": str(p.relative_to(abs_dir)).replace("\\", "/"),
               "path": str(p), "ext": p.suffix.lower(),
               "size": p.stat().st_size}
        if p.suffix.lower() in AUDIO_EXT:
            rec["duration_sec"] = ffprobe_duration(p)
        out.append(rec)
    return out


def doc_has_text(path: Path) -> bool:
    return len(read_text(path).strip()) > 80


def apply_material_notes(rec):
    notes_path = HERE / 'material-notes.json'
    notes = json.loads(notes_path.read_text(encoding='utf8')) if notes_path.exists() else {}
    note = notes.get(rec['set_id'])
    if note:
        for task in rec.get('subjects', {}).get('speaking', {}).get('tasks', []):
            task['material_note'] = note


def process_set(node: dict, out_root: Path, build: Path,
                skip_image: bool = True) -> dict:
    """处理单套题, 返回结果记录。"""
    set_id = node["set_id"]
    abs_dir = Path(node["abs_dir"])
    rec = {"set_id": set_id, "dir": node["dir"],
           "subjects": {}, "answers": {}, "answer_texts": {},
           "audio": collect_audio(abs_dir), "warnings": [], "pending_images": []}

    # ---- 题目 ----
    # 题面里可能没写 "Audio:" 行, 但目录里有 audio/, 先把清单备好做兜底关联
    audio_catalog = [a["file"] for a in rec["audio"]]
    for subject, bucket in node["subjects"].items():
        if subject == "unknown":
            # 整卷合并文件: 里面四科都有, 按学科分别再切一次
            for q in bucket["questions"]:
                text = read_text(Path(q["path"]))
                if not text.strip():
                    rec["pending_images"].append(
                        {"subject": "unknown", "file": q["file"]})
                    continue
                for sub in SUBJ_ORDER:
                    part = _slice_subject(text, sub)
                    if part:
                        rec["subjects"].setdefault(
                            sub, parse_subject(sub, part, audio_catalog))
            continue

        merged = None
        for q in bucket["questions"]:
            p = Path(q["path"])
            if not p.exists() or JUNK_RE.search(p.name):
                continue
            text = read_text(p)
            if not text.strip():
                rec["pending_images"].append(
                    {"subject": subject, "file": q["file"], "path": str(p)})
                continue
            parsed = parse_subject(subject, text, audio_catalog)
            merged = _merge(merged, parsed)
            # 阅读材料被存成截图时 (文字层只有题干), 登记为待识别,
            # 否则电子档里那段原文会一直是空的。
            if subject == "reading" and "[[IMG" in text:
                # 只有本轮仍缺原文时才登记待识别; OCR 补过的段落
                # 会在 _reapply_ocr 之后被识别出来, 不该重复报警。
                if not _reading_has_all_passages(merged):
                    rec["pending_images"].append(
                        {"subject": "reading-passage", "file": q["file"],
                         "path": str(p)})
        if merged:
            rec["subjects"][subject] = merged

    # ---- 答案 ----
    for subject, bucket in node["subjects"].items():
        for a in bucket["answers"]:
            p = Path(a["path"])
            if not p.exists():
                continue
            text = read_text(p)
            if not text.strip():
                rec["pending_images"].append(
                    {"subject": f"{subject}-answers", "file": a["file"], "path": str(p)})
                continue
            # 答案文件通常含四科, 全部切进来。
            # 注意: 学科切不出来时 (subject 已知但正文是整卷), 会把
            # 整份文本重复塞进每个学科, 导致听力原文被渲染多次、
            # 锚点重复。所以按内容去重, 并且只给"确实切得出该科"
            # 的学科写全文。
            for sub in SUBJ_ORDER:
                part = text if subject == "unknown" else _slice_subject(text, sub)
                if not part.strip():
                    continue
                prev = rec["answer_texts"].get(sub, "")
                if part.strip() and part.strip() not in prev:
                    rec["answer_texts"][sub] = (prev + "\n" + part).strip()
            parsed_all = _parse_answer_any(text)
            for sub, v in parsed_all.items():
                rec["answers"].setdefault(sub, {})
                for mod, lst in v.items():
                    rec["answers"][sub].setdefault(mod, [])
                    have = {x["q"] for x in rec["answers"][sub][mod]}
                    rec["answers"][sub][mod].extend(
                        [x for x in lst if x["q"] not in have])

    # ---- 输出 ----
    n_q = 0
    for s in SUBJ_ORDER:
        if s in rec["subjects"]:
            n_q += _count_subject_q(rec["subjects"][s])
    rec["question_count"] = n_q

    out_dir = out_root / set_id
    out_dir.mkdir(parents=True, exist_ok=True)

    # 复用上一轮已识别的材料: 本轮从素材重新解析会丢掉 OCR 回填的
    # 阅读原文 (素材里那部分是截图, 文字层没有), 所以先把上轮结果
    # 读出来, 等解析完再贴回去。
    prior = None
    jpath = out_dir / f"{set_id}.json"
    if jpath.exists():
        try:
            prior = json.loads(jpath.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            prior = None
    if prior:
        _reapply_ocr(rec["subjects"], prior.get("subjects", {}))

    # 再叠一层本轮的识别结果 (build/ocr/*.json)。
    # 必须在渲染前做完: 否则 Markdown 仍会输出"材料原文待识别",
    # 而 JSON 里其实已经有文字了 —— 两者不一致。
    ocr_dir = build / "ocr"
    if ocr_dir.exists():
        from transcribe import _fill_reading_passages
        for jf in sorted(list(ocr_dir.glob("*.json"))
                         + list(ocr_dir.glob("*.jsonl"))):
            try:
                rows = ([json.loads(l) for l in
                         jf.read_text(encoding="utf-8").splitlines() if l.strip()]
                        if jf.suffix == ".jsonl"
                        else [json.loads(jf.read_text(encoding="utf-8"))])
            except Exception:  # noqa: BLE001
                continue
            for r in rows:
                if r.get("set_id") != set_id:
                    continue
                if r.get("subject") == "listening" and r.get("groups"):
                    rec["subjects"]["listening"] = _merge_ocr_listening(
                        rec["subjects"].get("listening"), r)
                if r.get("subject") == "writing" and r.get("tasks"):
                    rec["subjects"]["writing"] = _merge_ocr_writing(
                        rec["subjects"].get("writing"), r)
                if r.get("subject") == "speaking" and r.get("tasks"):
                    rec["subjects"]["speaking"] = _merge_ocr_speaking(
                        rec["subjects"].get("speaking"), r)
                if r.get("subject") == "reading" and r.get("modules"):
                    rd = rec["subjects"].get("reading")
                    rec["subjects"]["reading"] = _merge_ocr_reading(rd, r)
                if r.get("subject") == "answers-image" and r.get("answers"):
                    # 扫描版答案: 整份 Answers.docx 是截图, 靠识别回填。
                    # 官方答案优先级最高, 直接覆盖文字层解析出的部分。
                    for subj, mods in r["answers"].items():
                        tgt = rec["answers"].setdefault(subj, {})
                        for mod, lst in mods.items():
                            tgt[mod] = list(lst)
                if r.get("subject") == "reading-passage" and r.get("passages"):
                    rd = rec["subjects"].get("reading")
                    if rd:
                        rec["subjects"]["reading"] = _fill_reading_passages(
                            rd, r["passages"])
                        if _reading_has_all_passages(rd):
                            rec["pending_images"] = [
                                p for p in rec["pending_images"]
                                if p.get("subject") != "reading-passage"]

    # ---- 逐题音频重映射（在 OCR 回填/答案合并之后, 输出之前） ----
    remap_listening_audio(rec)
    sanitize_speaking(rec, abs_dir)
    from audio_integrity import apply_audio_evidence
    apply_audio_evidence(rec, abs_dir)
    apply_material_notes(rec)
    from static_references import enrich_references
    enrich_references(rec, [a["file"] for bucket in node["subjects"].values() for a in bucket["answers"]], [a["path"] for bucket in node["subjects"].values() for a in bucket["answers"]])
    normalize_answers(rec)

    # ---- 题量必须在 OCR 回填之后重算 ----
    # 早前在"输出"段之前算了一次, 那时识别结果还没合进来, 于是图片版套题
    # 一律 question_count=0 (实际 subjects 里已有 47+20+10+11=88 题)。
    # 后果: pipeline 打印"题 0"、INDEX 显示 0 题、下游按这个字段统计全错。
    n_q = 0
    for s in SUBJ_ORDER:
        if s in rec["subjects"]:
            n_q += _count_subject_q(rec["subjects"][s])
    rec["question_count"] = n_q

    md = render_set(set_id, node["dir"], rec["subjects"], rec["answers"],
                    rec["answer_texts"], rec["audio"], str(abs_dir))
    # audio 只在渲染时用, 不进 JSON (体积大且能从 manifest 重建);
    # 但题量必须写进去, 索引直接读这个字段。
    _write_text(out_dir / f"{set_id}.md", md)
    _write_text(out_dir / f"{set_id}.json",
                json.dumps({k: v for k, v in rec.items() if k != "audio"},
                           ensure_ascii=False, indent=2))

    return rec


def _reading_has_all_passages(reading: dict | None) -> bool:
    """该套阅读是否每段材料都有正文 (文字层或 OCR 都算)。"""
    if not reading:
        return True
    for m in reading.get("modules", []):
        for g in m.get("groups", []):
            if g.get("passage_image") and not g.get("passage"):
                return False
    return True


def _merge_ocr_listening(cur: dict | None, r: dict) -> dict:
    """
    把图片版听力识别结果并入结构化数据。

    图片版的听力是**整份截图**, 文字层里什么都没有, 所以这里不是"补漏"
    而是"从零建结构": 按识别出的题型分组 (choose_response / conversation /
    announcement / lecture), 每组带题号区间与逐题选项。
    """
    out = cur or {"subject": "listening", "modules": []}
    # 识别结果可能带 module2 (加试), 也可能直接在 groups 里给 M1
    blocks = [{"module": r.get("module", 1), "groups": r.get("groups", [])}]
    if r.get("module2"):
        blocks.append({"module": 2, "groups": r["module2"]["groups"]})
    for blk in blocks:
        mod_no = int(blk["module"])
        mod = next((m for m in out["modules"] if m.get("module") == mod_no),
                   None)
        if mod is None:
            mod = {"module": mod_no, "part": 1, "groups": []}
            out["modules"].append(mod)
        for g in blk["groups"]:
            qs = []
            for it in g.get("items", []):
                q = {"no": it["no"], "stem": it.get("stem", "")}
                if it.get("options"):
                    q["options"] = it["options"]
                if it.get("audio"):
                    q["audio"] = it["audio"]
                qs.append(q)
            if not qs:
                continue
            mod["groups"].append({
                "kind": g.get("kind", "multiple_choice"),
                "q_range": g.get("q_range", ""),
                "title": g.get("title", ""),
                "passage": g.get("passage", ""),
                "questions": qs,
                "source": "ocr",
            })
    for m in out["modules"]:
        for g in m["groups"]:
            nums = [q["no"] for q in g["questions"]]
            if nums and not g.get("q_range"):
                g["q_range"] = (f"{min(nums)}-{max(nums)}"
                                if min(nums) != max(nums) else str(min(nums)))
    return out


def _merge_ocr_reading(cur: dict | None, r: dict) -> dict:
    """把图片版阅读识别结果并入 (按 module 分组, 保留 ▢ 挖空标记)。"""
    out = cur or {"subject": "reading", "modules": []}
    for m in r.get("modules", []):
        mod_no = int(m.get("module", 1))
        mod = next((x for x in out["modules"] if x.get("module") == mod_no), None)
        if mod is None:
            mod = {"module": mod_no, "part": 1, "groups": []}
            out["modules"].append(mod)
        for g in m.get("groups", []):
            qs = [{"no": it["no"], "stem": it.get("stem", ""),
                   "options": it.get("options", {})} for it in g.get("items", [])]
            mod["groups"].append({
                "kind": g.get("kind", "multiple_choice"),
                "q_range": g.get("q_range", ""),
                "title": g.get("title", ""),
                "instruction": g.get("instruction", ""),
                "passage": g.get("passage", ""),
                "questions": qs,
                "source": "ocr",
            })
    return out


def _merge_ocr_writing(cur: dict | None, r: dict) -> dict:
    """图片版写作: 题面在截图里, 整段搬进来。
    注意: 解析器会先从(极短的)文字层造出同名任务的空壳, 所以同名时
    不能跳过 —— 必须**字段级覆盖**, 否则 OCR 的 items/pattern/bank
    永远进不来, data 里留的是空壳甚至陈旧的错误内容。"""
    out = cur or {"subject": "writing", "tasks": []}
    for t in r.get("tasks", []):
        items = []
        for it in t.get("items", []):
            it = dict(it)
            # OCR json 用 pattern/bank, 统一成前端约定的 response_slots/word_bank
            if it.get("pattern") and not it.get("response_slots"):
                it["response_slots"] = it.pop("pattern")
            if it.get("bank") and not it.get("word_bank"):
                it["word_bank"] = [x.strip() for x in str(it.pop("bank")).split("/")]
            items.append(it)
        payload = {
            "type": t.get("type", "unknown"),
            "title": t.get("title", ""),
            "source": "ocr",
            "items": items,
            "instruction": t.get("instruction", ""),
            "task": t.get("task", ""),
            "prompt": t.get("prompt", ""),
            "author": t.get("author", ""),
            "responses": t.get("responses", []),
            "subject_line": t.get("subject", ""),
            "audience": t.get("audience", ""),
        }
        # email / academic_discussion 的题面在任务级字段 (count=1, 无逐条 items):
        # 规范化成前端认识的 prompt_lines/body/items 形态。
        if not payload["items"] and payload["type"] in ("email", "academic_discussion"):
            pl, body = [], []
            if payload["instruction"]:
                pl.append(payload["instruction"])
            if payload["task"]:
                pl.append(payload["task"])
            if payload["type"] == "email":
                body = [f"To: {payload['audience'] or '(收件人)'}",
                        f"Subject: {payload['subject_line'] or '(主题)'}"]
                body += ["_" * 72] * 6
            else:
                if payload["prompt"]:
                    body.append(f"{payload['author'] or 'Professor'}: {payload['prompt']}")
                for rsp in payload.get("responses", []):
                    body.append(f"{rsp.get('speaker','')}: {rsp.get('text','')}")
            payload["prompt_lines"] = pl
            payload["body"] = body
            payload["items"] = [{"no": 1}]
        hit = next((x for x in out["tasks"] if x.get("type") == payload["type"]), None)
        if hit:
            hit.update({k: v for k, v in payload.items() if v})
        else:
            out["tasks"].append(payload)
    return out


def _merge_ocr_speaking(cur: dict | None, r: dict) -> dict:
    """图片版口语: 同写作, OCR 字段级覆盖; items 按题号对齐,
    audio 保留解析侧(文件名兜底)的结果, prompt/instruction 用 OCR 的。"""
    out = cur or {"subject": "speaking", "tasks": []}
    for t in r.get("tasks", []):
        hit = next((x for x in out["tasks"] if x.get("task") == t.get("task")), None)
        if hit is None:
            hit = {"task": t.get("task", ""), "items": []}
            out["tasks"].append(hit)
        hit.update({
            "title": t.get("title", "") or hit.get("title", ""),
            "source": "ocr",
            "instruction": t.get("instruction", "") or hit.get("instruction", ""),
            "note": t.get("note", ""),
        })
        by_no = {it.get("no"): it for it in t.get("items", []) if it.get("no") is not None}
        for it in hit.get("items", []):
            ocr = by_no.get(it.get("no"))
            if not ocr:
                continue
            if ocr.get("prompt"):
                it["prompt"] = ocr["prompt"]
            if ocr.get("visual"):
                it["visual"] = ocr["visual"]
            it["source"] = "ocr"
        # OCR 里有而解析侧没有的题 (题量差): 追加, 不丢题
        have_nos = {it.get("no") for it in hit.get("items", [])}
        for no, ocr in by_no.items():
            if no not in have_nos:
                hit["items"].append(dict(ocr, source="ocr"))
        hit["items"].sort(key=lambda x: x.get("no") or 0)
    return out


def _reapply_ocr(fresh: dict, prior: dict) -> None:
    """
    把上一轮 OCR 识别出的阅读材料贴回本轮解析结果。

    素材里阅读的邮件/影评/短信/通知是截图, 文字层没有, 所以每轮
    重新解析都会把这段原文判成"待识别"。若不贴回去, 识别白做了。
    按 (module, q_range) 精确对应, 贴不上的宁可不贴。
    """
    for subj, old in (prior or {}).items():
        cur = fresh.get(subj)
        if not cur or "modules" not in old or "modules" not in cur:
            continue
        for om, cm in zip(old["modules"], cur["modules"]):
            if om.get("module") != cm.get("module"):
                continue
            for og in om.get("groups", []):
                if og.get("passage_source") != "ocr" or not og.get("passage"):
                    continue
                for cg in cm.get("groups", []):
                    if cg.get("q_range") == og.get("q_range"):
                        cg["passage"] = og["passage"]
                        cg.pop("passage_image", None)
                        cg["passage_source"] = "ocr"
                        for k in ("instruction", "title"):
                            if og.get(k) and not cg.get(k):
                                cg[k] = og[k]
                        break


def _write_text(path: Path, text: str, retries: int = 3) -> bool:
    """Publish only to the canonical path. Never report an orphan timestamp copy as success."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        return True
    except OSError as e:
        raise OSError(f"题库未发布，原文件保留，待恢复临时文件 {tmp}: {e}") from e


def _slice_subject(text: str, subject: str) -> str:
    """从整卷文本里切出某一科 (按 TOEFL Reading/... 标题切)。"""
    cn = {"listening": "听力", "reading": "阅读",
          "writing": "写作", "speaking": "口语"}[subject]
    en = subject.capitalize()
    m = re.search(rf"^\s*TOEFL\s+{en}\s*$", text, re.I | re.M)
    if not m:
        return ""
    rest = text[m.end():]
    nxt = re.search(r"^\s*TOEFL\s+(Listening|Reading|Writing|Speaking)\s*$",
                    rest, re.I | re.M)
    return rest[:nxt.start()] if nxt else rest


def _parse_answer_any(text: str) -> dict:
    from extract import parse_answers
    return parse_answers(text)


def _merge(a: dict | None, b: dict) -> dict:
    if a is None:
        return b
    if "modules" in a and "modules" in b:
        a["modules"].extend(b["modules"])
    if "tasks" in a and "tasks" in b:
        a["tasks"].extend(b["tasks"])
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="素材根目录")
    ap.add_argument("--out", default="output", help="Markdown 输出目录")
    ap.add_argument("--build", default="build", help="中间产物目录")
    ap.add_argument("--only", nargs="*", help="只处理指定 set_id")
    ap.add_argument("--limit", type=int, help="最多处理几套")
    a = ap.parse_args()

    root = Path(a.root)
    build = Path(a.build)
    out_root = Path(a.out)
    build.mkdir(parents=True, exist_ok=True)
    out_root.mkdir(parents=True, exist_ok=True)

    # 1) 盘点
    mpath = build / "manifest.json"
    if not mpath.exists():
        print("[1/3] 盘点素材 ...")
        scan_manifest.scan(root, mpath)
    manifest = json.loads(mpath.read_text(encoding="utf-8"))
    nodes = manifest["sets"]
    if a.only:
        nodes = [n for n in nodes if n["set_id"] in set(a.only)]
    if a.limit:
        nodes = nodes[:a.limit]

    # 1.5) 先合并已有识别结果。
    # 顺序很关键: 识别结果是在上次跑的基础上标注的, 必须先合进来,
    # 再渲染 Markdown, 否则新材料要等下一轮才出现在电子档里。
    if (build / "ocr").exists():
        from transcribe import do_merge
        print("[1.5/3] 合并识别结果 ...")
        do_merge(build, out_root)

    # 2) 逐套处理
    print(f"[2/3] 处理 {len(nodes)} 套题 ...")
    results = []
    failed = []
    for n in nodes:
        try:
            rec = process_set(n, out_root, build)
            results.append(rec)
            warn = (f"  ⚠ 待识别 {len(rec['pending_images'])}"
                    if rec["pending_images"] else "")
            print(f"  ✓ {rec['set_id']:<22} 题 {rec['question_count']:>3} "
                  f"| 音频 {len(rec['audio']):>3} "
                  f"| 答案 {sum(1 for v in rec['answers'].values() if v)}{warn}")
        except Exception as e:  # noqa: BLE001
            failed.append(n['set_id'])
            print(f"  ✗ {n['set_id']:<22} {type(e).__name__}: {e}")
            traceback.print_exc(limit=2)

    # 3) 汇总 (先写临时文件再改名, 避免中途失败留下半个索引)
    idx = out_root / "INDEX.md"
    tmp = idx.with_suffix(".md.tmp")
    _write_index(tmp, results, manifest["root"])
    try:
        tmp.replace(idx)
    except (PermissionError, OSError):
        _write_index(idx.with_name("INDEX_v2.md"), results, manifest["root"])
        print("      (索引被占用, 改写 INDEX_v2.md)")
    total_q = sum(r["question_count"] for r in results)
    print(f"[3/3] 完成: {len(results)} 套, 共 {total_q} 题 -> {out_root}")
    print(f"      索引: {idx}")
    if failed:
        raise RuntimeError(f"有 {len(failed)} 套未发布: {failed}")


def _count_subject_q(p: dict) -> int:
    n = 0
    for m in p.get("modules", []):
        n += sum(len(g["questions"]) for g in m["groups"])
    for t in p.get("tasks", []):
        n += len(t.get("sentences", [])) + len(t.get("items", []))
    return n


SUBJ_SHORT = {"listening": "听", "reading": "读",
              "writing": "写", "speaking": "口"}


def _write_index(path: Path, results: list[dict], root: str):
    """
    生成题库总索引。

    这是"素材全部整理"后的入口文件: 一眼看清哪些套题已电子化、
    每套各科多少题、音频和答案是否齐全、哪些还差图片识别。
    """
    total_q = sum(r["question_count"] for r in results)
    done = [r for r in results if r["question_count"]]
    todo = [r for r in results if not r["question_count"]
            and r.get("pending_images")]

    L = [
        "# 托福真题题库索引",
        "",
        f"素材根目录：`{root}`  ",
        f"电子档目录：`{path.parent}`",
        "",
        "## 总览",
        "",
        "| 指标 | 数值 |",
        "|---|---|",
        f"| 套题总数 | {len(results)} |",
        f"| 已电子化 | **{len(done)}** |",
        f"| 已提取题量 | **{total_q}** |",
        f"| 待图片识别 | {len(todo)} |",
        "",
    ]

    # ---- 各科题量汇总 ----
    subj_total = {s: 0 for s in SUBJ_ORDER}
    for r in done:
        for s, p in r.get("subjects", {}).items():
            subj_total[s] = subj_total.get(s, 0) + _count_subject_q(p)
    L += ["| 科目 | 题量 | 已电子化套数 |", "|---|---|---|"]
    for s in SUBJ_ORDER:
        cnt = sum(1 for r in done if s in r.get("subjects", {})
                  and _count_subject_q(r["subjects"][s]) > 0)
        L.append(f"| {SUBJ_CN.get(s, s)} | {subj_total[s]} | {cnt} |")
    L.append("")

    # ---- 已电子化 ----
    L += ["## 已电子化套题", "",
          "| 套题 | 听 | 读 | 写 | 口 | 合计 | 音频 | 答案 | 原文 |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in sorted(done, key=lambda x: x["set_id"]):
        cells = []
        for s in SUBJ_ORDER:
            p = r.get("subjects", {}).get(s)
            n = _count_subject_q(p) if p else 0
            cells.append(str(n) if n else "—")
        n_ans = sum(1 for v in r["answers"].values() if v)
        n_tr = len(r.get("answer_texts", {}).get("listening", "")) > 2000
        L.append(f"| [{r['set_id']}](./{r['set_id']}/{r['set_id']}.md) "
                 f"| " + " | ".join(cells)
                 + f" | **{r['question_count']}** | {len(r['audio'])} "
                 f"| {n_ans}科 | {'有' if n_tr else '—'} |")
    L.append("")

    # ---- 待识别 ----
    if todo:
        L += ["## 待图片识别", "",
              "这些套题的题目是扫描图 / 截图, 没有文字层, "
              "需先 OCR 才能进题库。", "",
              "| 套题 | 待识别文件 | 音频 |", "|---|---|---|"]
        for r in sorted(todo, key=lambda x: x["set_id"]):
            files = "、".join(p.get("file", "")[:22]
                              for p in r["pending_images"][:3])
            L.append(f"| {r['set_id']} | {files} "
                     f"| {len(r['audio'])} |")
        L.append("")

    L += ["---", "",
          "## 每套题里有什么", "",
          "- **YAML front-matter** — 机器先读的元数据（套题ID/题量/音频数）",
          "- **音频索引表** — 文件名自带题号，与题目号一一对应",
          "- **题目** — 每题一个稳定 ID（`L1-Q13`/`R1-Q21`/`W-C3`/`S-TASK1-3`）",
          "- **三向回链** — 每题直接给出音频、听力原文、参考答案入口",
          "- **答案与原文** — 放在文末 `<details>` 折叠区，不与题干混排", ""]

    path.write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
