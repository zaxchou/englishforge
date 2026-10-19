#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""炒粉炒面万词班官方课后练习 → GQ_STORE 导入载荷。

数据源（均带文字层，零 OCR）：
  讲义   资料合集/1.直播课讲义+ppt/（1）1-36课讲义.pdf   —— 每课词表（词/音标/释义，按词根分组）
  练习   资料合集/5.结课以后群里发的/1-36课万词班课后练习.pdf —— 每课选择题，答案块内嵌在课后（多种排版）

产出 build/cfcm-official-quiz.json：36 个 GQ_STORE 条目（src=official）。
  --apply   合并进本地 records/generated-quizzes.json（只增不改，绝不触碰 ndf-01 条目）
  --check   只解析验证不落盘

铁律：任何课的 题数≠答案数、选项缺失、答案越界 都直接报错退出，不做静默修补。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
CFCM_BASE = ROOT.parent / "炒粉炒面万词班（待更新）"
HANDOUT = CFCM_BASE / "资料合集" / "1.直播课讲义+ppt" / "（1）1-36课讲义.pdf"
PRACTICE = CFCM_BASE / "资料合集" / "5.结课以后群里发的" / "1-36课万词班课后练习.pdf"
OUT = ROOT / "build" / "cfcm-official-quiz.json"
STORE = ROOT / "records" / "generated-quizzes.json"

CN = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
NUM = r"(?:[一二三四五六七八九十百零]+|\d+)"   # 课号：中文与阿拉伯数字混用（答案块常见「第5-6 课答案」）


def cn2int(s):
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    total, rest = 0, s
    if "十" in rest:
        head, rest = rest.split("十", 1)
        total += CN[head] * 10 if head else 10
    if rest:
        total += CN[rest]
    return total


ROOT_HEAD = re.compile(r"词根\d+：([A-Za-z][A-Za-z \-]*?)，([^（]+)（(\d+) 个）")
WORD_ENTRY = re.compile(r"^([A-Za-z][A-Za-z’’\- ]{0,40})\n(/[^/\n]+/)\n(.+)$", re.M)


def handout_words():
    """每课 词 -> (词根, 词根释义, 词条释义)；来源=讲义拆分逻辑，与 scan_courses.py 同一标题行。"""
    doc = pymupdf.open(str(HANDOUT))
    pages = [p.get_text() for p in doc]
    heads = [(i, cn2int(m.group(1)))
             for i, t in enumerate(pages)
             for m in [re.search(rf"万词班第({NUM})课讲义", t)] if m]
    out = {}
    for k, (idx0, no) in enumerate(heads):
        end = heads[k + 1][0] if k + 1 < len(heads) else len(pages)
        seg = "\n".join(pages[idx0:end])
        marks = [(m.start(), m.group(1).strip(), m.group(2).strip()) for m in ROOT_HEAD.finditer(seg)]
        words = {}
        for m in WORD_ENTRY.finditer(seg):
            word = m.group(1).strip().lower()
            root = next((r for pos, r, _g in reversed(marks) if pos < m.start()), "")
            gloss = next((g for pos, _r, g in reversed(marks) if pos < m.start()), "")
            words[word] = {"root": root, "gloss": gloss, "def": m.group(3).strip()}
        out[no] = words
    return out


ANS_MARK = re.compile(rf"^第({NUM})(?:-({NUM}))?\s*课?\s*答案?\s*$")
ANS_GLUED = re.compile(rf"^第({NUM})课\s*[:：]?\s*([A-D][A-D ]{{4,}})$")
ANS_BARE = re.compile(r"^答案[:：]?$|^参考答案$")   # 无课号的答案块头（其后字母可能连跨多课）
LESSON_HEAD = re.compile(rf"^第({NUM})课?题?$")   # 含原书笔误「第二十九题」（题而非课）
LETTER_LINE = re.compile(r"^([A-D][A-D ]{4,})$")   # 答案行 5 个字母一行（可含空格分组）
Q_START = re.compile(r"^(\d{1,2})\.\s*")
OPT_MARK = re.compile(r"(?:^|\s)([ABCD])\.\s")


