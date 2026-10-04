#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
可用性审计 (audit)

`validate.py` 查的是"结构有没有坏"（锚点重复、链接悬空）。
这个脚本查的是另一件事: **这套卷子能不能直接拿去做题**。

判定标准（逐条硬指标，不靠印象）
------------------------------------

**必要条件**（任一不满足 -> 不可用）
  1. 题量达标          该科不能为 0
  2. 无待识别残留      不能还有 🖼 材料原文待识别
  3. 无缺失材料        每个题组都要有原文
  4. 答案覆盖          有答案的题 >= 总题数的 60%

**加分项**（不影响"可用"，但影响好用）
  - 有逐题音频链接
  - 有听力原文
  - 填空题答案已回填
  - 四科齐全

输出分级
--------
  A 可直接做题   四科齐全 + 无待识别 + 无缺材料 + 答案覆盖达标
  B 基本可用     必要条件全过, 但缺音频或缺某一科
  C 需补识别     仍有材料待 OCR
  D 不可用       题量不足

用法:
    python audit.py --out output --json build/audit.json
"""

from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

SUBJ_CN = {"listening": "听力", "reading": "阅读",
           "writing": "写作", "speaking": "口语"}
SUBJ_ORDER = ["listening", "reading", "writing", "speaking"]


def count_subject(p: dict) -> int:
    """
    数一科有多少题。

    三个位置都要数, 漏一个就会把完好的套题误判成"该科为零":
      - modules[].groups[].questions      听力 / 阅读
      - tasks[].items                      口语 (key 是 items)
      - tasks[].sentences                  写作句子建构
    """
    n = 0
    for m in p.get("modules", []):
        n += sum(len(g.get("questions", [])) for g in m.get("groups", []))
    for t in p.get("tasks", []):
        n += len(t.get("items", [])) + len(t.get("sentences", []))
    return n


def audit_one(md_path: Path) -> dict:
    md = md_path.read_text(encoding="utf-8")
    jp = md_path.with_suffix(".json")
    rec = json.loads(jp.read_text(encoding="utf-8")) if jp.exists() else {}

    subj = rec.get("subjects", {})
    q = {s: count_subject(subj.get(s) or {}) for s in SUBJ_ORDER}
    # OCR 补的题面走 source=ocr, 题干/选项在别处, count_subject 数不到。
    # 从 Markdown 兜底统计, 免得把"识别齐了"的套题误判成"该科为零"。
    # OCR 补的题面走 source=ocr, 题干/选项在别处, count_subject 数不到。
    # 逐科兜底: 该科为 0 时从 Markdown 按题目标题数统计, 免得把
    # "识别齐了"的套题误判成"该科为零"。不能写成 if not any(q.values())
    # —— 只要有一科非 0 就跳过, 另一科照样误报。
    for s, pat in (("listening", r"^##### L\d+-Q"),
                   ("reading", r"^##### R\d+-Q"),
                   ("writing", r"^##### W"),
                   ("speaking", r"^##### S")):
        if not q[s]:
            q[s] = len(re.findall(pat, md, re.M))

    # 阅读材料完整性
    read_groups = []
    for m in (subj.get("reading") or {}).get("modules", []):
        for g in m.get("groups", []):
            if g.get("questions"):
                read_groups.append(g)
    rd_total = len(read_groups)
    rd_has = sum(1 for g in read_groups if g.get("passage"))
    rd_wait = sum(1 for g in read_groups
                  if g.get("passage_image") and not g.get("passage"))

    # 答案覆盖: 正文里"参考答案"出现次数 / 总题数
    n_ans_inline = len(re.findall(r"✅\s*参考答案", md))
    n_ans_table = len(re.findall(r"^\|\s*\d+\s*\|", md, re.M))
    # 总题数: 优先信 front-matter, 兜底数题目标题。
    # 坑: front-matter 的 YAML 是**顶格**的 (question_count: 88),
    # 正则若写成 ^\s*question_count 会匹配不到 -> n_q=0 ->
    # 分级直接掉到 D/A 判不出来。这里两种都收。
    n_q = 0
    m_fm = re.search(r"^\s*question_count:\s*(\d+)\s*$", md, re.M)
    if m_fm:
        n_q = int(m_fm.group(1))
    if not n_q:
        # 兜底 1: JSON 里的 question_count
        try:
            n_q = int(rec.get("question_count", 0) or 0)
        except (TypeError, ValueError):
            n_q = 0
    if not n_q:
        # 兜底 2: 直接数题目标题 (##### 开头)
        n_q = len(re.findall(r"^#####\s", md, re.M))
    if not n_q:
        n_q = sum(q.values())
    ans_cov = (max(n_ans_inline, 0) / n_q) if n_q else 0.0

    # 逐题音频 + 整段音频都算 (图片版素材只有整段 m4a)
    n_audio_link = len(re.findall(r"🔊\s*音频", md))
    has_tr = "听力原文 Listening Transcript" in md
    n_blank_ans = len(re.findall(r"材料原文（[^）]+）·\s*答案版", md))
    pending_img = len(re.findall(r"材料原文待识别", md))

    # ---- 必要条件 ----
    # q 的键是**英文**学科名 (SUBJ_ORDER), 输出时才映射成中文。
    # 早前两处都写反了: 一处拿 SUBJ_CN[s] 查 q, 一处拿中文查 q,
    # 结果每套都被追加"四科为零", A 级全掉成 B/C。
    blockers = []
    if n_q == 0:
        blockers.append("零题")
    for s in SUBJ_ORDER:
        if not q.get(s):
            blockers.append(f"{SUBJ_CN[s]}为零")
    if pending_img:
        blockers.append(f"{pending_img} 段材料待识别")
    if rd_wait:
        blockers.append(f"{rd_wait} 段阅读材料缺失")
    if n_q and ans_cov < 0.6:
        blockers.append(f"答案覆盖仅 {ans_cov:.0%}")

    # ---- 分级 ----
    # 四科齐全: q 的键是中文 (SUBJ_CN), 不能用 SUBJ_ORDER 查 ——
    # 写成 q[s] 恒为 0, 条件永远成立, 分级就失真了。
    all_subj = all(q.get(s, 0) > 0 for s in SUBJ_ORDER)
    if not n_q:
        grade = "D"
    elif pending_img or rd_wait:
        grade = "C"
    elif blockers:
        grade = "C"
    elif all_subj and n_audio_link > 0:
        grade = "A"
    else:
        grade = "B"

    # ---- 加分项 ----
    perks = []
    if n_audio_link:
        perks.append(f"逐题音频{n_audio_link}")
    if has_tr:
        perks.append("听力原文")
    if n_blank_ans:
        perks.append(f"填空答案版{n_blank_ans}")
    if all_subj:
        perks.append("四科齐全")

    return {
        "set_id": rec.get("set_id", md_path.stem),
        "grade": grade,
        "questions": {SUBJ_CN[s]: q[s] for s in SUBJ_ORDER},
        "total_q": n_q,
        "audio_links": n_audio_link,
        "reading_groups": rd_total,
        "reading_has_passage": rd_has,
        "reading_pending": rd_wait,
        "pending_markers": pending_img,
        "answer_inline": n_ans_inline,
        "answer_table": n_ans_table,
        "answer_coverage": round(ans_cov, 3),
        "has_transcript": has_tr,
        "blank_answer_versions": n_blank_ans,
        "blockers": blockers,
        "perks": perks,
    }


def w(s: str, n: int) -> str:
    s = str(s)
    return s + " " * max(1, n - sum(2 if ord(c) > 0x2E80 else 1 for c in s))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="output")
    ap.add_argument("--json", default="build/audit.json")
    ap.add_argument("--md", help="把审计结论写成 Markdown 索引")
    a = ap.parse_args()

    out = Path(a.out)
    rows = []
    for md in sorted(out.rglob("*.md")):
        # 跳过索引文件和临时/探针文件
        if re.match(r"^INDEX", md.name) or md.name.startswith(("_", "probe")):
            continue
        try:
            rows.append(audit_one(md))
        except Exception as e:  # noqa: BLE001
            rows.append({"set_id": md.stem, "grade": "D",
                         "blockers": [f"{type(e).__name__}: {e}"],
                         "total_q": 0, "questions": {}, "perks": []})

    by = {g: [r for r in rows if r["grade"] == g]
          for g in ("A", "B", "C", "D")}

    print(w("等级", 6) + w("含义", 18) + w("套数", 6) + w("题量", 8) + "说明")
    print("-" * 78)
    desc = {"A": "可直接做题", "B": "基本可用",
            "C": "需补识别/补答案", "D": "暂不可用"}
    for g in ("A", "B", "C", "D"):
        n = len(by[g])
        q = sum(r["total_q"] for r in by[g])
        print(w(g, 6) + w(desc[g], 18) + w(n, 6) + w(q, 8)
              + ("" if g == "A" else ""))

    print()
    if by["A"]:
        print(f"=== A 级 {len(by['A'])} 套（可直接做题）===")
        print(w("套题", 20) + w("听", 6) + w("读", 6) + w("写", 6) + w("口", 6)
              + w("合计", 7) + w("音频", 6) + w("答案覆盖", 10) + "亮点")
        for r in sorted(by["A"], key=lambda x: x["set_id"]):
            q = r["questions"]
            print(w(r["set_id"], 20)
                  + w(q.get("听力", 0), 6) + w(q.get("阅读", 0), 6)
                  + w(q.get("写作", 0), 6) + w(q.get("口语", 0), 6)
                  + w(r["total_q"], 7) + w(r["audio_links"], 6)
                  + w(f"{r['answer_coverage']:.0%}", 10)
                  + "、".join(r["perks"][:3]))
    if by["B"]:
        print(f"\n=== B 级 {len(by['B'])} 套（基本可用）===")
        for r in sorted(by["B"], key=lambda x: x["set_id"]):
            # 只在真的缺科时才列缺失项 —— 四科齐全的 B 级套是
            # "有材料无音频", 不是"某科为零"。别无脑打印"缺:"。
            # 注意 questions 的键是**中文** (SUBJ_CN), 不能用 SUBJ_ORDER 查。
            miss = [audit_cn for s, audit_cn in SUBJ_CN.items()
                    if not r["questions"].get(audit_cn)]
            tail = ("缺: " + ",".join(miss)) if miss else (
                "、".join(r["perks"][:3]) or "四科齐全")
            print(f"  {r['set_id']:<20} 题{r['total_q']:<4} "
                  f"答案覆盖{r['answer_coverage']:.0%}  {tail}")
    if by["C"]:
        print(f"\n=== C 级 {len(by['C'])} 套（需补识别）===")
        for r in sorted(by["C"], key=lambda x: x["set_id"]):
            print(f"  {r['set_id']:<20} 题{r['total_q']:<4} "
                  f"{'; '.join(r['blockers'][:2])}")
    if by["D"]:
        print(f"\n=== D 级 {len(by['D'])} 套（暂不可用）===")
        for r in sorted(by["D"], key=lambda x: x["set_id"]):
            print(f"  {r['set_id']:<20} {'; '.join(r['blockers'][:2])}")

    Path(a.json).parent.mkdir(parents=True, exist_ok=True)
    Path(a.json).write_text(json.dumps(
        {"summary": {g: len(v) for g, v in by.items()}, "sets": rows},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n明细: {a.json}")

    if a.md:
        _write_index_md(Path(a.md), by, rows)
        print(f"索引: {a.md}")
    return 0


def _write_index_md(path: Path, by: dict, rows: list[dict]) -> None:
    """
    生成"按可用性分级"的索引。

    与 pipeline 的 INDEX.md 互补: 那份按套题列全部, 这份直接回答
    "我现在能拿哪几套去做题"。
    """
    L = ["# 托福真题题库 · 可用性索引", ""]
    total_usable = len(by["A"]) + len(by["B"])
    total_q = sum(r["total_q"] for r in by["A"]) + sum(r["total_q"] for r in by["B"])
    L += [
        "## 结论", "",
        f"**{total_usable} 套可直接使用**，共 {total_q} 题。", "",
        "| 等级 | 含义 | 套数 | 题量 |", "|---|---|---|---|",
    ]
    desc = {"A": "✅ 可直接做题", "B": "基本可用", "C": "需补识别", "D": "暂不可用"}
    for g in ("A", "B", "C", "D"):
        L.append(f"| {desc[g]} | | {len(by[g])} | "
                 f"{sum(r['total_q'] for r in by[g])} |")
    L.append("")

    if by["A"]:
        L += ["## ✅ 可直接做题（%d 套）" % len(by["A"]), "",
              "四科齐全 + 无待识别 + 无材料缺失 + 答案覆盖达标。", "",
              "| 套题 | 听 | 读 | 写 | 口 | 合计 | 音频链接 | 答案覆盖 | 亮点 |",
              "|---|---|---|---|---|---|---|---|---|"]
        for r in sorted(by["A"], key=lambda x: x["set_id"]):
            q = r["questions"]
            L.append(f"| [{r['set_id']}](./{r['set_id']}/{r['set_id']}.md) "
                     f"| {q.get('听力', 0)} | {q.get('阅读', 0)} "
                     f"| {q.get('写作', 0)} | {q.get('口语', 0)} "
                     f"| **{r['total_q']}** | {r['audio_links']} "
                     f"| {r['answer_coverage']:.0%} | {'、'.join(r['perks'][:3])} |")
        L.append("")

    for g, title in (("B", "基本可用"), ("C", "需补识别"), ("D", "暂不可用")):
        if not by[g]:
            continue
        L += [f"## {title}（{len(by[g])} 套）", ""]
        if g == "D":
            L += ["这些套题的题目是扫描图 / 截图，文字层里没有，"
                  "需先 OCR 才能进题库。", "",
                  "| 套题 | 已有题量 | 原因 |", "|---|---|---|"]
            for r in sorted(by["D"], key=lambda x: x["set_id"]):
                L.append(f"| {r['set_id']} | {r['total_q']} "
                         f"| {'; '.join(r['blockers'][:2])} |")
        else:
            L += ["| 套题 | 题量 | 待补 |", "|---|---|---|"]
            for r in sorted(by[g], key=lambda x: x["set_id"]):
                L.append(f"| {r['set_id']} | {r['total_q']} "
                         f"| {'; '.join(r['blockers'][:2])} |")
        L.append("")

    L += ["---", "", "## 判定标准", "",
          "**必要条件**（任一不满足即不可用）", "",
          "- 题量达标（该科不为 0）", "- 无「材料原文待识别」残留",
          "- 每段阅读材料都有正文", "- 答案覆盖 ≥ 60%", "",
          "**分级**", "",
          "- **A**：四科齐全 + 有逐题音频链接", "- **B**：必要条件全过但缺音频或缺一科",
          "- **C**：仍有材料待 OCR", "- **D**：题量不足（多数是扫描版）", ""]
    path.write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
