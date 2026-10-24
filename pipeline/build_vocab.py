#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""炒粉炒面万词班 → 背单词词库（三源对齐，宁缺勿错）。

来源（全部带文字层）：
  讲义   build/courses/notes/cfcm-01-NN.json（scan_courses 产物）——词/音标/释义/词根分组（主源）
  例句   资料合集/3.课后复习/(14)--1-36课每个单词配套例句.pdf —— 每词英文例句+中文译文
  默写表 资料合集/5.结课以后群里发的/1-36课excel默写表.xlsx —— 词+释义第二来源（仅互证）

产出 build/vocab/cfcm-words.json：
  batches: [{id, lesson, root, gloss, words:[{w, ipa, def, sen, senZh}]}]
  词在书内跨课重复时只保留首次出现（scheduling 按词唯一），后续课记入 also。
"""
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
CFCM_BASE = ROOT.parent / "炒粉炒面万词班（待更新）"
SENT_PDF = CFCM_BASE / "资料合集" / "3.课后复习" / "(14)--1-36课每个单词配套例句.pdf"
XLSX = CFCM_BASE / "资料合集" / "5.结课以后群里发的" / "1-36课excel默写表.xlsx"
NOTES_DIR = ROOT / "build" / "courses" / "notes"
OUT = ROOT / "build" / "vocab" / "cfcm-words.json"

ROOT_HEAD = re.compile(r"词根\d+：([A-Za-z][A-Za-z \-]*?)，([^（]+)（(\d+) 个）")
WORD_ENTRY = re.compile(r"^([A-Za-z][A-Za-z'’\- ]{0,40})\n(/[^/\n]+/)\n(.+?)$", re.M)
SENT_HEAD = re.compile(r"^([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’ \-]{0,60}?)\s*[–—]\s*(.*)$")
CJK = re.compile(r"[\u4e00-\u9fff]")
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def parse_handout():
    """讲义 notes → 每课有序词条（含词根归属）。"""
    words = {}   # lesson -> [entry]
    for no in range(1, 37):
        n = json.loads((NOTES_DIR / f"cfcm-01-{no:02d}.json").read_text(encoding="utf-8"))
        seg = "\n".join(pg["text"] for pg in n["pages"])
        marks = [(m.start(), m.group(1).strip(), m.group(2).strip()) for m in ROOT_HEAD.finditer(seg)]
        out = []
        for m in WORD_ENTRY.finditer(seg):
            root = next((r for pos, r, _g in reversed(marks) if pos < m.start()), "")
            gloss = next((g for pos, _r, g in reversed(marks) if pos < m.start()), "")
            out.append({"w": m.group(1).strip(), "ipa": m.group(2).strip(),
                        "def": re.sub(r"\s+", " ", m.group(3)).strip(),
                        "root": root, "gloss": gloss})
        words[no] = out
    return words


def sentence_key(word):
    return re.sub(r"\s+", "", re.sub(r"[‐‑‒]", "-", word.lower()))


def parse_sentences():
    """明确词头、英中状态和跨页边界；不明英文不接到上一词译文。"""
    out, lesson, cur = {}, 0, None
    audit = {"quarantine": [], "entries": 0}
    with pymupdf.open(str(SENT_PDF)) as doc:
        lines = []
        for page in doc:
            # 页码不属于例句；跨页保留当前词和语言状态。
            lines.extend(t for t in page.get_text().splitlines() if not re.fullmatch(r"\s*\d+\s*", t))
    text = "\n".join(lines).translate(str.maketrans({"‐": "-", "‑": "-", "‒": "-"}))
    text = re.sub(r"(?<=[A-Za-z])\s*-\s*(?=[A-Za-z])", "-", text)
    # 部分词头、分隔破折号和例句被 PDF 拆成三行。
    text = re.sub(r"(?m)^([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’ \-]{0,60})\n\s*([–—])\s*", r"\1 \2 ", text)
    for line_no, ln in enumerate(text.splitlines(), 1):
        t = ln.strip()
        if not t:
            continue
        mh = re.match(r"^第([一二三四五六七八九十百零]+|\d+)课\s*[:：]?\s*$", t)
        if mh:
            n = int(mh.group(1)) if mh.group(1).isdigit() else cn2int(mh.group(1))
            lesson, cur = n, None
            out.setdefault(n, {})
            continue
        ms = SENT_HEAD.match(t)
        if ms and lesson and not CJK.search(ms.group(1)):
            cur = sentence_key(ms.group(1))
            entry = {"en": ms.group(2).strip(), "zh": "", "unsafe": False}
            if cur in out[lesson]:
                audit["quarantine"].append({"lesson": lesson, "word": cur, "line": line_no, "reason": "duplicate head"})
                entry["unsafe"] = True
            out[lesson][cur] = entry
            audit["entries"] += 1
            continue
        if cur is None:
            if lesson:
                audit["quarantine"].append({"lesson": lesson, "line": line_no, "text": t, "reason": "no head"})
            continue
        e = out[lesson][cur]
        if CJK.search(t):
            e["zh"] += t
        elif e["zh"]:
            # 不明英文可能是未识别的新词头，隔离当前例句而非串卡。
            e["unsafe"] = True
            audit["quarantine"].append({"lesson": lesson, "word": cur, "line": line_no, "text": t, "reason": "English after translation"})
        else:
            e["en"] = (e["en"] + " " + t).strip()
    for entries in out.values():
        for entry in entries.values():
            if entry["unsafe"] or not entry["en"] or not entry["zh"]:
                entry["en"] = entry["zh"] = ""
    OUT.parent.mkdir(parents=True, exist_ok=True)
    (OUT.parent / "sentence-parse-audit.json").write_text(json.dumps(audit, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


def cn2int(s):
    if s.isdigit():
        return int(s)
    CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if s == "十":
        return 10
    total, rest = 0, s
    if "十" in rest:
        head, rest = rest.split("十", 1)
        total += CN[head] * 10 if head else 10
    if rest:
        total += CN[rest]
    return total


def parse_xlsx():
    """默写表：sheet 按课区间组织（「1-2课」「7-9课」…共 15 个），→ [(a, b, set(word))]。
    仅用于互证覆盖统计。sheet 顺序以 workbook.xml 的 name 为准，不假设文件名对应课号。"""
    z = zipfile.ZipFile(str(XLSX))
    ss = []
    try:
        xml = z.read("xl/sharedStrings.xml").decode("utf-8")
        ss = [re.sub(r"<[^>]+>", "", m) for m in re.findall(r"<si>(.*?)</si>", xml, re.S)]
    except KeyError:
        pass
    wb = z.read("xl/workbook.xml").decode("utf-8")
    sheets = re.findall(r'<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"', wb)
    rels = dict(re.findall(r'Id="(rId\d+)" [^>]*Target="(worksheets/[^"]+)"',
                           z.read("xl/_rels/workbook.xml.rels").decode("utf-8")))
    out = []
    for name, rid in sheets:
        mr = re.match(r"(\d+)-(\d+)课", name)
        if not mr or rid not in rels:
            continue
        a, b = int(mr.group(1)), int(mr.group(2))
        try:
            root = ET.fromstring(z.read("xl/" + rels[rid]))
        except KeyError:
            continue
        words = set()
        for row in root.iter(NS + "row"):
            for c in row.iter(NS + "c"):
                if not c.get("r", "").startswith("A"):
                    continue
                v = c.find(NS + "v")
                if v is None:
                    continue
                val = ss[int(v.text)] if c.get("t") == "s" else v.text
                val = (val or "").strip()
                if re.fullmatch(r"[A-Za-z][A-Za-z'’\- ]{0,40}", val):
                    words.add(val.lower())
        out.append((a, b, words))
    return out


def main():
    handout = parse_handout()
    sentences = parse_sentences()
    xlsx = parse_xlsx()

    batches, seen = [], {}
    n_total = n_sen = n_xlsx = n_dup = 0
    for lesson in range(1, 37):
        # 词根组保持讲义顺序；>20 词的组按 20 切批
        groups = []
        for e in handout[lesson]:
            if groups and groups[-1][0] == e["root"]:
                groups[-1][1].append(e)
            else:
                groups.append((e["root"], [e]))
        for root, entries in groups:
            gloss = entries[0]["gloss"]
            for chunk in range(0, len(entries), 20):
                part = entries[chunk:chunk + 20]
                words = []
                for e in part:
                    w = e["w"]
                    key = w.lower().replace(" ", "")
                    n_total += 1
                    if key in seen:
                        n_dup += 1
                        seen[key]["also"].append(lesson)
                        continue
                    s = sentences.get(lesson, {}).get(sentence_key(w))
                    sen, senzh = (s["en"], s["zh"]) if s else ("", "")
                    if sen:
                        n_sen += 1
                    if any(a <= lesson <= b and key in ws for a, b, ws in xlsx):
                        n_xlsx += 1
                    card = {"w": w, "ipa": e["ipa"], "def": e["def"],
                            "sen": sen, "senZh": senzh, "lesson": lesson, "also": []}
                    seen[key] = card
                    words.append(card)
                batches.append({"id": f"{lesson}-{len(batches) + 1}", "lesson": lesson,
                                "root": root, "gloss": gloss, "words": words})
    unique = len(seen)
    print(f"[build_vocab] 讲义词条 {n_total} · 去重后 {unique} (跨课重复 {n_dup}) · 有例句 {n_sen} ({n_sen * 100 // max(unique,1)}%) · 默写表命中 {n_xlsx}")
    miss_sen = [k for k, c in seen.items() if not c["sen"]]
    if miss_sen[:8]:
        print("  无例句样例:", miss_sen[:8])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"version": 1, "generated": date.today().isoformat(),
                               "course": "cfcm-01", "batches": batches},
                              ensure_ascii=False), encoding="utf-8")
    print(f"  -> {OUT} ({OUT.stat().st_size // 1024} KB, {len(batches)} 批)")
    # 抽样
    for b in batches[:2]:
        for c in b["words"][:2]:
            print("  样卡:", b["id"], c["w"], "|", c["ipa"], "|", b["root"], "|", (c["sen"] or "无例句")[:60])


if __name__ == "__main__":
    main()