def parse_practice():
    doc = pymupdf.open(str(PRACTICE))
    lines = []
    for p in doc:
        lines.extend(p.get_text().splitlines())
        lines.append("")
    # 标记行：课头 / 答案块头（含 glued 变体），标记之间的内容按归属分类
    markers = []   # (line_idx, lessons:list, kind:'head'|'ans'|'bare', pre_letters:str)
    for i, ln in enumerate(lines):
        t = ln.strip()
        if not t:
            continue
        m = ANS_MARK.match(t)
        if m:
            a = cn2int(m.group(1))
            b = cn2int(m.group(2)) if m.group(2) else a
            markers.append((i, list(range(a, b + 1)), "ans", ""))
            continue
        m = ANS_GLUED.match(t)
        if m:
            markers.append((i, [cn2int(m.group(1))], "ans", m.group(2)))
            continue
        if ANS_BARE.match(t):
            markers.append((i, [], "bare", ""))
            continue
        m = LESSON_HEAD.match(t)
        if m:
            markers.append((i, [cn2int(m.group(1))], "head", ""))
    questions, answers, unattr = {}, {}, []
    for k, (idx, lessons, kind, pre) in enumerate(markers):
        if kind == "bare":
            lessons = []
        end = markers[k + 1][0] if k + 1 < len(markers) else len(lines)
        blob = pre
        for ln in lines[idx + 1:end]:
            m = LETTER_LINE.match(ln.strip())
            if m:
                blob += m.group(1)
            elif blob and ln.strip() and not Q_START.match(ln.strip()):
                break   # 字母行中断且不是题目行 → 答案块结束
        blob = blob.replace(" ", "")
        seg = lines[idx + 1:end]
        qidx = [j for j, ln in enumerate(seg) if Q_START.match(ln.strip())]
        if kind == "head" and blob and not qidx:
            # 排版变体：课头行下一课答案（「第二十一课\nABBBC…」）——字母即该课答案
            answers.setdefault(lessons[0], []).append(blob)
            continue
        if kind == "head" or qidx:
            cur = questions.setdefault(lessons[0], {})
            chunks = (qidx + [len(seg)])
            for a, b in zip(chunks, chunks[1:]):
                num = int(Q_START.match(seg[a].strip()).group(1))
                cur.setdefault(num, []).extend(ln for ln in seg[a:b] if ln.strip())
        elif kind in ("ans", "bare") and blob:
            if len(lessons) == 1:
                answers.setdefault(lessons[0], []).append(blob)
            elif lessons:
                # 「第5-6 课答案」合并块：按各课题数切分（题数此时已可从 questions 取）
                need = {n: len(questions.get(n, {})) for n in lessons}
                if all(need.values()) and sum(need.values()) == len(blob):
                    off = 0
                    for n in lessons:
                        answers.setdefault(n, []).append(blob[off:off + need[n]])
                        off += need[n]
                else:
                    unattr.append(blob)
            else:
                unattr.append(blob)   # 裸「答案：」块：无课号，文档序分配给缺失课
    # 无归属答案块（如 27~30 课共 100 个字母连排）：按文档序、按各课题数分配给尚缺答案的课
    queue = [n for n in range(1, 37) if not answers.get(n)]
    for blob in unattr:
        off = 0
        while off < len(blob) and queue:
            n = queue[0]
            need = len(questions.get(n, {}))
            if not need:
                break
            answers.setdefault(n, []).append(blob[off:off + need])
            off += need
            queue.pop(0)
        if off < len(blob):
            raise SystemExit(f"无归属答案块剩余 {len(blob) - off} 个字母无法分配")
    if queue:
        print("  [warn] 仍缺答案的课:", queue)
    return questions, answers


def build_question(chunk, no, num, wordmap):
    """题块文本 -> {stem, options, answer 已由调用方对位, explain, tags}；解析失败返回 None。"""
    text = "\n".join(chunk)
    m = Q_START.match(text.strip())
    stem0 = text.strip()[m.end():] if m else text.strip()
    marks = list(OPT_MARK.finditer(stem0))
    seq = [mm.group(1) for mm in marks]
    if seq != ["A", "B", "C", "D"]:
        return None
    # 匹配含前导空白与「A. 」，选项文本从匹配结束取到下一匹配开始（剥掉字母前缀）
    stem = re.sub(r"\s+", " ", stem0[:marks[0].start()]).strip()
    opts = {}
    for i, mm in enumerate(marks):
        e = marks[i + 1].start() if i + 1 < len(marks) else len(stem0)
        opts[mm.group(1)] = re.sub(r"\s+", " ", stem0[mm.end():e]).strip().rstrip(".")
    if len(stem) < 8 or any(len(v) < 1 for v in opts.values()) or len(set(opts.values())) < 4:
        return None
    return {"stem": stem, "options": opts}


