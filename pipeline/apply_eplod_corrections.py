# -*- coding: utf-8 -*-
"""Apply verified EnglishPod dialogue corrections: text errata and reviewed sentence bounds.

用法(仓库根, python -X utf8 -I):
  python pipeline/apply_eplod_corrections.py plan.json --dry-run   # 只校验并报告将改动什么, 不写任何项目文件
  python pipeline/apply_eplod_corrections.py plan.json             # 校验通过后写回

plan.json: {"0103": {"reason": "...", "text": [[原句片段, 修正片段], ...], "bounds": [[t0, t1], ...]}, ...}
  text   可选: 合并进 pipeline/eplod-text-errata.json 该期的 replacements, 递归作用于正文/词块例句/意群,
               并同步词块库(build/vocab/eplod-chunks.json)里引用这些句子的例句
  bounds 可选: 整期逐句切点, 写入 pipeline/eplod-timing-overrides.json
之后套用到 build/eplod/<ep>.json, 以后重建结果一致。同一 plan 重复执行是空操作。
所有校验先在内存里完成, 全部通过才落盘; 已有文件的序列化格式保持不变。
讲解逐字稿(explanation)不许被正文勘误改动。发布前仍须自行跑测试门禁。
"""
import argparse
import copy
import hashlib
import json
import runpy
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'build/eplod'
ERRATA = ROOT / 'pipeline/eplod-text-errata.json'
OVERRIDES = ROOT / 'pipeline/eplod-timing-overrides.json'
BANK = ROOT / 'build/vocab/eplod-chunks.json'
AUDIO_ROOT = ROOT.parent / 'EnglishPod音频库'
BUILD_SCRIPT = ROOT / 'pipeline/build_eplod.py'


def dump_indent(obj):
    return json.dumps(obj, ensure_ascii=False, indent=1) + '\n'


