#!/usr/bin/env python3
"""从真实语料构造题目 —— 「即时生成下一课」里不需要模型的那一半。

原则（用来消除「凭空想象」）：
  · 正确选项 **永远是真实语料原句**，带 sourceId，可追溯、可署名。
  · 干扰项优先级：① 真实语料的**镜像句**（角色互换——正是中文母语者的典型错误）
    ② 对真实句框架的**最小违反**（换错格），自动带错因标签。
  · 每道题都记录每个选项的来源（attested / attested-mirror / constructed），可审计。

输出 out/items-<objective>.json，每条都是 draft，等人工/模型润色解析文案后再生效。

用法：python scripts/build-items.py [--corpus DIR] [--limit N]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

NOISE = re.compile(r'[0-9"“”«»()\[\]{}@#*_/\\…—–]|://')
WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
SUBJ2OBJ = {'i': 'me', 'he': 'him', 'she': 'her', 'we': 'us', 'they': 'them', 'you': 'you'}
OBJ2SUBJ = {v: k for k, v in SUBJ2OBJ.items()}
PRON_PAT = re.compile(r'^(I|He|She|We|They|You)\s+([A-Za-z]+)\s+(me|him|her|us|them|you)\b(.*)$')
FUNC = {'in', 'on', 'at', 'to', 'with', 'for', 'from', 'of'}


def norm(t: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z ]+', ' ', t.lower())).strip()


def clean(text: str, max_tokens: int = 8) -> bool:
    if NOISE.search(text):
        return False
    t = WORD.findall(text)
    return 2 <= len(t) <= max_tokens and all(not w[0].isupper() for w in t[1:])


def match_case(src_word: str, repl: str) -> str:
    return repl.capitalize() if src_word[0].isupper() else repl


def inflection_ok(subj: str, verb: str) -> bool:
    """第三人称单数主语后面动词必须带 -s。Tatoeba 是众包语料，
    'He miss me.' 这种不合法英语确实存在 —— attested ≠ correct，必须挡。"""
    if subj in ('he', 'she'):
        return verb.endswith('s') or verb in {'is', 'has', 'does', 'was'}
    return True


def build_pairs(eng: dict[int, str]):
    """返回 [(sid_a, text_a, sid_b, text_b, verb, subj, obj, ok)]，A/B 互为镜像。
    ok=False 表示变形可疑（如实测到的 'He miss me.'），留待人工复核。"""
    groups: dict[tuple, dict] = defaultdict(dict)
    for sid, text in eng.items():
        m = PRON_PAT.match(text.strip())
        if not m or not clean(text):
            continue
        subj, verb, obj, rest = m.group(1).lower(), m.group(2).lower(), m.group(3), m.group(4)
        if subj == obj == 'you' or OBJ2SUBJ.get(obj) == subj or verb in FUNC:
            continue
        groups[(verb, norm(rest))][(subj, obj)] = (sid, text.strip())

    out = []
    for (verb, _rest), forms in groups.items():
        for (subj, obj), a in sorted(forms.items()):
            b = forms.get((OBJ2SUBJ[obj], SUBJ2OBJ[subj]))
            if b and a[0] < b[0]:
                ok = inflection_ok(subj, verb) and inflection_ok(OBJ2SUBJ[obj], verb)
                out.append((a[0], a[1], b[0], b[1], verb, subj, obj, ok))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=str(Path(__file__).resolve().parents[2] / 'corpus'))
    ap.add_argument('--limit', type=int, default=400)
    ap.add_argument('--out', default='out/items-pronoun-case.json')
    args = ap.parse_args()
    root = Path(args.corpus)

    eng: dict[int, str] = {}
    with (root / 'tatoeba' / 'eng_sentences.tsv').open(encoding='utf-8', newline='') as f:
        for row in csv.reader(f, delimiter='\t'):
            if len(row) >= 3 and row[1] == 'eng':
                eng[int(row[0])] = row[2]
    print(f'Tatoeba 英文: {len(eng):,} 句')

    pairs = build_pairs(eng)
    print(f'代词格最小对立对: {len(pairs)}')

    # 只为候选句拉中文翻译：流式扫 links.csv，只留命中的 id
    want = {sid for p in pairs for sid in (p[0], p[2])}
    tr: dict[int, set[int]] = defaultdict(set)
    with (root / 'tatoeba' / 'links.csv').open(encoding='utf-8', newline='') as f:
        for row in csv.reader(f, delimiter='\t'):
            if len(row) < 2:
                continue
            try:
                a, b = int(row[0]), int(row[1])
            except ValueError:
                continue
            if a in want:
                tr[a].add(b)
            elif b in want:
                tr[b].add(a)
    cmn_ids = {i for ids in tr.values() for i in ids}
    zh: dict[int, str] = {}
    with (root / 'tatoeba' / 'cmn_sentences.tsv').open(encoding='utf-8', newline='') as f:
        for row in csv.reader(f, delimiter='\t'):
            if len(row) >= 3 and row[1] == 'cmn' and int(row[0]) in cmn_ids:
                zh[int(row[0])] = row[2]
    print(f'候选句中有中文翻译的: {sum(1 for s in want if any(i in zh for i in tr.get(s, ())))}')

    def zh_of(sid: int) -> str | None:
        for i in sorted(tr.get(sid, ())):
            if i in zh:
                return zh[i]
        return None

    items, with_zh = [], 0
    ok_pairs = [p for p in pairs if p[7]]
    suspect = len(pairs) - len(ok_pairs)
    print(f'  变形可疑（如 He miss me.）：{suspect} 对 → 标记待复核，不默认入题')
    for sid_a, text_a, sid_b, text_b, verb, subj, obj, _ok in ok_pairs[: args.limit]:
        subj_w, obj_w = text_a.split()[0], text_a.split()[2].rstrip('.!?')
        bad_subj = text_a.replace(subj_w, match_case(subj_w, SUBJ2OBJ[subj_w.lower()]), 1)
        bad_obj = text_a.replace(obj_w, match_case(obj_w, OBJ2SUBJ[obj_w.lower()]), 1)
        if bad_obj == text_a:                      # you 没有变化形式，跳过
            continue
        vid = f'{verb}:{subj}-{obj}'
        gloss = zh_of(sid_a)

        if gloss:
            with_zh += 1
            items.append({
                'objectiveId': 's2', 'skill': 's2', 'type': 'choice',
                'prompt': f'「{gloss}」',
                'options': [text_a, text_b, bad_subj, bad_obj],
                'answer': text_a,
                'tts': text_a,
                'explain': f'做动作的是 {subj_w}（主体·主格），挨动作的是 {obj_w}（对象·宾格）；含义不同，形式就得不同。',
                'variantGroupId': vid,
                'optionOrigin': {text_a: 'attested', text_b: 'attested-mirror',
                                 bad_subj: 'constructed', bad_obj: 'constructed'},
                'errorTags': {text_b: ['role-reversed'], bad_subj: ['case-form-subject'],
                              bad_obj: ['case-form-object']},
                'sourceId': {'answer': f'tatoeba:{sid_a}', 'mirror': f'tatoeba:{sid_b}'},
                'reviewStatus': 'draft',
            })

        items.append({
            'objectiveId': 's2', 'skill': 's2', 'type': 'choice',
            'prompt': text_a.replace(obj_w, '___', 1) + ('  ' + f'（{gloss}）' if gloss else ''),
            'options': [obj_w, OBJ2SUBJ[obj_w.lower()], obj_w.lower().replace(obj_w.lower(), subj_w.lower()) + 's', obj_w + 's'],
            'answer': obj_w,
            'tts': text_a,
            'explain': f'这里要"挨动作的那个"，用宾格 {obj_w}。',
            'variantGroupId': vid, 'optionOrigin': {'answer': 'attested', 'frame': f'tatoeba:{sid_a}'},
            'errorTags': {}, 'sourceId': {'frame': f'tatoeba:{sid_a}'}, 'reviewStatus': 'draft',
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'\n写出 {len(items)} 题（其中 {with_zh} 题带中文意思）→ {out}')
    print('\n=== 样例 ===')
    for it in items[:3]:
        print(json.dumps(it, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
