#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对仓库里自带的题库做一次"内容自检"：查重、找互相打架的题、找出缺逐项纠正的题。

与 app 内「系统自检」用的是**同一套规则**（题干+答案归一化后比较；归一化忽略大小写、
空白与中英标点）。区别只是数据来源：这里直接读仓库里的 `.ts` 题库，不需要 app 在跑，
所以适合改题之前/之后对一遍。

  python scripts/audit-bank.py              # 总览
  python scripts/audit-bank.py --list 20    # 列出重复最多的 20 组
  python scripts/audit-bank.py --suggest    # 给出"每组保留哪一道、毙掉哪些"的建议清单
"""
from __future__ import annotations

import argparse
import collections
import glob
import io
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 归一化时要去掉的标点（中英都算）——不含引号，引号单独处理，避免转义坑
PUNCT = '.,!?;:()（）[]{}<>《》、。，！？；：…—~`|/*#&+^%$@=_·•'
SPACE = re.compile(r'\s')

# 不用带反斜杠的正则：用"找起点 + 手工扫到结束引号"，避免 shell/转义层层剥皮
def field(block: str, key: str) -> str | None:
    """取 `key: '...'` 或 `key: "..."` 的值（两种引号都支持，处理转义）。取不到返回 None。

    题库里两种写法都有：手写题用单引号包中文（prompt: '"我有一本书。"'），
    语料题用双引号。所以这里自动识别引号，不能写死。"""
    marker = key + ': '
    i = block.find(marker)
    if i < 0:
        return None
    j = i + len(marker)
    while j < len(block) and block[j] not in ('\'', '"'):
        if block[j] == ',':      # 该字段没有值（例如 tiles 题没有 answer 字段）
            return None
        j += 1
    if j >= len(block):
        return None
    quote = block[j]
    out = []
    j += 1
    while j < len(block):
        c = block[j]
        if c == '\\':
            out.append(block[j + 1] if j + 1 < len(block) else '')
            j += 2
            continue
        if c == quote:
            return ''.join(out)
        out.append(c)
        j += 1
    return None


def sentence_of(r: dict) -> str:
    """这道题真正在考的那个句子：听力/跟读题的内容不在题干里，在 tts/target/tokens 里。
    只按题干分组会把 25 道听力题算成打架（实测过）。"""
    for k in ('tts', 'target', 'tokens', 'order'):
        v = r.get(k)
        if v:
            return v if isinstance(v, str) else ' '.join(v)
    return ''


def identity(r: dict) -> str:
    return r['type'] + '|' + norm(r['prompt']) + '|' + norm(sentence_of(r))


def norm(v: str | None) -> str:
    v = (v or '').lower().replace('"', '').replace("'", '')
    v = SPACE.sub('', v)
    for ch in PUNCT:
        v = v.replace(ch, '')
    return v


def load_bank() -> list[dict]:
    files = sorted(glob.glob(str(REPO / 'src' / 'data' / 'lesson*-q-*.ts')))
    files += [str(REPO / 'src' / 'data' / 'pilots' / 'subject-object.ts')]
    rows: list[dict] = []
    for f in files:
        text = io.open(f, encoding='utf-8').read()
        # 手写题是一行一题（`  { id: ... }`），语料题是多行（`  {`）——两种格式都要吃
        for block in re.split(r'\n  \{', text)[1:]:
            prompt = field(block, 'prompt')
            skill = field(block, 'skill')
            if prompt is None or skill is None:
                continue
            rows.append({
                'file': Path(f).name,
                'id': field(block, 'id') or '?',
                'skill': skill,
                'prompt': prompt,
                'answer': field(block, 'answer') or '',
                'type': field(block, 'type') or '',
                'tts': field(block, 'tts'),
                'target': field(block, 'target'),
                'has_cause': block.find('optionFeedback: {') >= 0,
            })
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description='仓库题库内容自检')
    ap.add_argument('--list', type=int, default=0, help='列出重复最多的 N 组')
    ap.add_argument('--suggest', action='store_true', help='输出"保留/毙掉"建议清单')
    args = ap.parse_args()

    rows = load_bank()
    by_sig: dict[tuple, list] = collections.defaultdict(list)
    by_ident: dict[str, list] = collections.defaultdict(list)
    for r in rows:
        key = identity(r)
        by_sig[(key, norm(r['answer']))].append(r)
        by_ident[key].append(r)

    dups = [g for g in by_sig.values() if len(g) > 1]
    # 跟读题的 answer 是占位符 'speak'（真答案在 target），不参与"打架"判定
    conf = [g for g in by_ident.values()
            if len(g) > 1 and all(x['type'] != 'speak' for x in g)
            and len({norm(x['answer']) for x in g}) > 1]
    no_cause = [r for r in rows if not r['has_cause']]

    print(f'仓库题库 {len(rows)} 道 · 缺逐项纠正 {len(no_cause)} 道')
    print(f'重复（同题型+同题干+同句子+同答案，只是标点/空白不同）：{len(dups)} 组 · 多余 {sum(len(g) - 1 for g in dups)} 道')
    print(f'打架（同一道题、答案不同）：{len(conf)} 组 —— 必有一道在教错，要人工定')

    # 同一个句子被几道题反复考（这是"感觉在重复"的真正来源：一个含义练很多遍是设计，
    # 但同一句话换题型再考一遍，用户会觉得"这题我做过了"）
    reuse = collections.defaultdict(list)
    for r in rows:
        sent = norm(sentence_of(r))
        if sent:
            reuse[sent].append(r)
    multi = {k: v for k, v in reuse.items() if len(v) > 1}
    extra = sum(len(v) - 1 for v in multi.values())
    print(f'同一句子被多道题考：{len(multi)} 句 · 多出 {extra} 道（同一含义换题型再考）')
    top = sorted(multi.items(), key=lambda kv: -len(kv[1]))[:8]
    for _key, v in top:
        types = collections.Counter(x['type'] for x in v)
        kinds = '/'.join(f'{t}×{n}' for t, n in types.items())
        print(f'  ×{len(v):<2} [{kinds}] {sentence_of(v[0])[:46]}')
    per = collections.Counter()
    for g in dups:
        for r in g[1:]:
            per[r['skill']] += 1
    if per:
        print('多余题按思维点：', ' · '.join(f'{k} {v} 道' for k, v in per.most_common()))

    if args.list:
        print(f'\n重复最多的 {args.list} 组：')
        for g in sorted(dups, key=lambda g: -len(g))[:args.list]:
            print(f"  ×{len(g):<3} [{g[0]['skill']}] {g[0]['prompt'][:50]}")
            print(f"        {[r['id'] for r in g]}")

    if conf:
        print(f'\n打架的题（前 {min(len(conf), 10)} 组）：')
        for g in sorted(conf, key=lambda g: -len(g))[:10]:
            answers = {r['answer'] for r in g}
            print(f"  [{g[0]['skill']}] {g[0]['prompt'][:44]}")
            print(f"        答案分歧：{sorted(answers)} · 题号 {[r['id'] for r in g]}")

    if args.suggest:
        out = []
        for g in dups:
            keep, extras = g[0], g[1:]
            out.append({'keep': keep['id'], 'kill': [r['id'] for r in extras], 'skill': keep['skill'], 'prompt': keep['prompt']})
        print('\n建议清单（JSON，每组保留 keep、其余 kill）：')
        import json
        print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
