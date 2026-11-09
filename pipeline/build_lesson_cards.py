#!/usr/bin/env python3
"""Build the lesson-1 recognition card payload from the reviewed content draft.

Usage:
  python -I -X utf8 pipeline/build_lesson_cards.py \
    --content ../课稿-校对版/万词班最终季/第01课-词卡底稿/04-词卡内容底稿.json

Reads build/vocab/cfcm-words.json and the current root-universe learning
projection. Writes build/vocab/cfcm-01-01-cards.json (local, not committed).
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
VOCAB = ROOT / 'build/vocab/cfcm-words.json'
LEARNING = ROOT / 'build/root-universe/learning/cfcm-01/current.json'
OUT = ROOT / 'build/vocab/cfcm-01-01-cards.json'
LESSON = 'cfcm-01-01'


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def norm(word):
    return re.sub(r'\s+', '', str(word).casefold())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--content', required=True, help='reviewed 04-词卡内容底稿.json')
    parser.add_argument('--out', default=str(OUT))
    args = parser.parse_args()
    content = load(args.content)
    vocab = {norm(w['w']): w for b in load(VOCAB)['batches'] for w in b['words']}
    pointer = load(LEARNING)
    entry = load(LEARNING.parent / 'versions' / pointer['version'] / 'entry.json')
    universe = {norm(w['word']): w for w in entry['words']}
    roots = {r['id']: r for r in entry['roots']}
    branch_of, word_by_id = {}, {w['id']: w for w in entry['words']}
    for branch in entry['alliance']['branches']:
        for wid in branch['word_ids']:
            branch_of[wid] = branch
    cards, seen = [], set()
    for card in sorted(content['word_cards'], key=lambda c: min(c['handout_indices'])):
        key = norm(card['word'])
        if key in seen:
            continue
        seen.add(key)
        existing = card.get('existing_vocab') or {}
        store_key = norm(existing.get('normalized_existing_key') or card['word'])
        word = card['word']
        v = vocab.get(key) or vocab.get(store_key)
        u = universe.get(key) or universe.get(store_key)
        rids = (u or {}).get('root_ids') or []
        root = roots.get(rids[0]) if rids else None
        branch = branch_of.get(u['id']) if u else None
        neighbors = []
        if branch:
            for wid in branch['word_ids']:
                nw = word_by_id.get(wid)
                if nw and norm(nw['word']) != key:
                    neighbors.append(nw['word'])
        first = next(e for e in content['handout_entries'] if e['index'] == min(card['handout_indices']))
        cards.append({
            'key': store_key,
            'word': word,
            'ipa': (v or {}).get('ipa', ''),
            'def': first['handout_meaning_original'],
            'note': card.get('teacher_explanation'),
            'group': first['group'],
            'groupName': first['root_label'],
            'groupLabel': (branch['title'].split('·')[0].strip() if branch else first['root_label']),
            'relationKind': (u or {}).get('relation_kind', ''),
            'rootLabel': (root or {}).get('label', ''),
            'rootMeaning': (root or {}).get('meaning', ''),
            'rootExplain': (u or {}).get('explanation', ''),
            'rootOrigin': (root or {}).get('origin', ''),
            'rootExample': (u or {}).get('example') or None,
            'neighbors': neighbors[:8],
            'example': (v or {}).get('sen', ''),
            'exampleZh': (v or {}).get('senZh', ''),
        })
    payload = {
        'schema_version': 1,
        'lessonId': LESSON,
        'title': '万词班·最终季 第01课',
        'total': len(cards),
        'noted': sum(1 for c in cards if c['note']),
        'source': {
            'content_sha256': sha(args.content),
            'vocab_sha256': sha(VOCAB),
            'entry_version': pointer['version'],
        },
        'cards': cards,
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes((json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    print(json.dumps({'ok': True, 'out': str(out), 'cards': len(cards), 'noted': payload['noted'], 'bytes': out.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    main()