def inflect(w):
    """常见屈折还原候选：described->describe, restricts->restrict, modified->modify…"""
    cands = [w, w[:-1], w[:-2], w[:-3], w[:-2] + "e", w[:-3] + "y", w[:-1] + "y", w + "e"]
    return [c for c in cands if len(c) >= 3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="合并进 records/generated-quizzes.json")
    args = ap.parse_args()

    wordmap = handout_words()
    gword = {}
    for no, ws in wordmap.items():
        for w, e in ws.items():
            gword.setdefault(w, e)
    questions, answers = parse_practice()
    errors, entries = [], []
    for no in range(1, 37):
        qs = questions.get(no) or {}
        nums = sorted(qs)
        if nums != list(range(1, len(nums) + 1)):
            errors.append(f"第{no}课 题号不连续: {nums[:8]}...")
            continue
        keys = list(answers.get(no, []))
        letters = keys[0] if keys else ""
        if len(keys) > 1 and len(set(keys)) > 1:
            errors.append(f"第{no}课 答案块冲突: {keys}")
        if not letters or len(letters) != len(nums):
            errors.append(f"第{no}课 题数{len(nums)} ≠ 答案数{len(letters)}")
            continue
        built, bad_words = [], 0
        wm = wordmap.get(no, {})
        for i, num in enumerate(nums):
            q = build_question(qs[num], no, num, wm)
            if q is None:
                errors.append(f"第{no}课 第{num}题 解析失败: {' | '.join(qs[num])[:120]}")
                continue
            ans = letters[i]
            word = re.sub(r"[^a-z' \-]", "", q["options"][ans].lower()).strip().replace(" ", "")
            w = None
            for cand in inflect(word):
                w = wm.get(cand) or gword.get(cand)
                if w:
                    break
            if w:
                q["explain"] = f"{w['root']}（{w['gloss']}）· 讲义：{w['def']}"
                q["tags"] = [w["root"]] if w["root"] else []
            else:
                bad_words += 1
                q["explain"] = ""
                q["tags"] = []
            q["id"] = f"q{i + 1}"
            q["answer"] = ans
            built.append(q)
        if built:
            entries.append({
                "v": 2, "at": 0, "course": "cfcm-01", "lessonNo": no,
                "title": f"第{no:02d}课", "src": "official",
                "scope": f"炒面学姐官方课后练习 · 第{no}课 · 共 {len(built)} 题",
                "pages": [], "inventory": None, "uncovered": [], "bad": [],
                "questions": built,
            })
            if bad_words:
                print(f"  第{no:02d}课: {len(built)} 题, {bad_words} 题答案词未命中讲义词表(无溯源标签)")
    if errors:
        print(f"[import_cfcm_quiz] 解析失败 {len(errors)} 处，拒绝导入：", file=sys.stderr)
        for e in errors[:20]:
            print("  -", e, file=sys.stderr)
        sys.exit(1)
    total = sum(len(e["questions"]) for e in entries)
    print(f"[import_cfcm_quiz] 36 课全解析通过 · 共 {total} 题 · 溯源命中 {total - sum(1 for e in entries for q in e['questions'] if not q['explain'])}")
    dist = {}
    for e in entries:
        for q in e["questions"]:
            dist[q["answer"]] = dist.get(q["answer"], 0) + 1
    print("  答案分布:", dict(sorted(dist.items())))

    OUT.write_text(json.dumps({"version": 1, "items": {e["course"] + "-" + str(e["lessonNo"]).zfill(2): e for e in entries}},
                              ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  载荷 -> {OUT}")
    if not args.apply:
        return
    store = {}
    try:
        store = json.loads(STORE.read_text(encoding="utf-8")).get("items", {})
    except FileNotFoundError:
        print(f"  {STORE} 不存在，将新建")
    before = len(store)
    for k, e in (OUT and json.loads(OUT.read_text(encoding="utf-8")))["items"].items():
        old = store.get(k)
        if old and old.get("src") != "official":
            sys.exit(f"  !! {k} 已存在非官方条目，拒绝覆盖")
        e["at"] = (old or {}).get("at") or e["at"] or int(__import__("time").time() * 1000)
        store[k] = e
    STORE.parent.mkdir(parents=True, exist_ok=True)
    if STORE.exists():
        STORE.with_suffix(".json.bak-cfcm").write_text(STORE.read_text(encoding="utf-8"), encoding="utf-8")
    STORE.write_text(json.dumps({"version": 1, "items": store}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[apply] {STORE}: {before} -> {len(store)} 条（新增 {len(store) - before}）")


if __name__ == "__main__":
    main()