def dump_min(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def load_unchanged(path, dump):
    """Read a JSON file and refuse to proceed unless our serializer reproduces it byte for byte."""
    text = path.read_bytes().decode('utf-8')
    obj = json.loads(text)
    if dump(obj) != text:
        raise SystemExit(f'{path.name}: unexpected serialization; refusing to reformat the whole file')
    return obj


def strings(value, path=()):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from strings(v, path + (i,))
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from strings(v, path + (k,))


def replace_pairs(text, pairs):
    for a, b in pairs:
        text = text.replace(a, b)
    return text


def fail(message):
    raise SystemExit(f'apply_eplod_corrections: {message}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('plan')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    plan_path = Path(args.plan)
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    errata = load_unchanged(ERRATA, dump_indent)
    overrides = load_unchanged(OVERRIDES, dump_indent)
    bank = load_unchanged(BANK, dump_min) if any(v.get('text') for v in plan.values()) else None
    B = runpy.run_path(str(BUILD_SCRIPT))
    B['apply_errata'].__globals__['TEXT_ERRATA'] = errata   # the builder reads the table at import time
    today = date.today().isoformat()
    writes, report = {}, {}

    # Phase 1: compute and validate everything in memory.
    for key, item in sorted(plan.items()):
        ep = f'{int(key):04d}'
        pairs = [list(p) for p in item.get('text') or []]
        bounds = [list(b) for b in item.get('bounds') or []]
        original = load_unchanged(BUILD / f'{ep}.json', dump_min)
        data = copy.deepcopy(original)
        text_changed = bank_changed = 0
        if pairs:
            known = all(pair in errata.get('episodes', {}).get(ep, {}).get('replacements', []) for pair in pairs)
            entry = errata.setdefault('episodes', {}).setdefault(ep, {'reviewed': today, 'reason': item['reason'],
                                                                     'replacements': []})
            for pair in pairs:
                if pair not in entry['replacements']:
                    entry['replacements'].append(pair)
            entry['reviewed'] = today
            # Use the builder's own function so a later rebuild reproduces exactly this text.
            data = B['apply_errata'](copy.deepcopy(original))
            before, after = dict(strings(original)), dict(strings(data))
            changed = [p for p in before if before[p] != after[p]]
            if not changed and not known:
                fail(f'{ep}: text pairs match nothing in this lesson')
            for p in changed:
                if p and p[0] == 'explanation':
                    fail(f'{ep}: text errata would change the explanation transcript at {p}')
                if replace_pairs(before[p], pairs) != after[p]:
                    fail(f'{ep}: unexpected text change at {p}')
            if changed and not any(p and p[0] == 'dialogue' for p in changed):
                fail(f'{ep}: text errata did not reach the dialogue')
            text_changed = len(changed)
            # Chunk-bank examples quote these sentences. Batch ids are "eplod-<期号>", 期号 不补零.
            batch = next((b for b in bank['batches'] if b['id'] == f'eplod-{int(ep)}'), None)
            if data.get('chunks') and batch is None:
                fail(f'{ep}: chunk bank has no batch eplod-{int(ep)}')
            if batch:
                quotes = {c['quote'] for c in data['chunks']}
                for word in batch['words']:
                    new = replace_pairs(word['sen'], pairs)
                    if new != word['sen']:
                        if new not in quotes:
                            fail(f'{ep}: chunk-bank example has no matching quote: {new[:60]}')
                        word['sen'] = new
                        bank_changed += 1
        if bounds:
            audio = AUDIO_ROOT / ep / 'dg.mp3'
            old = overrides.get('episodes', {}).get(ep) or {}
            overrides['episodes'][ep] = {
                'reviewed': today,
                'reason': item['reason'],
                'audioSha256': hashlib.sha256(audio.read_bytes()).hexdigest(),
                'dialogueSha256': hashlib.sha256('\n'.join(x['text'] for x in data['dialogue']).encode('utf-8')).hexdigest(),
                'bounds': bounds,
            }
            # Validate with the builder's own checks (hashes, ordering, overlap, duration) before anything is written.
            probe = plan_path.parent / f'overrides-probe-{ep}.json'
            write(probe, dump_indent(overrides))
            if B['apply_timing_overrides'](data, audio, probe) != len(bounds):
                fail(f'{ep}: override was not applied')
            probe.unlink()
            data.pop('timeApprox', None)
            bounds_changed = old.get('bounds') != bounds or old.get('reviewed') != today
        else:
            bounds_changed = False
        if text_changed or bounds_changed:
            writes[ep] = data
        report[ep] = {'text_strings_changed': text_changed, 'bank_examples_changed': bank_changed,
                      'bounds_retimed': len(bounds) if bounds_changed else 0}
        print(f"{ep}: lesson text strings to change={text_changed}, vocab-bank examples to change={bank_changed}, "
              f"sentences to re-time={len(bounds) if bounds_changed else 0}" + (' (dry run)' if args.dry_run else ''),
              flush=True)
    if args.dry_run:
        return

    # Phase 2: write the validated objects, then read everything back from disk.
    if any(v['text_strings_changed'] for v in report.values()):
        write(ERRATA, dump_indent(errata))
    if any(v['bank_examples_changed'] for v in report.values()):
        write(BANK, dump_min(bank))
    if any(v['bounds_retimed'] for v in report.values()):
        write(OVERRIDES, dump_indent(overrides))
    for ep, data in writes.items():
        write(BUILD / f'{ep}.json', dump_min(data))
    if any('text_strings_changed' in v for v in report.values()) and load_unchanged(ERRATA, dump_indent) != errata:
        fail('errata table read back differently')
    if any(v['bounds_retimed'] for v in report.values()) and load_unchanged(OVERRIDES, dump_indent) != overrides:
        fail('overrides table read back differently')
    if bank is not None and any(v['bank_examples_changed'] for v in report.values()) and load_unchanged(BANK, dump_min) != bank:
        fail('chunk bank read back differently')
    for ep, data in writes.items():
        if json.loads((BUILD / f'{ep}.json').read_text(encoding='utf-8')) != data:
            fail(f'{ep}: build data read back differently')
    (plan_path.parent / 'apply-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n',
                                                        encoding='utf-8')


if __name__ == '__main__':
    main()
