#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""万词班官方课后练习 900 题全量独立复核。

对每道题问 DeepSeek：仅凭句义与选项，标记的官方答案是否明确成立？
结构校验(选项唯一/答案在选项内/词表溯源)在导入时已过；本脚本补的是语义层。
输出 docs/cfcm-quiz-verification/report.json，供人工终审——AI 异议只作候选，不改题。
"""
import json
import re
import sys
import time
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
QUIZ = ROOT / "build" / "cfcm-official-quiz.json"
OUT_DIR = ROOT / "docs" / "cfcm-quiz-verification"


def env_local():
    env = {}
    p = ROOT / ".env.local"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*(TFL_AI_\w+)\s*=\s*(.+?)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("'\"")
    return env


def chat(cfg, sys_p, user_p):
    body = json.dumps({
        "model": cfg["model"],
        "messages": [{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
        "max_tokens": 3000, "temperature": 0, "stream": False,
    }).encode()
    req = urllib.request.Request(
        cfg["base"].rstrip("/") + "/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["key"]})
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.loads(r.read().decode())
    return j["choices"][0]["message"]["content"].strip()


SYS = ("你是英语词汇题审校。给你一组单选题(题干含空格、四个选项、官方标记的答案)。"
       "只凭句子的语义和语法判断标记答案是否明确成立。"
       "严格输出 JSON 数组，每题一项：{\"no\":题号,\"v\":\"ok\"或\"suspect\","
       "\"note\":\"suspect 时用一句中文说明哪个选项更像正确答案及为什么；ok 时空串\"}。"
       "判 ok 的标准：标记答案在句中语义语法都自然，且没有另一个选项同样自然。"
       "拿不准时判 ok(不吹毛求疵)；只有明确觉得另一选项更好时才 suspect。")


def main():
    env = env_local()
    cfg = {"key": env.get("TFL_AI_KEY"), "base": env.get("TFL_AI_BASE_URL", "https://api.deepseek.com"),
           "model": env.get("TFL_AI_MODEL", "deepseek-chat")}
    if not cfg["key"]:
        sys.exit("缺 TFL_AI_KEY（.env.local）")
    items = json.loads(QUIZ.read_text(encoding="utf-8"))["items"]
    report, suspects = {}, 0
    for no in range(1, 37):
        key = f"cfcm-01-{no:02d}"
        qs = items[key]["questions"]
        user = "\n".join(
            f"{q['id'][1:]}. {q['stem']}\n" + "\n".join(f"   {k}. {v}" for k, v in q["options"].items())
            + f"\n   官方答案: {q['answer']}"
            for q in qs)
        verdicts = None
        for attempt in range(2):
            try:
                raw = chat(cfg, SYS, "第%d课课后练习：\n\n%s" % (no, user))
                raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
                arr = json.loads(raw)
                if isinstance(arr, list) and len(arr) == len(qs):
                    verdicts = arr
                    break
            except Exception as e:
                print(f"  第{no}课 第{attempt+1}次尝试失败: {e}", file=sys.stderr)
                time.sleep(2)
        if verdicts is None:
            report[key] = {"error": "解析失败"}
            print(f"第{no}课: 失败")
            continue
        sus = [v for v in verdicts if v.get("v") == "suspect"]
        suspects += len(sus)
        report[key] = {"suspects": sus, "n": len(qs)}
        flag = f" · 异议 {len(sus)}" if sus else ""
        print(f"第{no:02d}课: {len(qs)} 题{flag}")
        for v in sus:
            print(f"    q{v.get('no')}: {v.get('note','')[:90]}")
        time.sleep(0.5)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n[verify_cfcm_quiz] 900 题过完 · 异议 {suspects} 条 -> {OUT_DIR / 'report.json'}")


if __name__ == "__main__":
    main()
