#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 out/ 里语料管线生成的题**导进某个账户的题库**（数据库 items 表）。

为什么走这条路（而不是把题写进仓库的 .ts）：
  · 题是从 Tatoeba / UD 语料派生的，进公开仓库要处理署名与许可；进账户就只是"这个人的练习材料"；
  · 题库属于账户 —— 谁的题跟着谁走，可查询、可对照、可逐题定版；
  · 同一道题重复导入只更新不产生副本（itemId 幂等），所以管线可以反复生成、反复替换。

用法：
  python scripts/push-items.py                     # 全部技能、全部题（默认只导未在仓库里的）
  python scripts/push-items.py --skill s3          # 只导物主代词
  python scripts/push-items.py --skill s4 --limit 60
  python scripts/push-items.py --dry-run           # 只报告会导什么，不发请求
  python scripts/push-items.py --account acc_xxx   # 指定账户（默认第一个）
  python scripts/push-items.py --url http://localhost:4173
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
OUT = REPO / 'out'
PILOT = REPO / 'src' / 'data' / 'pilots' / 'subject-object.ts'

# 语料出处 → 中文题干的说明（与 make-pilot.py 保持一致）
LESSON_ANCHOR = '张俊杰第7课16-22段'
# 每种技能对应的内容合同锚点（写进 sourceRef，便于回溯"这题为什么这样出"）
SKILL_ANCHOR = {
    's2': '张俊杰第7课16-22段',
    's3': '张俊杰第7课23-27段',
    's4': '张俊杰第7课28-33段',
}
# 从仓库题里提取已存在的出处，避免同一句语料进两次
SOURCE_REF_RE = re.compile(r'sourceRef:\s*"([^"]+)"')


def api(url: str, path: str, payload=None, method='GET'):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url.rstrip('/') + path, data=data, method=method,
                                 headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')[:300]
        raise SystemExit(f'接口出错 {e.code}：{body}')
    except urllib.error.URLError as e:
        raise SystemExit(f'连不上应用（{url}）：{e.reason}\n先启动应用（start.bat 或 npm run dev）再试。')


def load_items(skill: str | None) -> list[dict]:
    """优先用 enriched（模型判过、带 optionFixes/gloss 的那份）"""
    files: list[Path] = []
    for p in sorted(OUT.glob('items-*.json')):
        if 'enriched' in p.name:
            continue
        enriched = p.with_name(p.stem + '.enriched.json')
        files.append(enriched if enriched.exists() else p)
    items: list[dict] = []
    for p in files:
        raw = json.loads(p.read_text(encoding='utf-8'))
        arr = raw if isinstance(raw, list) else raw.get('items', [])
        for it in arr:
            it['_file'] = p.name
            items.append(it)
    if skill:
        items = [it for it in items if (it.get('skill') or '') == skill]
    return items


def existing_sources() -> set[str]:
    """仓库里已经有的题的出处（避免与已提交的 20 道种子题重复）"""
    if not PILOT.exists():
        return set()
    out = set()
    for m in SOURCE_REF_RE.finditer(PILOT.read_text(encoding='utf-8')):
        # "张俊杰第7课16-22段 / tatoeba:8475763" → 取语料 id 部分
        parts = [x.strip() for x in m.group(1).split('/')]
        if len(parts) > 1:
            out.add(parts[-1])
    return out


def corpus_id(it: dict) -> str:
    sid = it.get('sourceId') or {}
    if isinstance(sid, dict):
        return sid.get('answer') or sid.get('frame') or next(iter(sid.values()), '')
    return str(sid)


