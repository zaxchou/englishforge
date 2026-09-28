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
from datetime import datetime
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
    ap.add_argument('--items', nargs='+',
                    default=['out/items-pronoun-case.enriched.json',
                             'out/items-s2-case-ewt.enriched.json'],
                    help='可给多个文件，按顺序合并后再轮转取样')
    ap.add_argument('--out', default='src/data/pilots/subject-object.ts')
    ap.add_argument('--limit', type=int, default=20)
    args = ap.parse_args()

    src: list[dict] = []
    for f in args.items:
        path = Path(f)
        if not path.exists():
            print(f'  跳过（不存在）：{f}')
            continue
        loaded = json.loads(path.read_text(encoding='utf-8'))
        print(f'  读入 {len(loaded):3d} 题 ← {f}')
        src += loaded
    # 按动词分桶后轮转取样：直接取前 N 条只会拿到字母序开头那几个动词，
    # 种子集就名不副实地"看起来多样、实际重复"。
    buckets: dict[str, list[dict]] = {}
    seen = set()
    for it in src:
        if not it.get('langCheck', {}).get('ok') or not it.get('gloss'):
            continue
        if any(bad in ' '.join(it['options']) for bad in ILLEGAL):
            continue
        if it.get('langCheck', {}).get('ambiguous'):
            continue            # 给定中文无法唯一确定答案 → 真歧义，不进种子
        # multiError（干扰项本身不合语法）不直接丢弃：写进审核单让人判断
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
        '// 署名：句子源自 Tatoeba（CC BY 2.0 FR）与 UD_English-EWT（CC BY-SA 4.0），逐题出处见 sourceRef。',
        "import type { Question } from '../../types'",
        '',
        'export const subjectObjectPilot: Question[] = [',
    ]
    for n, it in enumerate(picked, 1):
        o = it['options']
        if it.get('kind') == 'frame':
            tags = [POSS_TAG[i] for i in (1, 2, 3)]
            opt_tags = {o[i]: [POSS_TAG[i]] for i in (1, 2, 3)}
            fb = {o[i]: POSS_FB[i] for i in (1, 2, 3)}
            source = it['sourceId'].get('frame', '')
        else:
            opt_tags = {k: list(v) for k, v in (it.get('errorTags') or {}).items() if k in o}
            tags = sorted({t for v in opt_tags.values() for t in v})
            fb = {opt: TAG_FB[t] for opt, v in opt_tags.items() for t in v if t in TAG_FB}
            source = it['sourceId'].get('answer', '')
        # 逐项纠正：优先用模型生成的那句（说明"选它等于在说什么意思"），退回模板
        fixes = {k: v for k, v in (it.get('optionFixes') or {}).items() if k in o and k != it['answer']}
        for k, v in fixes.items():
            fb[k] = v
        lines += [
            '  {',
            # 框架填空给了四个选项，本质是识别题 → diff 1；中文意思题要自己产出形式 → diff 2。
            # 顺带让语料题分布在两个桶里，不会因为全挤进进阶桶而极少被抽到。
            f"    id: 'soq{n:02d}', skill: 's2', type: 'choice', diff: {1 if it.get('kind') == 'frame' else 2},",
            f"    prompt: {quote(it['prompt'])},",
            '    options: [' + ', '.join(quote(x) for x in o) + '],',
            f"    answer: {quote(it['answer'])},",
            f"    tts: {quote(it.get('tts') or it['answer'])},",
            f"    explain: {quote(it.get('explain', ''))},",
            "    objectiveId: 's2-case',",
            f"    variantGroupId: {quote(it['variantGroupId'])},",
            f"    errorTags: [{', '.join(quote(t) for t in tags)}],",
            '    optionFeedback: {' + ', '.join(f'{quote(k)}: {quote(v)}' for k, v in fb.items()) + '},',
            '    optionTags: {' + ', '.join(f'{quote(k)}: [{", ".join(quote(t) for t in v)}]' for k, v in opt_tags.items()) + '},',
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
    write_review_sheet(picked, Path('docs/curriculum/review-subject-object.md'))
    for it in picked[:3]:
        print(f"  · {it['prompt'][:30]:32s} {it['options']}")
    return 0


def write_review_sheet(picked: list[dict], path: Path) -> None:
    """生成人工审核单：把种子题一次列全，便于逐题核对（不用在练习里碰运气）。"""
    KIND = {'meaning': '中文意思题', 'frame': '框架填空'}
    rows = [
        '# 主宾格种子题 · 人工审核单（R1-02）',
        '',
        '由 `scripts/make-pilot.py` 生成，请勿手改。题面、选项、解析、出处一次列全，',
        '便于**逐题核对**；改完在每题的「判定」行勾选，或直接告诉我要改哪几道。',
        '',
        '这些题目前的信任级别是 `draft`：可练习，但**不参与能力认证**。',
        '出处徽章在 app 里显示为「语料」（悬停可见具体 sourceRef）。',
        '',
        f'共 {len(picked)} 题。',
        '',
        '| # | 类型 | 动词 | 出处 |',
        '|---|---|---|---|',
    ]
    for n, it in enumerate(picked, 1):
        verb = it['variantGroupId'].split(':')[0]
        src = (it.get('sourceId') or {}).get('answer') or (it.get('sourceId') or {}).get('frame') or ''
        rows.append(f"| {n} | {KIND.get(it.get('kind'), it.get('kind'))} | {verb} | `{src}` |")
    rows.append('')
    for n, it in enumerate(picked, 1):
        verb = it['variantGroupId'].split(':')[0]
        src = (it.get('sourceId') or {}).get('answer') or (it.get('sourceId') or {}).get('frame') or ''
        origin = it.get('optionOrigin', {})
        rows += [
            f"## {n:02d} · {KIND.get(it.get('kind'), it.get('kind'))} · {verb}",
            '',
            f"- **题干**：{it['prompt']}",
            f"- **正确**：`{it['answer']}`  ·  来源 `{src}`（{origin.get(it['answer'], '—')}）",
            '- **干扰项**：',
        ]
        for o in it['options']:
            if o == it['answer']:
                continue
            if it.get('kind') == 'frame':
                idx = it['options'].index(o)
                tags_o = [POSS_TAG[idx]] if idx in POSS_TAG else []
            else:
                tags_o = (it.get('errorTags') or {}).get(o, [])
            tag = '、'.join(tags_o) or '—'
            rows.append(f"    - `{o}`　错因：{tag}　来源：{origin.get(o, '—')}")
        if it.get('langCheck', {}).get('multiError'):
            rows.append(f"- ⚠️ **干扰项另有错处**：{it['langCheck'].get('note', '')}")
        if it.get('langCheck', {}).get('problem'):
            rows.append(f"- ⚠️ **语言问题**：{it['langCheck']['problem']}")
        rows += [
            f"- **解析**：{it.get('explain', '')}",
            '- **判定**：☐ 通过　☐ 要改　☐ 毙掉　（备注：　）',
            '',
        ]
    rows.append('---')
    rows.append('')
    rows.append(f'最后生成：{datetime.now().strftime("%Y-%m-%d %H:%M")}')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(rows) + '\n', encoding='utf-8')
    print(f'审核单 → {path}')


if __name__ == '__main__':
    raise SystemExit(main())
