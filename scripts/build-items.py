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



# ---------------- 其余知识点：检索层同样覆盖 ----------------

PRON_FORMS = (r"(?:I|me|my|mine|myself|he|him|his|himself|she|her|hers|herself"
              r"|we|us|our|ours|ourselves|they|them|their|theirs|themselves"
              r"|you|your|yours|yourself|yourselves|it|its|itself)")
FRAME_MASK = re.compile(r'\b' + PRON_FORMS + r'\b', re.I)


def read_conllu_texts(folder: Path) -> list[str]:
    out = []
    for f in sorted(folder.glob('*.conllu')):
        for line in f.open(encoding='utf-8'):
            if line.startswith('# text ='):
                out.append(line[9:].strip())
    return out


def build_s3_possessive(root: Path, limit: int) -> list[dict]:
    """s3 my/mine 等物主代词：用 UD_English-Pronouns 的交替框架（CC BY-SA 4.0）。

    该树库专为代词交替而造：同一句框架下换代词，例如 `_ is _` →
    It is hers. / It is his. / It is mine. / It is theirs. / It is yours.
    整组互为选项、每句各作一次答案 —— 参考句全部真实，且是唯一一个许可干净的高质来源。
    """
    texts = read_conllu_texts(root / 'ud' / 'UD_English-Pronouns-master')
    groups: dict[str, list[str]] = defaultdict(list)
    for t in texts:
        groups[FRAME_MASK.sub('_', t.lower()).strip(' .!?')].append(t)
    items: list[dict] = []
    for frame, members in sorted(groups.items()):
        members = sorted(set(members))
        if not 3 <= len(members) <= 5:
            continue
        for ans in members:
            items.append({
                'objectiveId': 's3', 'skill': 's3', 'type': 'choice', 'kind': 'meaning',
                'prompt': '', 'promptNeedsGloss': True,
                'options': list(members), 'answer': ans, 'tts': ans, 'explain': '',
                'variantGroupId': f'poss:{frame[:40]}',
                'optionOrigin': {m: 'attested' for m in members},
                'errorTags': {},
                'sourceId': {'cluster': 'ud-en-pronouns', 'frame': frame},
                'reviewStatus': 'draft',
            })
    return items[:limit] if limit else items


BASE_PAT = re.compile(r'^(I|You|We|They)\s+([a-z]+)\s+(.*)$')
THIRD_PAT = re.compile(r'^(He|She)\s+([a-z]+s)\s+(.*)$')


def build_s4_third_person(eng: dict[int, str], limit: int) -> list[dict]:
    """s4 三单：同一动词同一宾语下 `I like apples.` ⇄ `He likes apples.` 的真实对立。"""
    base: dict[tuple, dict] = defaultdict(dict)
    third: dict[tuple, dict] = defaultdict(dict)
    for sid, text in eng.items():
        if not clean(text):
            continue
        t = text.strip()
        m = BASE_PAT.match(t)
        if m:
            base[(m.group(2), norm(m.group(3)))][m.group(1).lower()] = (sid, t)
            continue
        m = THIRD_PAT.match(t)
        if m and len(m.group(2)) > 2:
            third[(m.group(2)[:-1], norm(m.group(3)))][m.group(1).lower()] = (sid, t)

    items: list[dict] = []
    for key in sorted(set(base) & set(third)):
        verb, _rest = key
        b = sorted(base[key].items())[0][1]
        h = sorted(third[key].items())[0][1]
        if b[1] == h[1]:
            continue
        bad_third = re.sub(rf'\b{verb}s\b', verb, h[1], count=1)      # He like apples.
        bad_base = re.sub(rf'\b{verb}\b', verb + 's', b[1], count=1)  # I likes apples.
        if bad_third == h[1] or bad_base == b[1]:
            continue
        for ans, other, sid in ((h[1], b[1], h[0]), (b[1], h[1], b[0])):
            items.append({
                'objectiveId': 's4', 'skill': 's4', 'type': 'choice', 'kind': 'meaning',
                'prompt': '', 'promptNeedsGloss': True,
                'options': [ans, other, bad_third, bad_base], 'answer': ans, 'tts': ans,
                'explain': '', 'variantGroupId': f'third:{verb}:{norm(other)[:24]}',
                'optionOrigin': {ans: 'attested', other: 'attested', bad_third: 'constructed',
                                 bad_base: 'constructed'},
                'errorTags': {bad_third: ['verb-form-third'], bad_base: ['verb-form-base']},
                'sourceId': {ans: f'tatoeba:{sid}'},
                'reviewStatus': 'draft',
            })
    return items[:limit] if limit else items


def write_items(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'    → {path}  ({len(items)} 题)')


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
                'objectiveId': 's2', 'skill': 's2', 'type': 'choice', 'kind': 'meaning',
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
            'objectiveId': 's2', 'skill': 's2', 'type': 'choice', 'kind': 'frame',
            'sentence': text_a,
            'prompt': text_a.replace(obj_w, '___', 1),
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
    print(f'\n写出 s2 主格/宾格 {len(items)} 题（其中 {with_zh} 题带中文意思）→ {out}')
    print('s3 物主代词（UD_English-Pronouns 交替框架，CC BY-SA 4.0）：')
    write_items(Path('out/items-s3-possessive.json'), build_s3_possessive(root, args.limit))
    print('s4 三单（Tatoeba 真实对立）：')
    write_items(Path('out/items-s4-thirdperson.json'), build_s4_third_person(eng, args.limit))
    print('\n=== 样例 ===')
    for it in items[:3]:
        print(json.dumps(it, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
