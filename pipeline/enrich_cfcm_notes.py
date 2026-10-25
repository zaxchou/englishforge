#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""万词班官方题 → 逐选项知识点批量生成（一次性的内容增强，题目本身不动）。

对每道题：把题干、四选项、官方答案、各选项词的讲义词条（词根/释义）交给模型，
为每个选项写一条 note：该选项什么意思 + 在本题为什么对/错。
输出仍是 {A:{t,note},...} 对象选项——与 ndf-01 V2 同构，前端选项知识点区块自动生效。

铁律：
- note 只写含义与本题判断，不改题干、不改答案、不新增选项。
- 每条 ≤80 字；JSON 校验失败整批重试一次，再失败该批落 build/cfcm-notes-failed.json 人工看。
- 断点续跑：进度存 build/cfcm-notes-progress.json；重跑只补缺失。
- --apply 把结果并回 build/cfcm-official-quiz.json（options 变对象）并同步 records/generated-quizzes.json。
"""
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib import request as urlreq

ROOT = Path(__file__).resolve().parent.parent
QUIZ = ROOT / "build" / "cfcm-official-quiz.json"
VOCAB = ROOT / "build" / "vocab" / "cfcm-words.json"
PROGRESS = ROOT / "build" / "cfcm-notes-progress.json"
FAILED = ROOT / "build" / "cfcm-notes-failed.json"

BATCH = 5
WORKERS = 6


def env_local():
    env = {}
    p = ROOT / ".env.local"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*(TFL_AI_\w+)\s*=\s*(.+?)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("'\"")
    return env


def glossary():
    """词 -> 讲义词条描述（全书写平，课内优先由调用方无所谓——词条本身带课号）。"""
    bank = json.loads(VOCAB.read_text(encoding="utf-8"))
    g = {}
    for b in bank["batches"]:
        for w in b["words"]:
            key = re.sub(r"\s+", "", w["w"].lower())
            if key not in g:
                g[key] = {"root": b["root"], "gloss": b["gloss"], "def": w["def"]}
    return g


def inflect(w):
    return [w, w[:-1], w[:-2], w[:-3], w[:-2] + "e", w[:-3] + "y", w[:-1] + "y", w + "e"]


def word_key(s):
    s = re.sub(r"[^a-zA-Z' \-]", "", s.lower()).strip()
    return re.sub(r"\s+", "", s)


def lookup(g, text):
    k = word_key(text)
    for cand in inflect(k):
        if cand in g:
            return g[cand]
    return None


def chat(cfg, sys_p, user_p):
    body = json.dumps({
        "model": cfg["model"],
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
        "max_tokens": 3600, "temperature": 0.2, "stream": False,
    }).encode()
    req = urlreq.Request(cfg["base"].rstrip("/") + "/chat/completions", data=body,
                         headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["key"]})
    with urlreq.urlopen(req, timeout=180) as r:
        j = json.loads(r.read().decode())
    return j["choices"][0]["message"]["content"].strip()


SYS = (
    "你是词汇题教研。每道题给你：题干(含空格)、四个选项、正确答案、部分选项的讲义词条(词根/词性释义)。"
    "为每个选项写一条 note，格式：先词义(讲义有的以讲义为准，没有的自己给)，再说明在本题为何正确或错误(结合题干语义/语法/搭配)。"
    "正确选项的 note 以「本题正确：」开头，错误选项以「不对：」开头。"
    "铁律：不改题干、不改答案；每条不超过 80 字；只依据题面与词条，不引入题外知识。"
    "严格输出 JSON 数组，与输入题序一一对应："
    '[{"no":题号,"notes":{"A":"...","B":"...","C":"...","D":"..."}}]'
)


def build_user(qs, g):
    parts = []
    for q in qs:
        lines = [f"{q['id'][1:]}. {q['stem']}", f"正确答案: {q['answer']}"]
        for k, v in q["options"].items():
            text = v if isinstance(v, str) else v.get("t", "")
            hit = lookup(g, text)
            lines.append(f"{k}. {text}" + (f"（讲义：{hit['def']}）" if hit else ""))
        parts.append("\n".join(lines))
    return "\n\n".join(parts)


def parse_batch(raw, qs):
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
    arr = json.loads(raw)
    if not isinstance(arr, list) or len(arr) != len(qs):
        raise ValueError("批结构不符")
    out = {}
    for item, q in zip(arr, qs):
        notes = item.get("notes") or {}
        if set(notes) != set("ABCD"):
            raise ValueError(f"q{q['id']} 选项键不符")
        for k, n in notes.items():
            if not isinstance(n, str) or not n.strip() or len(n) > 120:
                raise ValueError(f"q{q['id']} note 异常")
        out[q["id"]] = {k: n.strip() for k, n in notes.items()}
    return out


def main():
    apply = "--apply" in sys.argv
    cfg = {k: v for k, v in {
        "key": env_local().get("TFL_AI_KEY"),
        "base": env_local().get("TFL_AI_BASE_URL", "https://api.deepseek.com"),
        "model": env_local().get("TFL_AI_MODEL", "deepseek-chat")}.items()}
    if not cfg["key"]:
        sys.exit("缺 TFL_AI_KEY")
    items = json.loads(QUIZ.read_text(encoding="utf-8"))["items"]
    g = glossary()

    todo = []   # (lessonKey, [q,...])
    for lid in sorted(items):
        qs = items[lid]["questions"]
        batch, for_this = [], []
        for q in qs:
            opts = q["options"]
            if all(isinstance(v, dict) and v.get("note") for v in opts.values()):
                continue   # 已有 note，跳过（断点续跑）
            for_this.append(q)
            if len(for_this) == BATCH:
                batch.append(for_this)
                for_this = []
        if for_this:
            batch.append(for_this)
        for b in batch:
            todo.append((lid, b))
    n_q = sum(len(b) for _, b in todo)
    print(f"[enrich] 待处理 {n_q} 题 / {len(todo)} 批（已完成的自动跳过）")

    try:
        done = json.loads(PROGRESS.read_text(encoding="utf-8"))
    except FileNotFoundError:
        done = {}
    fails = []

    def work(task):
        lid, qs = task
        key = lid + "#" + ",".join(q["id"] for q in qs)
        if key in done:
            return None
        user = f"{lid}（第{int(lid.split('-')[-1])}课）：\n\n" + build_user(qs, g)
        for attempt in range(2):
            try:
                raw = chat(cfg, SYS, user)
                return key, lid, qs, parse_batch(raw, qs)
            except Exception as e:
                if attempt:
                    return ("FAIL", key, str(e))
                time.sleep(1.5)

    n_ok = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = [ex.submit(work, t) for t in todo]
        for i, f in enumerate(as_completed(futs), 1):
            r = f.result()
            if r is None:
                n_ok += 1
                continue
            if r[0] == "FAIL":
                fails.append({"key": r[1], "error": r[2]})
                print(f"  [{i}/{len(todo)}] FAIL {r[1]}: {r[2][:80]}")
                continue
            _, lid, qs, notes = r
            for q in qs:
                qn = notes.get(q["id"])
                if qn:
                    for k, v in q["options"].items():
                        q["options"][k] = {"t": v if isinstance(v, str) else v.get("t", ""), "note": qn[k]}
            done[lid + "#" + ",".join(q["id"] for q in qs)] = True
            PROGRESS.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
            n_ok += 1
            if i % 12 == 0 or i == len(todo):
                print(f"  [{i}/{len(todo)}] 批完成，累计题 {sum(1 for lid2 in items for q in items[lid2]['questions'] if all(isinstance(v, dict) and v.get('note') for v in q['options'].values()))}")

    FAILED.write_text(json.dumps(fails, ensure_ascii=False, indent=1), encoding="utf-8")
    if fails:
        print(f"[enrich] {len(fails)} 批失败 -> {FAILED.name}（可重跑补）")
    if not apply:
        print("[enrich] 检查模式，未落盘题库；--apply 并回")
        return
    QUIZ.write_text(json.dumps({"version": 1, "items": items}, ensure_ascii=False, indent=1), encoding="utf-8")
    store_p = ROOT / "records" / "generated-quizzes.json"
    store = json.loads(store_p.read_text(encoding="utf-8"))
    for lid, e in items.items():
        old = store["items"].get(lid)
        if old:
            e["at"] = old.get("at") or e["at"]
            e["bad"] = old.get("bad") or []
        store["items"][lid] = e
    store_p.write_text(json.dumps(store, ensure_ascii=False, indent=1), encoding="utf-8")
    total_notes = sum(1 for lid in items for q in items[lid]["questions"] for v in q["options"].values() if isinstance(v, dict) and v.get("note"))
    print(f"[apply] 题库与 dev store 已更新 · 带 note 选项 {total_notes}/3600")


if __name__ == "__main__":
    main()
