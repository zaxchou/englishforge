#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""单套题解析自检: 打印题量/分组/音频覆盖率, 便于快速发现解析退化。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from extract import docx_text                      # noqa: E402
from parse_questions import parse_subject, summarize  # noqa: E402

SETS = {
    "2026-06-22": r"Z:/BaiduNetdiskWorkspace/myagent-work/zcode/JunEnglish/819新托福真题持续更新/2026真题持续更新中/6月/6.22-已经修复",
}
FILES = {"listening": "Listening.docx", "reading": "Reading.docx",
         "writing": "Writing.docx", "speaking": "Speaking.docx"}


def run(set_id: str, base: str):
    b = Path(base)
    print(f"===== {set_id}  {b.name}")
    for subj, fname in FILES.items():
        p = b / fname
        if not p.exists():
            print(f"  {summarize_name(subj)}: 缺文件 {fname}")
            continue
        parsed = parse_subject(subj, docx_text(p))
        print("  " + summarize(parsed))
        if "modules" in parsed:
            for m in parsed["modules"]:
                for g in m["groups"]:
                    tot = len(g["questions"])
                    aud = sum(1 for q in g["questions"] if q.get("audio"))
                    print(f"      m{m['module']} {g['kind']:<17}"
                          f"{(g.get('q_range') or '-'):<8} n={tot:<3} audio={aud}")
        else:
            for t in parsed["tasks"]:
                n = len(t.get("sentences", [])) + len(t.get("items", []))
                print(f"      {t.get('type',''):<22}{t.get('title','')[:40]:<42} n={n}")


def summarize_name(s):
    return f"{s}"


if __name__ == "__main__":
    sid = sys.argv[1] if len(sys.argv) > 1 else "2026-06-22"
    run(sid, SETS[sid])
