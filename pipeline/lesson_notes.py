#!/usr/bin/env python3
"""Assemble a lesson's word-card content draft (词卡底稿) from reviewed annotations.

Generic tool: every lesson-specific fact (paths, aliases, held words, evidence
extras, narrative prose) lives in a per-lesson config JSON that quotes classroom
text, so it stays OUTSIDE the repo next to that lesson's QA materials. This file
contains code only — no course content.

Subcommands (CONFIG is the lesson config JSON):
  annotate  CONFIG [--qa-dir DIR]           TSV annotations -> JSON with exact-quote
                                            checks; groups declared as {"json": ...}
                                            are adopted as-is.
  assemble  CONFIG [--qa-dir DIR] [--deliver]
                                            annotations -> staging/00..04 + manifest
                                            + verification.json; --deliver publishes
                                            to the delivery dir atomically (only when
                                            absent/byte-identical).
  verify    CONFIG [--qa-dir DIR]           delivered dir manifest + payload
                                            invariants + locked original checksums.

Config schema (paths relative to the project root unless absolute):
  lesson_id, lesson_no, base_dir, course_dir, delivery_dir,
  files: {transcript, record, proofread_note, subtitles},
  wordlist, vocab, root_entry, qa_dir (default qa dir),
  aliases: {misspelled: canonical},
  annotation_groups: [{tsv, out, range:[a,b], extras:{index:[[time,quote],...]}, evidence_check_out} | {json}],
  supplement_groups: [{tsv, out, extras:{word:[[time,quote],...]}} | {json}],
  hold: [...], structural: [...], structural_exceptions: [...],
  allowed_not_located: [...], merge_expectations: {word: [indices...]},
  caveat_rewrites: {old_substring: new_substring},
  expected: {handout_entries, canonical_words, usable},
  scope, display_policy, etymology_verification,
  prose: { ... lesson narrative templates, see assemble() ... },
  original_lock: {filename: sha256}
"""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import shutil
import tempfile
from collections import Counter

ROOT = Path(__file__).resolve().parents[1]
EXTERNAL = ROOT.parent   # 课稿-校对版/ lives next to the toefl-lab repo
FILES = ['00-整理说明.md', '01-讲义全词课堂对应.md', '02-可用老师讲解文字.md',
         '03-补充词与待确认项.md', '04-词卡内容底稿.json']
STATUS = {'explained': '有讲解', 'brief': '快速带过', 'context-inferred': '拆词/上下文对应',
          'not-located': '未定位', 'uncertain': '解释存疑'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, text):
    path.write_bytes(text.replace('\r\n', '\n').replace('\r', '\n').encode('utf-8'))


