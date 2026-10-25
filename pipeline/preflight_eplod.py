# -*- coding: utf-8 -*-
"""365 期 preflight: PDF 解析 + 音频四件套存在性. 不跑 whisper/AI."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_eplod as B

bad, ok = [], 0
for i in range(1, 366):
    ep = f"{i:04d}"
    try:
        d = B.find_ep_dir(ep)
        missing = [n for n in ("dg", "pb", "rv") if not list(d.glob(f"*{n}.mp3"))]
        if missing:
            bad.append((ep, f"缺音频 {missing}"))
            continue
        pdf = next(d.glob("*.pdf"))
        data = B.parse_pdf(pdf)
        probs = []
        if len(data["dialogue"]) < 4:
            probs.append(f"对话仅{len(data['dialogue'])}句")
        if not data["title"]:
            probs.append("无标题")
        if len(data["dialogue"]) >= 4 and not data["keyvocab"] and not data["suppvocab"]:
            probs.append("词表空")
        if probs:
            bad.append((ep, "; ".join(probs)))
        else:
            ok += 1
    except Exception as e:
        bad.append((ep, f"{type(e).__name__}: {e}"))

print(f"OK {ok}/365")
for ep, why in bad:
    print("BAD", ep, why)
