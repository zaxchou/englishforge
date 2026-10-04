#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""全量内容校验（程序化，不靠肉眼）。

对 data/ 下每一套每一科做规则校验，输出问题清单：
  A. 填空组：挖空数 == 组内答案数；线索+格数 与组内答案自洽（格数=词长-线索长，
     不自洽仅报告不阻断——文字层下划线是原题排版，原样保留原则）
  B. 选择组：官方答案 ∈ {A,B,C,D} 且对应选项存在
  C. 题号连续：每组 questions/no 从首号起连续无断档
  D. 三方答案一致：组内 answers vs 顶层 answers.<subject>.<module> 数量与取值
  E. 音频引用：题目/组引用的音频文件在源目录中真实存在
  F. 顶层答案异常值：答案值疑似非答案文本（含空格的长句出现在 choice 键位等）

用法: python verify_content.py --data <data> --build <build> [--set <id>]
退出码: 有 ERROR 级问题时为 1。
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

from audio_integrity import check_audio_ref

B = "\u25a2"


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def iter_groups(sub: dict):
    for m in sub.get("modules", []):
        for g in m.get("groups", []):
            yield m, g
    for t in sub.get("tasks", []):
        yield None, t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data")
    ap.add_argument("--build", default="build")
    ap.add_argument("--set", dest="only", default=None)
    args = ap.parse_args()
    data, build = Path(args.data), Path(args.build)

    mf = json.loads((build / "manifest.json").read_text(encoding="utf-8"))
    dirs = {s["set_id"]: s["abs_dir"] for s in mf["sets"]}

    # 音频文件索引（basename -> set 内相对路径集合）
    def audio_index(sid: str) -> dict:
        idx = {}
        base = Path(dirs.get(sid, ""))
        if not base.is_dir():
            return idx
        for p in base.rglob("*"):
            if p.suffix.lower() in (".mp3", ".m4a", ".wav", ".ogg"):
                idx.setdefault(p.name.lower(), []).append(p)
        return idx

    errors, warns = [], []
    sets = sorted([d for d in data.iterdir() if d.is_dir() and not d.name.startswith("_")])
    for sd in sets:
        sid = sd.name
        if args.only and sid != args.only:
            continue
        jp = sd / f"{sid}.json"
        if not jp.exists():
            continue
        rec = json.loads(jp.read_text(encoding="utf-8"))
        aidx = None
        for subj, sub in rec.get("subjects", {}).items():
            if sub.get("blocked_reason"):
                warns.append(f"{sid}/{subj}: 已隔离不可作答 — {sub['blocked_reason']}")
            seen = set()
            for mm in sub.get("modules", []):
                for gg in mm.get("groups", []):
                    for qq in gg.get("questions", []):
                        ident = (mm.get("module"), mm.get("part", 1), qq.get("no"))
                        if ident in seen:
                            errors.append(f"{sid}/{subj}: 同 module/part 题号重复 {ident}")
                        seen.add(ident)
            # 顶层答案表: (subject, module) -> {q: answer}
            top = {}
            for mod, lst in rec.get("answers", {}).get(subj, {}).items():
                for a in lst:
                    top.setdefault((mod, a.get("q")), a)
            for m, g in iter_groups(sub):
                if m is None:
                    if subj == 'writing' and g.get('type') == 'sentence_construction':
                        from static_references import sentence_fits
                        for it in (g.get('sentences') or g.get('items') or []):
                            label = f"{sid}/writing/sentence Q{it.get('no')}"
                            if it.get('reference_verified'):
                                if not it.get('reference_answer') or not sentence_fits(it, it['reference_answer']):
                                    errors.append(label + ': 标为可判分但原资料答案无法由固定词/词库拼成')
                            else:
                                warns.append(label + ': 无核验通过的逐题参考，只能保存未判分')
                    if subj == 'speaking':
                        for it in g.get('items', []):
                            ref = it.get('audio')
                            label = f"{sid}/speaking/{g.get('task')} Q{it.get('no')}"
                            if ref and it.get('audio_evidence') and not it['audio_evidence'].get('human_verified'):
                                warns.append(label + ': 整份源录音经 ASR 辅助对应，尚未人工逐题核验')
                            if not ref:
                                warns.append(label + ': 缺少可确认对应的口语音频')
                                continue
                            problem = check_audio_ref(ref, subj, g.get('task'), it.get('no'))
                            if problem:
                                errors.append(label + ': ' + problem + ' ' + ref)
                            if not (Path(dirs.get(sid, '')) / ref.replace(chr(92), '/')).is_file():
                                errors.append(label + ': 音频不存在 ' + ref)
                            if not re.search(r'_q\d+', ref, re.I) and not it.get('audio_module_level'):
                                errors.append(label + ': 整段音频缺少未分段标记')
                    continue
                gk = str(g.get("q_range") or "?")
                mk = f"m{m.get('module')}"
                qs = g.get("questions", [])
                kind = g.get("kind", "")
                # C. 题号连续（按 no 排序后判断；输出时已排序）
                nos = sorted(q.get("no") for q in qs if isinstance(q.get("no"), int))
                if nos and nos != list(range(nos[0], nos[0] + len(nos))):
                    errors.append(f"{sid}/{subj}/{mk} Q{gk}: 题号断档 {nos}")
                if kind == "fill_in_blank":
                    fills = g.get("answers") or []
                    cells = len(re.findall(r"[A-Za-z'’\-]*(?:\s+_)+|[A-Za-z'’\-]"+B+f"+",
                                           (g.get("passage") or "").replace("▢", " "+B)))
                    # 重新用与前端一致的规则数一遍
                    pw = (g.get("passage") or "").replace(B, "_")
                    pw = re.sub(r"([A-Za-z'’\-])(_+)", lambda m: m[1] + " " + " ".join(m[2]), pw)
                    runs = re.findall(r"([A-Za-z'’\-]*)((?:\s+_)+)", pw)
                    n_blanks = len(runs)
                    amap_in = {a.get("no"): a.get("a") for a in fills}
                    # A1. 挖空数 vs 组内答案数
                    if n_blanks != len(fills):
                        warns.append(f"{sid}/{subj}/{mk} Q{gk}: 挖空 {n_blanks} vs 组内答案 {len(fills)}")
                    # A2. 线索+格数 vs 组内答案（信息级）
                    start = int(gk.split("-")[0]) if re.match(r"^\d+", gk) else 1
                    for i, (clue, us) in enumerate(runs):
                        qno = start + i
                        a = amap_in.get(qno)
                        if not a:
                            continue
                        n = us.count("_")
                        if not (norm(a).startswith(norm(clue)) and len(norm(a)) - len(norm(clue)) == n):
                            warns.append(f"{sid}/{subj}/{mk} Q{gk} 第{qno}空: 线索{clue!r}+{n}格 vs 答案{a!r} 不自洽(原题排版差异,信息项)")
                    # D. 组内 vs 顶层
                    amk = "module" + str(m.get("module"))
                    top_fills = {a.get("q"): a.get("a") for (mo, q), a in top.items()
                                 if mo == amk and isinstance(q, int)}
                    if fills and top_fills:
                        for no, a in amap_in.items():
                            tv = top_fills.get(no)
                            if tv is not None and norm(tv) != norm(a):
                                errors.append(f"{sid}/{subj}/{amk} Q{no}: 组内答案 {a!r} != 顶层 {tv!r}")
                        missing = [no for no in amap_in if no not in top_fills]
                        if missing:
                            errors.append(f"{sid}/{subj}/{amk}: 顶层缺填空答案 Q{missing}")
                        extra = [q for q in top_fills
                                 if q not in amap_in and isinstance(top_fills[q], str)
                                 and (" " in top_fills[q].strip() or len(top_fills[q]) > 18)
                                 and not any(cq.get("no") == q and norm(top_fills[q]) in {norm(v) for v in (cq.get("options") or {}).values()}
                                             for cg in m.get("groups", []) for cq in cg.get("questions", []))]
                        if extra:
                            errors.append(f"{sid}/{subj}/{amk}: 顶层疑似污染答案 Q{extra}: "
                                          + ", ".join(f"{q}={top_fills[q]!r}" for q in extra[:3]))
                else:
                    amap_in = {}
                    for (mo, q), a in top.items():
                        if mo == "module" + str(m.get("module")) and isinstance(q, int):
                            amap_in[q] = a.get("a")
                    # B. 选择答案有效性：单字母（有对应选项）或完整选项文本
                    for q in qs:
                        if len(q.get("options") or {}) < 2:
                            warns.append(f"{sid}/{subj}/{mk} Q{q.get('no')}: 缺选择项/句子定位交互，不可按普通选择题判分")
                            continue
                        if "four locations" in q.get("stem", ""):
                            passage = g.get("passage", "")
                            if not all("[" + k + "]" in passage for k in "ABCD"):
                                warns.append(f"{sid}/{subj}/{mk} Q{q.get('no')}: 插入题四个位置未完整核验")
                                continue
                        a = amap_in.get(q.get("no"))
                        if a is None:
                            warns.append(f"{sid}/{subj}/{mk} Q{q.get('no')}: 缺官方答案（不能宣称已校验可判分）")
                            continue
                        if isinstance(a, str) and re.fullmatch(r"[A-Da-d]", a.strip()):
                            if not (q.get("options") or {}).get(a.strip().upper()):
                                errors.append(f"{sid}/{subj}/{mk} Q{q.get('no')}: 答案 {a} 无对应选项")
                        elif norm(a) not in {norm(v) for v in (q.get('options') or {}).values()}:
                            errors.append(f"{sid}/{subj}/{mk} Q{q.get('no')}: 选择答案非字母且不匹配任何选项 {a!r}")
                # E. 音频存在性
                refs = []
                for q in qs:
                    if q.get("audio"):
                        refs.append(q["audio"])
                if g.get("audio"):
                    refs.append(g["audio"])
                if refs and aidx is None:
                    aidx = audio_index(sid)
                for r in refs:
                    problem = check_audio_ref(r, subj)
                    if problem: errors.append(f"{sid}/{subj}/{mk} Q{gk}: {problem} {r}")
                    b = r.replace("\\", "/").rsplit("/", 1)[-1].lower()
                    if not (Path(dirs.get(sid, "")) / r.replace("\\", "/")).is_file():
                        errors.append(f"{sid}/{subj}/{mk} Q{gk}: 音频不存在 {r}")
    for e in errors:
        print("ERROR", e)
    for w in warns:
        print("WARN ", w)
    print(f"\n== 汇总: {len(errors)} 个错误, {len(warns)} 个提示 ==")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
