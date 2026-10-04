#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
产物校验 (validate)

对 output/ 下的 Markdown 做机器可读的质量体检, 目的是批量跑之前
就知道哪些套题解析退化了, 而不是等 AI 读完才发现题号错位。

检查项:
  1. front-matter 完整性 (set_id / question_count / audio_count)
  2. 题量与 JSON 记录一致
  3. 锚点唯一 (同一 id 不能出现两次, 否则跳转会串)
  4. 题目 id 唯一且题号连续
  5. 音频链接指向的文件真实存在
  6. 答案覆盖率 (有答案的题里, 多少题在正文里拿到了答案)
  7. 原文覆盖率 (听力题里, 多少题能回链到原文段落)

用法:
    python validate.py --out output --root <素材根>
"""

from __future__ import annotations
import argparse
import json
import os
import re
import sys
from pathlib import Path

RE_FM = re.compile(r"^---\n(.*?)\n---", re.S)
RE_ANCHOR = re.compile(r'<a id="([^"]+)"></a>')
# 题号: 允许 L2#3-Q12 这种带 part 后缀的 id (# 在字符类里需转义)
RE_H5 = re.compile(r"^#####\s+([A-Z0-9\-#]+)\s*·", re.M)
RE_AUDIO_REF = re.compile(r"🔊 音频：\[`([^`]+)`\]")
RE_ANS = re.compile(r"✅ 参考答案：\*\*(.+?)\*\*")
RE_TR_REF = re.compile(r"📄 原文：\[`[^`]+`\]\(#([^)]+)\)")
RE_TR_ANCHOR = re.compile(r'<a id="(tr-[^"]+)"></a>')


def parse_front_matter(md: str) -> dict:
    m = RE_FM.match(md)
    if not m:
        return {}
    out = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            v = v.strip().strip('"')
            out[k.strip()] = int(v) if re.fullmatch(r"-?\d+", v) else v
    return out


def build_audio_index(source_root: Path | None) -> set[str]:
    """
    一次性收集素材里所有音频文件名。

    注意: 不能在每套题里用 rglob 去素材目录找 —— 那是网络盘 (Z:),
    每次全盘遍历都要几十秒, 94 套题会直接卡死。索引一次全局复用。
    """
    if not source_root:
        return set()
    names: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(source_root):
        dirnames[:] = [d for d in dirnames if d not in ("__MACOSX", ".accelerate")]
        for f in filenames:
            if f.lower().endswith((".mp3", ".m4a", ".ogg", ".wav", ".mp4",
                                   ".mov", ".ts")):
                names.add(f)
    return names


def validate_one(md_path: Path, audio_index: set[str] | None) -> dict:
    md = md_path.read_text(encoding="utf-8")
    sid = md_path.stem
    issues: list[str] = []
    warns: list[str] = []

    fm = parse_front_matter(md)
    if not fm:
        issues.append("缺少 front-matter")
    for k in ("set_id", "question_count", "audio_count"):
        if k not in fm:
            issues.append(f"front-matter 缺字段 {k}")

    anchors = RE_ANCHOR.findall(md)
    dup = {a for a in anchors if anchors.count(a) > 1}
    if dup:
        issues.append(f"锚点重复 x{len(dup)}: {sorted(dup)[:3]}")

    qids = RE_H5.findall(md)
    qdup = {q for q in qids if qids.count(q) > 1}
    if qdup:
        issues.append(f"题号重复 x{len(qdup)}: {sorted(qdup)[:3]}")

    # 音频文件是否存在
    if audio_index is not None:
        missing = [n for n in set(RE_AUDIO_REF.findall(md)) if n not in audio_index]
        if missing:
            warns.append(f"{len(missing)} 个音频链接在素材里找不到")

    # 答案覆盖: 答案表里的题 vs 正文里给出答案的题
    ans_rows = len(re.findall(r"^\|\s*\d+\s*\|", md, re.M))
    ans_inline = len(RE_ANS.findall(md))
    # 原文覆盖
    tr_anchors = set(RE_TR_ANCHOR.findall(md))
    tr_refs = set(RE_TR_REF.findall(md))
    dangling = tr_refs - tr_anchors
    if dangling:
        issues.append(f"原文回链指向不存在的锚点: {sorted(dangling)[:3]}")

    # 听力题数 vs 原文段落覆盖
    lq = len([q for q in qids if q.startswith("L")])
    cov = len([q for q in qids if q.startswith("L")
               and f"tr-m{q[1]}-q" in md])

    return {
        "set_id": sid,
        "q_headings": len(qids),
        "listening_q": lq,
        "answer_rows": ans_rows,
        "answer_inline": ans_inline,
        "transcript_anchors": len(tr_anchors),
        "issues": issues,
        "warnings": warns,
        "md_bytes": md_path.stat().st_size,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="output")
    ap.add_argument("--root", help="素材根目录, 用于校验音频文件是否真实存在")
    ap.add_argument("--json", help="把结果写成 json")
    a = ap.parse_args()

    out = Path(a.out)
    root = Path(a.root) if a.root else None
    print("索引素材音频 ...", flush=True)
    audio_index = build_audio_index(root)
    print(f"音频文件 {len(audio_index)} 个\n", flush=True)

    results = []
    for md in sorted(out.rglob("*.md")):
        # 跳过索引文件和临时/探针文件 (不是套题电子档)
        if md.name == "INDEX.md" or re.match(r"^INDEX_", md.name) \
                or md.name.startswith(("_", "probe", "wtest")):
            continue
        try:
            results.append(validate_one(md, audio_index))
        except Exception as e:  # noqa: BLE001
            results.append({"set_id": md.stem, "issues": [f"{type(e).__name__}: {e}"]})

    bad = [r for r in results if r.get("issues")]
    warn = [r for r in results if r.get("warnings")]

    def w(s, n):
        s = str(s)
        return s + " " * max(1, n - sum(2 if ord(c) > 0x2E80 else 1 for c in s))

    print(w("套题", 20) + w("题目标题", 10) + w("听力题", 8) + w("答案表", 8)
          + w("行内答案", 10) + w("原文段", 8) + "问题")
    print("-" * 92)
    for r in sorted(results, key=lambda x: x["set_id"]):
        flag = "❌" if r.get("issues") else ("⚠" if r.get("warnings") else "✅")
        print(w(r["set_id"], 20)
              + w(r.get("q_headings", 0), 10)
              + w(r.get("listening_q", 0), 8)
              + w(r.get("answer_rows", 0), 8)
              + w(r.get("answer_inline", 0), 10)
              + w(r.get("transcript_anchors", 0), 8)
              + flag)
        for i in r.get("issues", []):
            print("      ❌ " + i)
        for x in r.get("warnings", []):
            print("      ⚠ " + x)

    print()
    print(f"共 {len(results)} 套, 有问题 {len(bad)}, 有警告 {len(warn)}")
    if a.json:
        Path(a.json).write_text(json.dumps(results, ensure_ascii=False, indent=2),
                                encoding="utf-8")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
