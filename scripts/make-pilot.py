#!/usr/bin/env python3
"""把语料派生的题组装成项目里的种子题文件（R1-02）。

输入  out/items-pronoun-case.enriched.json（build-items → enrich-items 的产物）
输出  src/data/pilots/subject-object.ts

原则：
  · 正确选项都是真实语料原句（带 sourceId → 写进 sourceRef，可追溯可署名）
  · reviewStatus 一律 draft：机器校验过 ≠ 人工审核过，按 v6 纪律不得充当能力证据
  · 每个干扰项都带 errorTags 与 optionFeedback（错因标签 + 为什么错）

用法：python scripts/make-pilot.py [--limit 16]
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

POSS_TAG = {1: 'case-form-subject', 2: 'case-form-possessive', 3: 'case-form-reflexive'}
POSS_FB = {
    1: '这里要的是"挨动作的那个"，得用宾格。',
    2: '物主形式（my/his/her…）后面得跟名词，放动词后面不通。',
    3: '反身代词指"自己对自己"，意思就变了。',
}
TAG_FB = {
    'role-reversed': '角色反了——这是把"谁打谁"说反的那一句。',
    'case-form-subject': '做动作的用主格，这里的位置要求宾格。',
    'case-form-object': '挨动作的用宾格，这里的位置要求主格。',
}
ILLEGAL = {'He miss', 'She miss'}


def quote(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--items', default='out/items-pronoun-case.enriched.json')
    ap.add_argument('--out', default='src/data/pilots/subject-object.ts')
    ap.add_argument('--limit', type=int, default=16)
    args = ap.parse_args()

    src = json.loads(Path(args.items).read_text(encoding='utf-8'))
    # 按动词分桶后轮转取样：直接取前 N 条只会拿到字母序开头那几个动词，
    # 种子集就名不副实地"看起来多样、实际重复"。
    buckets: dict[str, list[dict]] = {}
    seen = set()
    for it in src:
        if not it.get('langCheck', {}).get('ok') or not it.get('gloss'):
            continue
        if any(bad in ' '.join(it['options']) for bad in ILLEGAL):
            continue
        if it.get('langCheck', {}).get('distractorIssue'):
            continue                                   # 有歧义/污染告警的先不进种子
        key = (it['variantGroupId'], it.get('kind'))
        if key in seen:
            continue
        seen.add(key)
        buckets.setdefault(it['variantGroupId'].split(':')[0], []).append(it)

    picked: list[dict] = []
    while len(picked) < args.limit:
        added = False
        for verb in sorted(buckets):
            if not buckets[verb]:
                continue
            # 每个动词优先出一题"中文意思题"，再出"框架填空题"
            pool = buckets[verb]
            prefer = next((x for x in pool if x.get('kind') == 'meaning'), pool[0])
            pool.remove(prefer)
            picked.append(prefer)
            added = True
            if len(picked) >= args.limit:
                break
        if not added:
            break

    lines: list[str] = [
        '// 由 scripts/make-pilot.py 生成 —— 请勿手改。',
        '// 数据来源：语料派生的主宾格练习（R1-02）。正确选项均为真实语料原句，',
        '// 干扰项来自真实镜像句或对真实框架的最小违反；中文释义与解析由模型生成后待人工过目。',
        '// 生成命令：python scripts/build-items.py && python scripts/enrich-items.py && python scripts/make-pilot.py',
        '// 署名：句子源自 Tatoeba（CC BY 2.0 FR），逐题出处见 sourceRef。',
        "import type { Question } from '../../types'",
        '',
        'export const subjectObjectPilot: Question[] = [',
    ]
    for n, it in enumerate(picked, 1):
        o = it['options']
        if it.get('kind') == 'frame':
            tags = [POSS_TAG[i] for i in (1, 2, 3)]
            fb = {o[i]: POSS_FB[i] for i in (1, 2, 3)}
            source = it['sourceId'].get('frame', '')
        else:
            tags = sorted({t for v in it.get('errorTags', {}).values() for t in v})
            fb = {opt: TAG_FB[t] for opt, v in it.get('errorTags', {}).items() for t in v if t in TAG_FB}
            source = it['sourceId'].get('answer', '')
        lines += [
            '  {',
            f"    id: 'soq{n:02d}', skill: 's2', type: 'choice', diff: 2,",
            f"    prompt: {quote(it['prompt'])},",
            '    options: [' + ', '.join(quote(x) for x in o) + '],',
            f"    answer: {quote(it['answer'])},",
            f"    tts: {quote(it.get('tts') or it['answer'])},",
            f"    explain: {quote(it.get('explain', ''))},",
            "    objectiveId: 's2-case',",
            f"    variantGroupId: {quote(it['variantGroupId'])},",
            f"    errorTags: [{', '.join(quote(t) for t in tags)}],",
            '    optionFeedback: {' + ', '.join(f'{quote(k)}: {quote(v)}' for k, v in fb.items()) + '},',
            f"    sourceRef: {quote('张俊杰第7课16-22段 / ' + source)},",
            '    contentVersion: 1,',
            "    reviewStatus: 'draft',",
            "    assessmentRole: 'practice',",
            '  },',
        ]
    lines += [']', '']
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text('\n'.join(lines), encoding='utf-8')
    print(f'写出 {len(picked)} 题 → {out}')
    for it in picked[:3]:
        print(f"  · {it['prompt'][:30]:32s} {it['options']}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
