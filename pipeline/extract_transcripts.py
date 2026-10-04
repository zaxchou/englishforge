#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从 Answers.docx 提取官方 Listening Transcript，对齐到逐题音频文件，
落盘 build/transcripts/<set>.json 供服务端 AI 解析注入（不在做题页显示）。

- 只提取，不改写；转写文本是官方原文，逐字保留（含 Man:/Woman: 说话人标签）。
- 对齐规则：Answers 里的小节标题（"Module 1 Q7-Q8 | Sweater Exchange Conversation"
  / "Module 1 - Choose the Best Response"）→ 题号集合 → 匹配题库 JSON 里这些题的
  audio 文件名。对齐失败的组如实丢弃并打印（宁缺勿错）。
用法:
    python extract_transcripts.py                 # 全部 95 套扫描
    python extract_transcripts.py 2026-06-07      # 只跑指定套
"""
from __future__ import annotations
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)                     # toefl-lab/
BUILD = os.path.join(ROOT, "build")
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(BUILD, "transcripts")


def docx_text(path: str) -> str:
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
    # 段落边界
    xml = xml.replace("</w:p>", "\n</w:p>")
    t = re.sub(r"<[^>]+>", "", xml)
    return t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")


def set_dir(set_id: str):
    mf = json.load(open(os.path.join(BUILD, "manifest.json"), encoding="utf-8"))
    sets = mf.get("sets", mf) if isinstance(mf, dict) else mf
    for s in sets:
        if s["set_id"] == set_id:
            d = s.get("abs_dir") or ""
            return d if os.path.isdir(d) else None
    return None


def extract_one(set_id: str) -> int:
    d = set_dir(set_id)
    if not d:
        return 0
    ans = next((f for f in os.listdir(d) if f.lower().startswith("answer") and f.endswith(".docx")), None)
    if not ans:
        return 0
    text = docx_text(os.path.join(d, ans))
    i = text.lower().find("listening transcript")
    if i < 0:
        return 0
    body = text[i + len("Listening Transcript"):]
    # 按小节切: 标题行要么 "Module mN - ..." / "Module mN Qa-Qb | title"
    # 段内每行一条台词, 以 Speaker: 开头（Man:/Woman:/Narrator:/Student:/Friend:/Professor: 等）
    sections = re.split(r"\n(?=Module\s+\d)", body)
    result = {}          # audio 文件名 -> {title, lines: [ "Speaker: text", ...]}
    unmatched = []
    sj = json.load(open(os.path.join(DATA, set_id, set_id + ".json"), encoding="utf-8"))
    # 题号 -> 音频文件名（listening）
    q_audio = {}   # (module, no) -> 文件名；M1/M2 题号重叠，必须带模块键
    g_audio = []   # (qmin, qmax, module, 文件名) 组级音频（题无逐题文件时）
    for m in sj["subjects"]["listening"]["modules"]:
        for g in m["groups"]:
            qs = [q["no"] for q in g.get("questions", [])]
            if g.get("audio"):
                if qs:
                    g_audio.append((min(qs), max(qs), m["module"], g["audio"].split("/")[-1]))
            for q in g.get("questions", []):
                if q.get("audio"):
                    q_audio[(m["module"], q["no"])] = q["audio"].split("/")[-1]
    for sec in sections:
        head = sec.strip().split("\n", 1)
        if not head:
            continue
        hm = re.match(r"Module\s+(\d)\s*(?:Q(\d+)[-–]Q?(\d+))?", head[0].strip())
        if not hm:
            continue
        mod = int(hm.group(1))
        qs = set()
        if hm.group(2):
            qs.update(range(int(hm.group(2)), int(hm.group(3)) + 1))
        else:
            # 无题号的小节(逐题回应): 抓正文里的 Qn. 行
            qs = {int(x) for x in re.findall(r"\bQ(\d+)\.", sec)}
        if not qs:
            continue
        audio = sorted({q_audio[(mod, q)] for q in qs if (mod, q) in q_audio})
        if not audio:
            # 逐题音频缺失时, 用覆盖这些题号的组级音频
            hits = {f for (qmin, qmax, gmod, f) in g_audio
                    if gmod == mod and not (max(qs) < qmin or min(qs) > qmax)}
            audio = sorted(hits)
        if not audio:
            unmatched.append(head[0][:60])
            continue
        lines = [ln.strip() for ln in sec.strip().split("\n")[1:] if re.match(r"^[A-Z][a-z]+:", ln.strip())]
        if not lines:
            # Q1-Q6 那种: 题面即录音内容, 用 "Qn. text" 行
            lines = [ln.strip() for ln in sec.strip().split("\n")[1:] if re.match(r"^Q\d+\.", ln.strip())]
        if not lines:
            unmatched.append(head[0][:60])
            continue
        title = head[0].strip()
        for a in audio:
            result[a] = {"title": title, "module": mod, "questions": sorted(qs), "lines": lines}
    if not result and not unmatched:
        return 0
    os.makedirs(OUT, exist_ok=True)
    out = os.path.join(OUT, set_id + ".json")
    json.dump({"set": set_id, "source": os.path.join(ans), "audios": result}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"{set_id}: {len(result)} 段音频对齐, {len(unmatched)} 段未匹配" + (f" -> {unmatched[:3]}" if unmatched else ""))
    return len(result)


def main():
    ids = sys.argv[1:] or sorted(
        f for f in os.listdir(DATA)
        if os.path.isfile(os.path.join(DATA, f, f + ".json")))
    tot = 0
    for sid in ids:
        try:
            tot += extract_one(sid)
        except Exception as e:
            print(f"{sid}: 提取失败 {e}")
    print(f"总计 {tot} 段")


if __name__ == "__main__":
    main()
