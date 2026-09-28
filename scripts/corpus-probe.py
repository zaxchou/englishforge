#!/usr/bin/env python3
"""语料覆盖度探针。

目的：在动手写生成器之前，先量出「真实语料到底能供多少可用的题」。

给定一个目标语法对比（主格/宾格、单复数、be 时态），统计：
  - 命中的真实句子数（长度与噪声过滤后）
  - 其中的 **最小对立对**：只差目标对比、其余部分完全相同的一对真实句
  - 有多少个 *不同动词* 能构成对立对 —— 这才是「花样够不够」的真实指标

池子分两个，因为许可不同：
  - full  = Tatoeba 常规导出。Tatoeba 把 CC0 句单独导出，**常规导出里不含 CC0**。
            许可 CC BY 2.0 FR（需署名）→ 只能本地用。
  - cc0   = sentences_CC0 导出。CC0 → 可以进公开仓库。

数据不放在仓库里（许可约束），默认指向工作区的 corpus/ 目录。
用法：python scripts/corpus-probe.py [--corpus DIR] [--max-tokens N]
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict
from pathlib import Path

PERSON = {'I': 'me', 'he': 'him', 'she': 'her', 'we': 'us', 'they': 'them', 'you': 'you'}
OBJ2SUBJ = {v: k for k, v in PERSON.items()}

# 句子级噪声过滤：数字/引号/括号/网址/省略号/破折号等都不适合做练习句
NOISE = re.compile(r'[0-9"“”«»()\[\]{}@#*_/\\…—–]|://')
WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
# be 探针要排除的功能词，否则 "I was in ..." 会被当成 "I am in ..." 的形容词槽
FUNC = {
    'in', 'on', 'at', 'to', 'with', 'for', 'from', 'of', 'your', 'my', 'his', 'her',
    'their', 'our', 'a', 'an', 'the', 'not', 'so', 'too', 'very', 'going', 'gonna',
    'about', 'into', 'be', 'been', 'just', 'still', 'always', 'never', 'here', 'there',
}


def tokens(text: str) -> list[str]:
    return WORD.findall(text)


def norm(text: str) -> str:
    """归一化：小写、去标点、压空白 —— 用于判断「其余部分是否完全相同」。"""
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z ]+', ' ', text.lower())).strip()


def is_clean(text: str, max_tokens: int) -> bool:
    """短、无噪声、无专有名词（首词之外的大写词）。"""
    if NOISE.search(text):
        return False
    t = tokens(text)
    if not (2 <= len(t) <= max_tokens):
        return False
    return all(not w[0].isupper() for w in t[1:])


def load_pools(root: Path, max_tokens: int):
    full_f = root / 'tatoeba' / 'eng_sentences.tsv'
    cc0_f = root / 'tatoeba' / 'sentences_CC0.csv'
    for p in (full_f, cc0_f):
        if not p.exists():
            print(f'缺少语料文件: {p}', file=sys.stderr)
            raise SystemExit(2)

    csv.field_size_limit(1 << 24)      # 语料里有超长文本，默认 128KB 上限会报错
    pools = {}
    # 注意：sentences_CC0.csv 虽名为 csv，实际是 Tab 分隔（id / lang / text / date）
    for name, path in (('full', full_f), ('cc0', cc0_f)):
        rows = []
        with path.open(encoding='utf-8', newline='') as f:
            for row in csv.reader(f, delimiter='\t'):
                if len(row) >= 3 and row[1] == 'eng':
                    rows.append((int(row[0]), row[2]))
        pools[name] = [(i, t) for i, t in rows if is_clean(t, max_tokens)]
        print(f'{name:5s} 英文句 {len(rows):>9,}  过滤后 {len(pools[name]):>9,}')
    return pools


# ---------------- 探针 1：主格/宾格 ----------------

PRON_PAT = re.compile(r'^(I|He|She|We|They|You)\s+([A-Za-z]+)\s+(me|him|her|us|them|you)\b(.*)$')


def probe_pronoun_case(pool):
    """`主语代词 + 动词 + 宾语代词` → 按 (动词, 其余部分) 聚合出最小对立对。"""
    groups = defaultdict(dict)      # (verb, rest) -> {(subj, obj): (sid, text)}
    hits = 0
    for sid, text in pool:
        m = PRON_PAT.match(text.strip())
        if not m:
            continue
        subj, verb, obj, rest = m.group(1).lower(), m.group(2).lower(), m.group(3), m.group(4)
        if subj == obj == 'you':
            continue                                   # you...you 不是格对比
        if OBJ2SUBJ.get(obj) == subj:
            continue                                   # I ... me 同一人称，不是格对比
        hits += 1
        groups[(verb, norm(rest))][(subj, obj)] = (sid, text)

    pairs, verbs = [], set()
    for (verb, _rest), forms in groups.items():
        for (subj, obj), a in forms.items():
            b = forms.get((OBJ2SUBJ.get(obj), PERSON.get(subj)))
            if b and a[0] < b[0]:
                pairs.append((verb, a, b))
                verbs.add(verb)
    return {
        '句数（含目标结构）': hits,
        '最小对立对': len(pairs),
        '涉及不同动词数': len(verbs),
        '例句': [f'{a[1]}  ⇄  {b[1]}' for _, a, b in pairs[:6]],
    }


# ---------------- 探针 2：单复数 ----------------

DET_ONE = r'(?:a|an|one)'
MANY_WORDS = {'two', 'three', 'four', 'five', 'six', 'ten', 'several', 'many'}
DET_MANY = r'(?:' + '|'.join(sorted(MANY_WORDS)) + r'|a\s+few)'
PLU_PAT = re.compile(
    rf'^([A-Za-z]+)\s+([A-Za-z]+)\s+(?P<det>{DET_ONE}|{DET_MANY})\s+(?P<noun>[A-Za-z]+)(?P<rest>.*)$')


def probe_plural(pool):
    """同一主语、同一动词、同一名词，只在「数量词 + 名词数」上不同 → 最小对立对。"""
    groups = defaultdict(dict)      # (subj, verb, noun_lemma, rest) -> {'one'|'many': (sid,text)}
    hits = 0
    for sid, text in pool:
        m = PLU_PAT.match(text.strip())
        if not m:
            continue
        det = re.sub(r'\s+', ' ', m.group('det')).lower()
        noun = m.group('noun').lower()
        lemma = noun[:-1] if noun.endswith('s') else noun
        kind = 'many' if (det in MANY_WORDS or det == 'a few') else 'one'
        hits += 1
        groups[(m.group(1).lower(), m.group(2).lower(), lemma, norm(m.group('rest')))][kind] = (sid, text)

    pairs = []
    for key, forms in groups.items():
        if 'one' in forms and 'many' in forms:
            pairs.append((key[2], forms['one'], forms['many']))
    return {
        '句数（含目标结构）': hits,
        '最小对立对': len(pairs),
        '涉及不同名词数': len({p[0] for p in pairs}),
        '例句': [f'{a[1]}  ⇄  {b[1]}' for _, a, b in pairs[:6]],
    }


# ---------------- 探针 3：be 的时态 ----------------

BE_PAT = re.compile(r'^(I|He|She|We|They|You)\s+(was|am|will\s+be)\s+([A-Za-z]+)\b(.*)$')


def probe_be_tense(pool):
    """同一主语、同一形容词，三种时态都出现 → 三元组。"""
    groups = defaultdict(set)
    hits = 0
    for sid, text in pool:
        m = BE_PAT.match(text.strip())
        if not m:
            continue
        adj = m.group(3).lower()
        if adj in FUNC:
            continue
        hits += 1
        groups[(m.group(1).lower(), adj)].add(re.sub(r'\s+', ' ', m.group(2).lower()))
    triples = {k: v for k, v in groups.items() if len(v) == 3}
    t2 = {k: v for k, v in groups.items() if len(v) == 2}
    return {
        '句数（含目标结构）': hits,
        '三元组（三时态齐全）': len(triples),
        '二元组（缺一个时态）': len(t2),
        '例句': [f'I {sorted(v)} {k[1]}' for k, v in list(triples.items())[:6]],
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=str(Path(__file__).resolve().parents[2] / 'corpus'))
    ap.add_argument('--max-tokens', type=int, default=8)
    args = ap.parse_args()
    print(f'过滤阈值: 2~{args.max_tokens} 词，无数字/引号/括号/专有名词\n')

    pools = load_pools(Path(args.corpus), args.max_tokens)
    probes = (
        ('主格/宾格（代词格）', probe_pronoun_case),
        ('单复数（a X / two Xs）', probe_plural),
        ('be 时态（was / am / will be）', probe_be_tense),
    )
    for pool_name, pool in pools.items():
        print(f'\n########## 池子 {pool_name}（{len(pool):,} 句）##########')
        for label, fn in probes:
            r = fn(pool)
            print(f'\n== {label} ==')
            for k, v in r.items():
                if k == '例句':
                    continue
                print(f'   {k}: {v}')
            for ex in r['例句']:
                print(f'     · {ex}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