def to_question(it: dict, seen_sources: set[str]) -> dict | None:
    """管线条目 → 前端 Question 契约（字段名与 types.ts 对齐）"""
    o = it.get('options') or []
    answer = it.get('answer') or ''
    skill = it.get('skill') or ''
    if len(o) < 2 or answer not in o or not skill:
        return None
    cid = corpus_id(it)
    if not cid:
        return None
    # 语料出处：同一句已经以别的 id 进过仓库就不重复导
    if cid in seen_sources:
        return None

    # 选项级错因：优先用管线里的 errorTags（{选项: [标签]}），框架题用 1/2/3 位置规则
    opt_tags: dict[str, list[str]] = {}
    for k, v in (it.get('errorTags') or {}).items():
        if k in o and k != answer:
            opt_tags[k] = list(v) if isinstance(v, list) else [str(v)]
    tags = sorted({t for v in opt_tags.values() for t in v})
    fb = {k: v for k, v in (it.get('optionFixes') or {}).items() if k in o and k != answer}

    item_id = f'{skill}:{cid}'
    prompt = it.get('prompt') or ''
    if it.get('promptNeedsGloss') and it.get('gloss') and '（' not in prompt:
        prompt = f'{prompt}  （{it["gloss"]}）'
    return {
        'itemId': item_id,
        'skill': skill,
        'objectiveId': it.get('objectiveId') or skill,
        'type': it.get('type') or 'choice',
        'source': 'corpus',
        'generator': it.get('_file', ''),
        'sourceRef': f'{SKILL_ANCHOR.get(skill, LESSON_ANCHOR)} / {cid}',
        'reviewStatus': 'draft',
        'contentVersion': 1,
        'question': {
            'id': item_id,
            'skill': skill,
            'type': it.get('type') or 'choice',
            'diff': 1 if it.get('kind') == 'frame' else 2,
            'prompt': prompt,
            'options': o,
            'answer': answer,
            'tts': it.get('tts') or answer,
            'explain': it.get('explain') or '',
            'objectiveId': it.get('objectiveId') or skill,
            'variantGroupId': it.get('variantGroupId') or item_id,
            'errorTags': tags,
            'optionFeedback': fb,
            'optionTags': opt_tags,
            'sourceRef': f'{SKILL_ANCHOR.get(skill, LESSON_ANCHOR)} / {cid}',
            'contentVersion': 1,
            'reviewStatus': 'draft',
            'assessmentRole': 'practice',
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description='把 out/ 的语料题导进账户题库')
    ap.add_argument('--url', default='http://localhost:4173', help='应用地址（默认 4173）')
    ap.add_argument('--account', help='账户 id（默认取第一个）')
    ap.add_argument('--skill', help='只导某个思维点（s2/s3/s4）')
    ap.add_argument('--limit', type=int, help='每个技能最多导多少道')
    ap.add_argument('--source', default='corpus', help='来源标签：corpus / generated / manual')
    ap.add_argument('--note', help='批次备注（写进批次表，便于对照）')
    ap.add_argument('--dry-run', action='store_true', help='只报告，不发请求')
    args = ap.parse_args()

    accounts = api(args.url, '/api/accounts')['accounts']
    if not accounts:
        raise SystemExit('数据库里还没有账户 —— 先打开一次应用（会自动建立默认账户）。')
    acct = args.account or accounts[0]['id']
    if args.account and not any(a['id'] == args.account for a in accounts):
        raise SystemExit(f'找不到账户：{args.account}')

    raw = load_items(args.skill)
    seen = existing_sources()
    converted, skipped = [], 0
    for it in raw:
        q = to_question(it, seen)
        if q is None:
            skipped += 1
            continue
        seen.add(corpus_id(it))
        converted.append(q)

    if args.limit:
        # 按技能分别限量，避免大技能把小技能挤掉
        by_skill: dict[str, list[dict]] = {}
        for q in converted:
            by_skill.setdefault(q['skill'], []).append(q)
        converted = [q for lst in by_skill.values() for q in lst[:args.limit]]

    by_skill = {}
    for q in converted:
        by_skill[q['skill']] = by_skill.get(q['skill'], 0) + 1
    print(f'账户：{acct}（{next(a["name"] for a in accounts if a["id"] == acct)}）')
    print(f'待导入 {len(converted)} 道（跳过 {skipped} 道：缺字段 / 出处已在仓库里）· 分布 {by_skill or "{}"}')
    for q in converted[:5]:
        print(f"  · {q['itemId']:28s} {q['question']['prompt'][:40]}")

    if args.dry_run or not converted:
        print('（--dry-run：没有发请求）' if args.dry_run else '（没有需要导入的题）')
        return 0

    res = api(args.url, f'/api/accounts/{acct}/items', {
        'items': converted,
        'batch': {
            'source': args.source,
            'generator': 'push-items.py',
            'note': args.note or f'导入 {len(converted)} 道语料派生题',
            'skill': args.skill,
        },
    }, 'POST')
    print(f"完成：新增 {res['inserted']} · 更新 {res['updated']} · 跳过 {res['skipped']} · 批次 {res['batchId']}")
    stats = api(args.url, f'/api/accounts/{acct}/items')['stats']
    for s in stats['bySkill']:
        print(f"  {s['skill']}: 共 {s['total']} 道（已通过 {s['reviewed']} / 待审 {s['draft']} / 已毙 {s['quarantined']}）· 来源 {s['sources']}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