def save(path, obj):
    write(path, json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def key(word):
    return re.sub(r'\s+', '', word.casefold())


def clock(t):
    t = int(t)
    return f'{t // 3600:02d}:{t // 60 % 60:02d}:{t % 60:02d}'


class Ctx:
    """Resolved config + shared lookups for one lesson."""

    def __init__(self, config_path, qa_dir=None):
        self.config_path = Path(config_path).resolve()
        self.cfg = load(self.config_path)
        cfg = self.cfg
        self.base = (ROOT / cfg['base_dir']) if not Path(cfg['base_dir']).is_absolute() else Path(cfg['base_dir'])
        self.course_dir = self.base / cfg['course_dir']
        self.delivery_dir = self.base / cfg['delivery_dir']
        self.qa_dir = Path(qa_dir).resolve() if qa_dir else (
            (ROOT / cfg['qa_dir']) if not Path(cfg.get('qa_dir', '')).is_absolute() else Path(cfg['qa_dir']))
        self.transcript = self.course_dir / cfg['files']['transcript']
        self.record_path = self.course_dir / cfg['files']['record']
        self.wordlist_path = self._resolve(cfg['wordlist'])
        self.vocab_path = self._resolve(cfg['vocab'])
        self.root_entry = self._resolve(cfg['root_entry'])
        self.aliases = dict(cfg.get('aliases', {}))

    def _resolve(self, p):
        p = Path(p)
        if p.is_absolute():
            return p
        if str(p).startswith('..'):
            return (ROOT / p).resolve()
        return ROOT / p

    def canonical(self, word, suggested=None):
        if word in self.aliases:
            return self.aliases[word]
        return suggested or word

    # ---- exact-quote evidence (both the record JSON and the transcript markdown) ----
    def evidence_checker(self):
        record = load(self.record_path)
        by_time = {}
        for i, p in enumerate(record['paragraphs']):
            by_time.setdefault(clock(p['start']), []).append((i, p))
        md_lines = {}
        for n, line in enumerate(self.transcript.read_text(encoding='utf-8-sig').splitlines(), 1):
            m = re.match(r'\*\*\[(\d\d:\d\d:\d\d)\]\*\* (.*)', line)
            if m:
                md_lines.setdefault(m[1], []).append((n, m[2]))
        state = {'record': record, 'by_time': by_time, 'md_lines': md_lines, 'citations': 0}

        def check(time, quote):
            found = [(i, p) for i, p in state['by_time'].get(time, []) if quote in p['text']]
            lines = [(n, t) for n, t in state['md_lines'].get(time, []) if quote in t]
            require(len(found) == 1 and len(lines) == 1, f'exact quote mismatch: {time} {quote!r}')
            i, p = found[0]
            state['citations'] += 1
            return {'time': time, 'quote': quote}
        check.state = state
        return check


def cmd_annotate(args):
    ctx = Ctx(args.config, args.qa_dir)
    cfg = ctx.cfg
    words = load(ctx.wordlist_path)['words']
    check = ctx.evidence_checker()
    for spec in cfg.get('annotation_groups', []):
        if 'json' in spec:
            require((ctx.qa_dir / spec['json']).exists(), f'missing adopted annotations {spec["json"]}')
            continue
        rows_out = []
        with (ctx.qa_dir / spec['tsv']).open(encoding='utf-8-sig', newline='') as stream:
            for row in csv.DictReader(stream, delimiter='|'):
                if None in row:
                    raise ValueError(f'bad row: {row}')
                index = int(row['index'])
                word = words[index - 1]
                ev = [check(row['time'], row['quote'])]
                for time, quote in spec.get('extras', {}).get(str(index), []):
                    ev.append(check(time, quote))
                rows_out.append({'index': index, 'word': word['word'],
                                 'canonical_word': ctx.canonical(word['word'], word.get('suggested_spelling')),
                                 'lecture_status': row['lecture_status'], 'evidence': ev,
                                 'teacher_note': None if row['teacher_note'] == '~' else row['teacher_note'],
                                 'note_kind': row['note_kind'],
                                 'caveats': [row['caveats']] if row['caveats'] else []})
        a, b = spec.get('range', [1, len(words)])
        require([r['index'] for r in rows_out] == list(range(a, b + 1)), f'{spec["tsv"]}: index range must be {a}..{b}')
        save(ctx.qa_dir / spec['out'], rows_out)
        if spec.get('evidence_check_out'):
            save(ctx.qa_dir / spec['evidence_check_out'],
                 {'ok': True, 'rows': len(rows_out),
                  'source_sha256': sha(ctx.record_path),
                  'nonempty_note_candidates': sum(r['teacher_note'] is not None for r in rows_out),
                  'note': 'Quotes exactly matched existing corrected paragraphs; no manual audio verification implied.'})
    for spec in cfg.get('supplement_groups', []):
        if 'json' in spec:
            require((ctx.qa_dir / spec['json']).exists(), f'missing adopted supplements {spec["json"]}')
            continue
        supplements = []
        with (ctx.qa_dir / spec['tsv']).open(encoding='utf-8-sig', newline='') as stream:
            for row in csv.DictReader(stream, delimiter='|'):
                if None in row:
                    raise ValueError(f'bad supplement row: {row}')
                evidence = [check(row['time'], row['quote'])]
                for time, quote in spec.get('extras', {}).get(row['word'], []):
                    evidence.append(check(time, quote))
                supplements.append({'word': row['word'], 'lecture_status': row['lecture_status'],
                                    'evidence': evidence,
                                    'teacher_note': None if row['teacher_note'] == '~' else row['teacher_note'],
                                    'note_kind': row['note_kind'],
                                    'caveats': [row['caveats']] if row['caveats'] else []})
        save(ctx.qa_dir / spec['out'], supplements)
    print(json.dumps({'ok': True, 'citations': check.state['citations'], 'qa_dir': str(ctx.qa_dir)}, ensure_ascii=False))


def cmd_assemble(args):
    ctx = Ctx(args.config, args.qa_dir)
    cfg = ctx.cfg
    expected = cfg['expected']
    prose = cfg['prose']
    material = load(ctx.wordlist_path)
    words, groups = material['words'], {g['group']: g for g in material['groups']}
    vocab = {key(w['w']): w for b in load(ctx.vocab_path)['batches'] for w in b['words']}
    universe = {key(w['word']): w for w in load(ctx.root_entry)['words']}
    source_rel = f'../{cfg["course_dir"]}/{cfg["files"]["transcript"]}'

    def refs(ev):
        return '；'.join(f'[{x["time"]}]({source_rel}:{x["transcript_line"]})' for x in ev)

    checker = ctx.evidence_checker()

    def ev1(item):
        time, quote = item['time'], item['quote']
        found = [(i, p) for i, p in checker.state['by_time'].get(time, []) if quote in p['text']]
        lines = [(n, t) for n, t in checker.state['md_lines'].get(time, []) if quote in t]
        require(len(found) == 1 and len(lines) == 1, f'exact quote mismatch: {time} {quote!r}')
        i, p = found[0]
        checker.state['citations'] += 1
        return {**item, 'paragraph_index': i, 'start': p['start'], 'end': p['end'],
                'segment_ids': p['segment_ids'], 'transcript_line': lines[0][0],
                'editor_insert_present': '［' in quote,
                'timing_use': 'internal provenance only; no learner video replay required'}

    def clean_caveats(items):
        rewrites = cfg.get('caveat_rewrites', {})
        return [x for x in (rewrites.get(v, v) for v in items)]

    def note_readiness(word, row):
        if not row.get('teacher_note'):
            return 'none'
        if word in set(cfg.get('hold', [])) or row['lecture_status'] in ('not-located', 'uncertain'):
            return 'needs-confirmation'
        if row['lecture_status'] == 'context-inferred' and word not in set(cfg.get('structural', [])) \
                and word not in set(cfg.get('structural_exceptions', [])):
            return 'needs-confirmation'
        return 'usable-text-draft'

    def existing(word, original=None):
        v = vocab.get(key(word))
        matched = word
        if v is None and original:
            v, matched = vocab.get(key(original)), original
        return None if v is None else {'word': v['w'], 'matched_as': matched, 'first_lesson': v['lesson'],
            'also': v.get('also', []),
            'current_lesson_in_material_sources': cfg['lesson_no'] in [v['lesson'], *v.get('also', [])],
            'rename_needed': key(v['w']) != key(word), 'normalized_existing_key': key(v['w'])}

    def root_link(word, original=None):
        u = universe.get(key(word)) or (universe.get(key(original)) if original else None)
        return None if u is None else {'word': u['word'], 'id': u['id'], 'query_id': u['query_id'],
            'root_ids': u['root_ids'], 'relation_kind': u['relation_kind'],
            'basis': 'classroom learning projection; not an independent etymology certification'}

    annotation_files = [s.get('json') or s['out'] for s in cfg.get('annotation_groups', [])]
    annotations = []
    for name in annotation_files:
        annotations += load(ctx.qa_dir / name)
    require([a['index'] for a in annotations] == list(range(1, expected['handout_entries'] + 1)),
            'must cover all handout entries exactly in order')
    targets = []
    for a in annotations:
        i = a['index']
        w = words[i - 1]
        require(a['word'] == w['word'], f'wrong handout word {i}')
        canonical = ctx.canonical(w['word'], w.get('suggested_spelling'))
        require(a['canonical_word'] == canonical, f'canonical mismatch {i}')
        require(a['lecture_status'] in STATUS, f'unknown status {i}')
        require(a['evidence'] or a['lecture_status'] == 'not-located', f'evidence missing {i}')
        ev = [ev1(x) for x in a['evidence']]
        readiness = note_readiness(canonical, a)
        targets.append({**a, 'canonical_word': canonical, 'group': w['group'], 'root_label': w['root'],
            'handout_physical_page': w['physical_page'], 'handout_printed_page': w['printed_page'],
            'handout_meaning_original': w['meaning'], 'ppt_physical_page': w.get('ppt_physical_page'),
            'evidence': ev, 'caveats': clean_caveats(a['caveats']), 'readiness': readiness,
            'teacher_explanation': a['teacher_note'] if readiness == 'usable-text-draft' else None,
            'candidate_explanation': a['teacher_note'] if readiness == 'needs-confirmation' else None,
            'attribution': 'editor paraphrase of cited classroom text; not a verbatim teacher quotation',
            'existing_vocab': existing(canonical, w['word']), 'root_universe': root_link(canonical, w['word'])})
    cards = {}
    for item in targets:
        item.pop('teacher_note', None)
        k = key(item['canonical_word'])
        if k not in cards:
            cards[k] = {'word': item['canonical_word'], 'lesson_id': cfg['lesson_id'], 'handout_indices': [],
                'groups': [], 'evidence': [], 'teacher_explanation': None, 'candidate_explanations': [],
                'caveats': [], 'existing_vocab': item['existing_vocab'], 'root_universe': item['root_universe']}
        card = cards[k]
        card['handout_indices'].append(item['index'])
        if item['group'] not in card['groups']:
            card['groups'].append(item['group'])
        card['evidence'] += item['evidence']
        card['caveats'] += item['caveats']
        if item['teacher_explanation'] and not card['teacher_explanation']:
            card['teacher_explanation'] = item['teacher_explanation']
        if item['candidate_explanation']:
            card['candidate_explanations'].append(item['candidate_explanation'])
    require(len(cards) == expected['canonical_words'], 'canonical target coverage mismatch')
    for word, indices in cfg.get('merge_expectations', {}).items():
        require(cards[key(word)]['handout_indices'] == indices, f'merge expectation failed: {word}')
    supplements, target_additions = {}, []
    supplement_files = [s.get('json') or s['out'] for s in cfg.get('supplement_groups', [])]
    for name in supplement_files:
        for a in load(ctx.qa_dir / name):
            word = a['word']
            status = a.get('lecture_status', 'explained')
            a = {**a, 'lecture_status': status}
            ev = [ev1(x) for x in a['evidence']]
            require(ev, f'supplement without evidence {word}')
            readiness = note_readiness(word, a)
            out = {**a, 'evidence': ev, 'readiness': readiness,
                   'teacher_explanation': a['teacher_note'] if readiness == 'usable-text-draft' else None,
                   'candidate_explanation': a['teacher_note'] if readiness == 'needs-confirmation' else None,
                   'existing_vocab': existing(word), 'root_universe': root_link(word),
                   'kind': 'phrase' if ' ' in word.strip() else 'word',
                   'attribution': 'editor paraphrase of classroom text; supplementary selection, not exhaustive spoken vocabulary'}
            out.pop('teacher_note', None)
            k = key(word)
            if k in cards:
                target_additions.append(out)
                cards[k]['evidence'] += ev
                cards[k].setdefault('additional_explanations', []).append(out)
            elif k in supplements:
                supplements[k]['evidence'] += ev
                supplements[k].setdefault('additional_explanations', []).append(out)
            else:
                supplements[k] = out
    direct_words = {key(t['canonical_word']) for t in targets if t['lecture_status'] in ('explained', 'brief')}
    inferred_words = {key(t['canonical_word']) for t in targets if t['lecture_status'] == 'context-inferred'} - direct_words
    unlocated_words = {key(t['canonical_word']) for t in targets if t['lecture_status'] == 'not-located'} \
        - direct_words - inferred_words
    stats = {'handout_entries': len(targets), 'canonical_target_words': len(cards),
        'entry_statuses': dict(Counter(t['lecture_status'] for t in targets)),
        'directly_corresponding_words': len(direct_words), 'structural_or_context_words': len(inferred_words),
        'not_located_words': sorted(unlocated_words),
        'usable_target_explanations': sum(bool(c['teacher_explanation']) for c in cards.values()),
        'held_target_explanations': [c['word'] for c in cards.values() if not c['teacher_explanation'] and c['candidate_explanations']],
        'targets_without_explanation': [c['word'] for c in cards.values() if not c['teacher_explanation'] and not c['candidate_explanations']],
        'supplement_candidates': len(supplements), 'supplement_usable': sum(bool(c['teacher_explanation']) for c in supplements.values()),
        'supplement_existing_vocab': sum(c['existing_vocab'] is not None for c in supplements.values()),
        'supplement_unmatched_vocab_keys': [c['word'] for c in supplements.values() if c['existing_vocab'] is None],
        'supplement_needs_lesson_source': [c['word'] for c in supplements.values() if c['existing_vocab'] and not c['existing_vocab']['current_lesson_in_material_sources']],
        'additional_target_explanation_rows': len(target_additions), 'exact_citations': checker.state['citations']}
    require(len(direct_words | inferred_words | unlocated_words) == expected['canonical_words'],
            'word status coverage failure')
    require(unlocated_words == set(cfg.get('allowed_not_located', [])), 'unexpected missing word; investigate')
    payload = {'schema_version': 1, 'lesson_id': cfg['lesson_id'],
        'display_policy': cfg['display_policy'], 'scope': cfg['scope'],
        'source_signatures': {}, 'manual_audio_review': False,
        'etymology_verification': cfg['etymology_verification'],
        'stats': stats, 'handout_entries': targets, 'word_cards': list(cards.values()),
        'supplements': list(supplements.values()), 'target_additional_explanations': target_additions}
    stage = ctx.qa_dir / 'staging'
    stage.mkdir(exist_ok=True)

    # ---- signature map over all inputs (filled before writing outputs) ----
    sig_paths = [ctx.wordlist_path, ctx.record_path, ctx.transcript, ctx.vocab_path, ctx.root_entry,
                 *[ctx.course_dir / n for n in (cfg['files'].get('proofread_note'), cfg['files'].get('subtitles')) if cfg['files'].get(n)],
                 *[ctx.qa_dir / n for n in annotation_files + supplement_files]]
    payload['source_signatures'] = {str(p): sha(p) for p in sig_paths}
    save(stage / FILES[4], payload)

    # ---- 01 全词对应 ----
    lines = ['# ' + prose['all_title'], '', prose['all_intro'], '', prose['all_note'], '']
    for group, meta in groups.items():
        lines += [f'## 第{group}组 · {meta["root"]} · {meta["label"]}', '',
                  '|序号|讲义词→规范词|讲义物理页|课堂对应|老师解释整理|内部原文定位|', '|---:|---|---:|---|---|---|']
        for t in targets:
            if t['group'] != group:
                continue
            w = t['word'] if t['word'] == t['canonical_word'] else t['word'] + ' → ' + t['canonical_word']
            note = t['teacher_explanation'] or ('候选，待确认归属' if t['candidate_explanation'] else '—')
            lines.append(f'|{t["index"]}|{w}|{t["handout_physical_page"]}|{STATUS[t["lecture_status"]]}|{note}|{refs(t["evidence"]) or "未定位"}|')
        lines.append('')
    write(stage / FILES[1], '\n'.join(lines) + '\n')

    # ---- 02 可用老师讲解 ----
    lines = ['# ' + prose['usable_title'], '',
        prose['usable_intro'].format(usable=stats['usable_target_explanations']), '',
        prose['usable_note'], '']
    for group, meta in groups.items():
        subset = [c for c in cards.values() if c['teacher_explanation'] and c['groups'][0] == group]
        if not subset:
            continue
        lines += [f'## 第{group}组 · {meta["root"]}', '']
        for c in subset:
            lines += [f'### {c["word"]}', '', c['teacher_explanation'], '', '出处：' + refs(c['evidence']), '']
            for caveat in dict.fromkeys(c['caveats']):
                lines += ['整理提示：' + caveat, '']
    write(stage / FILES[2], '\n'.join(lines) + '\n')

    # ---- 03 补充词与待确认项 ----
    held_cards = [c for c in cards.values() if not c['teacher_explanation'] and c['candidate_explanations']]
    lines = ['# ' + prose['supp_title'], '',
        '## 讲义词的未定位与间接对应', '']
    for word in sorted(unlocated_words):
        lines += [prose['not_located_blurb'].get(word, word + '：未定位。'), '']
    lines += [prose['context_inferred_prefix'] + '、'.join(sorted(inferred_words)) + prose['context_inferred_suffix'], '',
        prose['held_intro'].format(n=len(held_cards)), '']
    for c in held_cards:
        lines += [f'### {c["word"]} · 候选', '', '\n'.join(c['candidate_explanations']), '', '依据：' + refs(c['evidence']), '']
        lines += ['- ' + x for x in dict.fromkeys(c['caveats'])] + ['']
    lines += ['## 没有额外老师解释的讲义词', '',
        '、'.join(stats['targets_without_explanation']), '',
        prose['without_note'], '',
        '## 课堂补充词与词组（精选，不是全部口述词总表）', '',
        prose['supplement_intro'].format(n=len(supplements), usable=stats['supplement_usable'],
                                         merged=prose.get('supplement_merged_note', ''))
        + '、'.join(stats['supplement_unmatched_vocab_keys']) + '。', '',
        '|词/词组|可用老师文字或处理|现有词库/来源|原文定位|', '|---|---|---|---|']
    for c in supplements.values():
        v = c['existing_vocab']
        if v is None:
            location = prose['loc_unmatched']
        else:
            location = prose['loc_first'].format(n=v['first_lesson']) \
                + (prose['loc_has_source'].format(no=cfg['lesson_no']) if v['current_lesson_in_material_sources']
                   else prose['loc_needs_source'].format(no=cfg['lesson_no']))
        note = c['teacher_explanation'] or (prose['note_candidate'] if c['candidate_explanation'] else prose['note_rejected'])
        lines.append(f'|{c["word"]}|{note}|{location}|{refs(c["evidence"])}|')
    lines += ['', prose['supplement_tail'], '', '## 内容边界', ''] \
        + ['- ' + b for b in prose['boundaries']] + ['']
    write(stage / FILES[3], '\n'.join(lines) + '\n')

    # ---- 00 整理说明 ----
    groups_summary = []
    for g, meta in groups.items():
        rows = [t for t in targets if t['group'] == g]
        groups_summary.append(f'|{g} {meta["root"]}|{len(rows)}|{sum(t["readiness"] == "usable-text-draft" for t in rows)}|{sum(t["readiness"] == "needs-confirmation" for t in rows)}|{sum(t["readiness"] == "none" for t in rows)}|')
    fmt = dict(entries=len(targets), cards=len(cards), direct=len(direct_words), inferred=len(inferred_words),
               usable=stats['usable_target_explanations'], held=len(held_cards),
               without=len(stats['targets_without_explanation']), supp=len(supplements),
               supp_usable=stats['supplement_usable'], addrows=len(target_additions), citations=checker.state['citations'])
    lines = ['# ' + prose['readme_title'], '', prose['readme_preamble'], '', '## 实际覆盖', '']
    for bullet in prose['coverage_bullets']:
        lines += [bullet.format(**fmt)]
    lines += ['', '## ' + prose['coverage_q_header'], '', prose['coverage_q_answer'], '',
        '## 文件', '']
    for f in prose['file_links']:
        lines += ['- ' + f]
    lines += ['', '## 分组处理数量（按讲义列项）', '',
        '|组|列项|可用文字|候选暂缓|不加解释|', '|---|---:|---:|---:|---:|', *groups_summary, '',
        '## 使用规则', '', prose['rules_p1'], '', prose['readme_tail'], '']
    write(stage / FILES[0], '\n'.join(lines) + '\n')

    # ---- integrity: inputs unchanged, outputs LF without BOM ----
    for path, before in payload['source_signatures'].items():
        require(sha(Path(path)) == before, f'input changed: {path}')
    for name in FILES:
        data = (stage / name).read_bytes()
        require(b'\r' not in data and not data.startswith(b'\xef\xbb\xbf'), f'output format {name}')
    manifest = {'lesson_id': cfg['lesson_id'],
                'files': [{'name': n, 'sha256': sha(stage / n), 'bytes': (stage / n).stat().st_size} for n in FILES]}
    save(stage / 'manifest.json', manifest)
    save(ctx.qa_dir / 'verification.json', {'ok': True, 'stats': stats, 'source_unchanged': True,
        'quotes_exact_in_both_sources': True, 'manual_audio_review': False,
        'files': manifest['files'], 'inputs': payload['source_signatures']})
    if args.deliver:
        names = FILES + ['manifest.json']
        if ctx.delivery_dir.exists():
            require({p.name for p in ctx.delivery_dir.iterdir()} == set(names)
                    and all(sha(ctx.delivery_dir / n) == sha(stage / n) for n in names),
                    'different destination already exists')
        else:
            temp = Path(tempfile.mkdtemp(prefix='.word-notes-', dir=ctx.delivery_dir.parent))
            try:
                for name in names:
                    shutil.copyfile(stage / name, temp / name)
                    require(sha(stage / name) == sha(temp / name), 'copy mismatch')
                temp.rename(ctx.delivery_dir)
            finally:
                if temp.exists():
                    shutil.rmtree(temp)
        save(ctx.qa_dir / 'delivery-verification.json',
             {'ok': True, 'destination': str(ctx.delivery_dir), 'files': manifest['files']})
    print(json.dumps({'ok': True, 'delivered': args.deliver, 'stats': stats}, ensure_ascii=False, indent=2))


def cmd_verify(args):
    ctx = Ctx(args.config, args.qa_dir)
    cfg = ctx.cfg
    expected = cfg['expected']
    for name, digest in cfg.get('original_lock', {}).items():
        require(sha(ctx.course_dir / name) == digest, 'original delivery changed: ' + name)
    manifest = json.loads((ctx.delivery_dir / 'manifest.json').read_text(encoding='utf-8'))
    for file in manifest['files']:
        path = ctx.delivery_dir / file['name']
        require(sha(path) == file['sha256'] and path.stat().st_size == file['bytes'], 'manifest mismatch')
    data = json.loads((ctx.delivery_dir / FILES[4]).read_text(encoding='utf-8'))
    entries, cards = data['handout_entries'], data['word_cards']
    require([e['index'] for e in entries] == list(range(1, expected['handout_entries'] + 1)),
            'missing/duplicate handout entry')
    require(len(cards) == expected['canonical_words'] and len({c['word'] for c in cards}) == expected['canonical_words'],
            'word deduplication failed')
    require(sum(c['teacher_explanation'] is not None for c in cards) == expected['usable'], 'usable count mismatch')
    held = [c['word'] for c in cards if c['candidate_explanations'] and not c['teacher_explanation']]
    require(held == list(cfg.get('hold', [])), 'candidate isolation failed')
    require(all('teacher_note' not in e for e in entries), 'ambiguous draft field leaked')
    for word, indices in cfg.get('merge_expectations', {}).items():
        require(next(c for c in cards if c['word'] == word)['handout_indices'] == indices,
                f'attribution lost: {word}')
    words = {c['word'] for c in cards}
    for misspelled, canonical in cfg.get('aliases', {}).items():
        require(misspelled not in words and canonical in words, f'canonical spelling failed: {canonical}')
    for word in cfg.get('allowed_not_located', []):
        require(next(c for c in cards if c['word'] == word)['teacher_explanation'] is None,
                f'unlocated explanation invented: {word}')
    for path, before in data['source_signatures'].items():
        require(sha(Path(path)) == before, 'input changed: ' + path)
    stats = data['stats']
    report = {'ok': True, 'handout_entries': len(entries), 'canonical_words': len(cards),
        'usable_explanations': stats['usable_target_explanations'],
        'held_candidates': len(held), 'without_added_explanation': len(stats['targets_without_explanation']),
        'supplement_candidates': stats['supplement_candidates'], 'supplement_usable': stats['supplement_usable'],
        'exact_citation_checks': stats['exact_citations'], 'source_files_unchanged': True,
        'original_deliverables_unchanged': True, 'manifest_verified': True,
        'candidate_isolation_verified': True, 'product_or_learning_data_written': False}
    save(ctx.qa_dir / 'final-verification.json', report)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)
    for name, fn in (('annotate', cmd_annotate), ('assemble', cmd_assemble), ('verify', cmd_verify)):
        p = sub.add_parser(name)
        p.add_argument('--config', required=True, help='lesson config JSON (kept outside the repo)')
        p.add_argument('--qa-dir', default=None, help='override the config qa_dir (sandbox runs)')
        p.set_defaults(fn=fn)
        if name == 'assemble':
            p.add_argument('--deliver', action='store_true', help='publish staging to the delivery dir atomically')
    args = parser.parse_args()
    args.fn(args)


if __name__ == '__main__':
    main()
