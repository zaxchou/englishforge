#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
听力音频说话人性别核验（ASR + 基频 F0）

背景：2026-10-04 用户发现 2026-06-07 听力 Q8 的音频里 man/woman 角色与题干相反。
排查证实：题干/官方答案是原题文本（文字层核验过），错在素材方重制的音频——
说话人性别与原题互换（5 组对话里 4 组互换）。音频源只读不可改，
处理方式是把核验结论写进题库（题目级 audio_caveat），做题页显示警示条。

本脚本做两件事：
  1. transcribe：ASR(faster-whisper) 转写 + 每段话的基频中位数(parselmouth F0)，
     按男声(<155Hz)/女声(≥155Hz)标注说话人。性别判定靠 F0，不靠猜。
  2. annotate：按人工比对话文本与题干的结论，把 audio_caveat 写进套题 JSON
     （题目级，只在人工确认后使用——脚本不自动判定"互换"，只出证据）。

用法:
    python verify_audio_roles.py transcribe <set_dir> <mp3相对路径> [--model base]
    python verify_audio_roles.py annotate <data/set/set.json>   # 见 --help
依赖: pip install faster-whisper praat-parselmouth（huggingface 走 HF_ENDPOINT 镜像）
"""
from __future__ import annotations
import argparse
import sys

MALE_HZ = 155  # 男声 ~85-180 / 女声 ~165-255，重叠区取中


def transcribe(path: str, model_size: str = "base") -> None:
    from faster_whisper import WhisperModel
    import numpy as np
    import parselmouth

    m = WhisperModel(model_size, device="cpu", compute_type="int8")
    segs, info = m.transcribe(path)
    snd = parselmouth.Sound(path)
    pitch = snd.to_pitch()
    f0 = pitch.selected_array["frequency"]
    times = pitch.xs()

    def voice_f0(t0: float, t1: float):
        v = f0[(times >= t0) & (times <= t1) & (f0 > 50) & (f0 < 400)]
        return float(np.median(v)) if len(v) > 4 else None

    print(f"duration: {info.duration:.1f}s")
    for s in segs:
        f = voice_f0(s.start, s.end)
        if f is None:
            continue
        g = "M" if f < MALE_HZ else "F"
        print(f"{g} ({f:4.0f}Hz) [{s.start:6.1f}-{s.end:6.1f}] {s.text}")


def annotate(json_path: str) -> None:
    """把人工核验过的 audio_caveat 写进套题 JSON（题目级）。
    映射表写在脚本调用方——本命令只负责按 {音频文件名: 说明} 落库。"""
    import json
    import os
    caveats = json.loads(os.environ.get("AUDIO_CAVEATS", "{}"))
    if not caveats:
        print("用法: AUDIO_CAVEATS='<音频文件名: 说明 的JSON>' python verify_audio_roles.py annotate <set.json>")
        sys.exit(2)
    j = json.load(open(json_path, encoding="utf-8"))
    n = 0
    for sub in j.get("subjects", {}).values():
        for m in sub.get("modules", []):
            for g in m.get("groups", []):
                g.pop("audio_caveat", None)
                for q in g.get("questions", []):
                    q.pop("audio_caveat", None)
                    fn = (q.get("audio") or "").split("/")[-1]
                    if fn in caveats:
                        q["audio_caveat"] = caveats[fn]
                        n += 1
    json.dump(j, open(json_path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"annotated questions: {n}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", choices=["transcribe", "annotate"])
    ap.add_argument("path")
    ap.add_argument("--model", default="base")
    a = ap.parse_args()
    if a.cmd == "transcribe":
        transcribe(a.path, a.model)
    else:
        annotate(a.path)
