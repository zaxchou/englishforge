#!/usr/bin/env python3
"""Build a lesson's recognition card payload from the reviewed content draft.

Usage (lesson id is required; every output path is derived from it):
  python -I -X utf8 pipeline/build_lesson_cards.py \
    --lesson cfcm-01-01 \
    --content ../课稿-校对版/万词班最终季/第01课-词卡底稿/04-词卡内容底稿.json

Reads build/vocab/cfcm-words.json and the course's root-universe learning
projection (build/root-universe/learning/<course>/current.json). Writes
build/vocab/<lessonId>-cards.json (local, not committed). Refuses to overwrite
an existing cards file that belongs to a different lessonId.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
VOCAB = ROOT / 'build/vocab/cfcm-words.json'


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def norm(word):
    return re.sub(r'\s+', '', str(word).casefold())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lesson', required=True, help='lesson id, e.g. cfcm-01-01')
    parser.add_argument('--content', required=True, help='reviewed 04-词卡内容底稿.json')
    parser.add_argument('--title', default=None, help='display title; default 万词班·最终季 第NN课')
    parser.add_argument('--learning', default=None, help='root-universe current.json; default derived from course id')
    parser.add_argument('--out', default=None, help='output path; default build/vocab/<lessonId>-cards.json')
    args = parser.parse_args()

    lesson = args.lesson.strip()
    if not re.fullmatch(r'cfcm-\d+-\d+', lesson):
        parser.error('--lesson must look like cfcm-01-01')
    course = 'cfcm-' + lesson.rsplit('-', 1)[1]   # 词根投影按课建：cfcm-01-02 → learning/cfcm-02
    lesson_no = lesson.rsplit('-', 1)[1]
    learning = Path(args.learning) if args.learning else ROOT / f'build/root-universe/learning/{course}/current.json'
    out = Path(args.out) if args.out else ROOT / f'build/vocab/{lesson}-cards.json'
    title = args.title or f'万词班·最终季 第{lesson_no}课'
    if out.exists():
        try:
            prev = json.loads(out.read_text(encoding='utf-8-sig'))
            if prev.get('lessonId') and prev['lessonId'] != lesson:
                parser.error(f'{out} already belongs to {prev["lessonId"]}; refusing to overwrite')
        except ValueError:
            pass

    content = load(args.content)
    vocab = {norm(w['w']): w for b in load(VOCAB)['batches'] for w in b['words']}
    pointer = load(learning)
    entry = load(learning.parent / 'versions' / pointer['version'] / 'entry.json')
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
        'lessonId': lesson,
        'title': title,
        'total': len(cards),
        'noted': sum(1 for c in cards if c['note']),
        'source': {
            'content_sha256': sha(args.content),
            'vocab_sha256': sha(VOCAB),
            'entry_version': pointer['version'],
        },
        'cards': cards,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes((json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    print(json.dumps({'ok': True, 'lesson': lesson, 'out': str(out), 'cards': len(cards), 'noted': payload['noted'], 'bytes': out.stat().st_size}, ensure_ascii=False))


if __name__ == '__main__':
    main()
