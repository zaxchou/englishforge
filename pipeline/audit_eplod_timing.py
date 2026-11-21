# -*- coding: utf-8 -*-
"""EnglishPod 逐句时间轴自动校对(2026-11-21, 用户要求提前校对后3天内容, 学习不中断)。

用法(仓库根, python -X utf8 -I):
  python pipeline/audit_eplod_timing.py --auto --days 3     # 从正式记录推算接下来 N 天新课并校对
  python pipeline/audit_eplod_timing.py --eps 88,92         # 显式指定课目
  python pipeline/audit_eplod_timing.py --eps 87 --check-only  # 只报告不改数据

流程(与 0087 人工校对一致): 全课词级 small.en(cpu_threads=4) → 句边界与实测词对比
→ 漂移>0.15s 的边界做 ±1.2s 窄窗复核 → 两份证据一致才改, 冲突记 needs-review 不猜。
只改时间戳(eplod-timing-overrides.json + build 数据), 绝不改正文; 正文可疑只报告。
输出 build/qa/eplod-audit-<date>/{report.json,<ep>/*.json}; 退出码 0=全部处理完(含 needs-review 记录), 2=脚本错误。
"""
import argparse
import hashlib
import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIO_ROOT = ROOT.parent / 'EnglishPod音频库'
BUILD = ROOT / 'build/eplod'
OVERRIDES = ROOT / 'pipeline/eplod-timing-overrides.json'
RECORDS = ROOT.parent / 'data/toefl-lab-production/records/records.json'
CATALOG = ROOT / 'build/courses/eplod-catalog.json'
DRIFT_TRIGGER = 0.15   # 全课长窗的漂移只当触发器: 长窗时间会漂, 不作写回依据
SPAN_TOL = 0.15        # 句内词判定容差: 边界附近的词不应因噪声被排除在句外
WRITE_TOL = 0.12       # 新课写回门槛(秒); 已校准课见 PROTECT_TOL
AGREE_TOL = 0.2        # 新课双证据一致容差: 全课与窄窗指向同一边界才写
PROTECT_TOL = 0.5      # 已校准课(override 存在)保护: 人工裁决不因单窗口估计被自动翻案
WHISPER = 'small.en'


def load_dialogue(ep):
    return json.loads((BUILD / f'{ep:04d}.json').read_text(encoding='utf-8'))


def whisper_words(audio, a, b, tag, out_dir):
    from faster_whisper import WhisperModel
    model = WhisperModel(WHISPER, device='cpu', cpu_threads=4)
    segs, _ = model.transcribe(str(audio), word_timestamps=True, clip_timestamps=[a, b], beam_size=5)
    words = [{'s': round(w.start, 2), 'e': round(w.end, 2), 'w': w.word.strip()}
             for s in segs for w in (s.words or [])]
    (out_dir / f'{tag}.json').write_text(json.dumps({'window': [a, b], 'words': words}, ensure_ascii=False, indent=1), encoding='utf-8')
    return words


def measured_bounds(words, cur):
    """句内词(允许 SPAN_TOL 容差)的首尾 → 实测边界; 无词返回 None。"""
    inside = [w for w in words if w['s'] >= cur[0] - SPAN_TOL and w['e'] <= cur[1] + SPAN_TOL]
    if not inside:
        return None
    return [inside[0]['s'], inside[-1]['e']]


def auditable(ep):
    d = load_dialogue(ep)
    audio = AUDIO_ROOT / f'{ep:04d}' / 'dg.mp3'
    return d, audio


def audit_episode(ep, out_dir, check_only):
    d, audio = auditable(ep)
    dlg = d['dialogue']
    rep = {'ep': f'{ep:04d}', 'sentences': len(dlg), 'changes': [], 'needs_review': [], 'notes': []}
    if not audio.exists():
        rep['notes'].append('audio missing, skipped')
        return rep, []
    ov = json.loads(OVERRIDES.read_text(encoding='utf-8'))
    audio_sha = hashlib.sha256(audio.read_bytes()).hexdigest()
    if f'{ep:04d}' in ov.get('episodes', {}) and ov['episodes'][f'{ep:04d}'].get('audioSha256') != audio_sha:
        rep['notes'].append('override audio hash mismatch, skipped for safety')
        return rep, []
    dg_dur = float(d.get('durations', {}).get('dg') or 0) or (dlg[-1].get('t1') or 0) + 5
    # 全课窗口避开片头/片尾(长窗且含非语音会降低词级时间可信度): 从首个锚点前 2.5s 起
    starts = [x['t0'] for x in dlg if isinstance(x.get('t0'), (int, float))]
    ends = [x['t1'] for x in dlg if isinstance(x.get('t1'), (int, float)) and x['t1'] > x['t0']]
    full_lo = max(0.0, min(starts) - 2.5) if starts else 0.0
    full_hi = min(dg_dur, (max(ends) + 4) if ends else dg_dur)
    full = whisper_words(audio, full_lo, full_hi, 'full', out_dir)
    cur = [[x.get('t0'), x.get('t1')] for x in dlg]
    new_bounds = [list(b) for b in cur]
    narrow_jobs = []   # (idx, side, boundary)
    for i, b in enumerate(cur):
        if not (isinstance(b[0], (int, float)) and isinstance(b[1], (int, float)) and b[1] > b[0]):
            rep['needs_review'].append({'sentence': i + 1, 'issue': 'no anchor; word evidence needed'})
            continue
        m = measured_bounds(full, b)
        if m is None:
            # 句内没有任何词: 起点过早/过晚把词切给邻句, 或该段真无语音
            rep['needs_review'].append({'sentence': i + 1, 'issue': 'no words inside current span', 'current': b})
            continue
        if abs(m[0] - b[0]) > DRIFT_TRIGGER:
            narrow_jobs.append((i, 0, b[0]))
        if abs(m[1] - b[1]) > DRIFT_TRIGGER:
            narrow_jobs.append((i, 1, b[1]))
    # 窄窗复核每个漂移边界。已校准课(override 已存在)保护人工裁决: 任何单窗口估计
    # (截断音/抢话等模糊区在窗口间摆动可达 1s)都不得自动翻案, 漂移只记 needs-review。
    # 新课需双证据一致(全课与窄窗差 <=AGREE_TOL 且窄窗与当前差 >WRITE_TOL)才写回。
    protected = f'{ep:04d}' in ov.get('episodes', {})
    for idx, side, boundary in narrow_jobs:
        side_name = 't0' if side == 0 else 't1'
        tag = f'narrow-s{idx + 1}-{side_name}'
        near = [w for w in full if abs((w['s'] if side == 0 else w['e']) - boundary) < 1.2]
        if not near:
            continue
        lo = min(w['s'] for w in near) - 1.0
        hi = max(w['e'] for w in near) + 1.0
        words = whisper_words(audio, max(0, lo), hi, tag, out_dir)
        target = [w for w in words if w['s'] >= cur[idx][0] - SPAN_TOL and w['e'] <= cur[idx][1] + SPAN_TOL]
        if not target:
            rep['needs_review'].append({'sentence': idx + 1, 'side': side_name,
                                        'current': cur[idx][side], 'issue': 'narrow window has no words for this sentence'})
            continue
        cand = round(target[0]['s'] if side == 0 else target[-1]['e'], 2)
        drift = abs(cand - cur[idx][side])
        if protected:
            if drift > WRITE_TOL:
                rep['needs_review'].append({'sentence': idx + 1, 'side': side_name, 'current': cur[idx][side],
                                            'narrow': cand, 'issue': 'protected boundary drifted; manual review only'})
            else:
                rep['notes'].append(f'sentence {idx + 1} {side_name} drift {drift:.2f}s within noise, kept')
            continue
        mfull = measured_bounds(full, cur[idx])
        fullside = (mfull[0] if side == 0 else mfull[1]) if mfull else None
        if drift > WRITE_TOL and fullside is not None and abs(fullside - cand) <= AGREE_TOL:
            new_bounds[idx][side] = cand
        elif drift > WRITE_TOL:
            rep['needs_review'].append({'sentence': idx + 1, 'side': side_name, 'current': cur[idx][side],
                                        'full_take': fullside, 'narrow': cand, 'issue': 'evidence conflict'})
        else:
            rep['notes'].append(f'sentence {idx + 1} {side_name} drift {drift:.2f}s within noise, kept')
    # 正文可疑只报告: 官方词数 vs 句内实测词数差异大
    official_words = len(re.findall(r"[a-z0-9']+", ' '.join(x['text'].lower() for x in dlg)))
    audio_words = len([w for w in full if any(
        isinstance(b[0], (int, float)) and b[1] > b[0] and w['s'] >= b[0] - SPAN_TOL and w['e'] <= b[1] + SPAN_TOL for b in cur)])
    if audio_words < official_words * 0.6:
        rep['needs_review'].append({'issue': 'audio word count far below official text; possible text/dub mismatch',
                                    'official': official_words, 'audio': audio_words})
    changed = [(i, cur[i], new_bounds[i]) for i in range(len(cur)) if new_bounds[i] != cur[i]]
    rep['changes'] = [{'sentence': i + 1, 'before': b, 'after': n} for i, b, n in changed]
    if not changed or check_only:
        return rep, changed
    # 应用: override + build + 时间轴测试(仅时间戳)
    before = load_dialogue(ep)
    current = load_dialogue(ep)
    dialogue_sha = hashlib.sha256('\n'.join(x['text'] for x in current['dialogue']).encode()).hexdigest()
    assert ov.get('version') == 1
    ov['episodes'][f'{ep:04d}'] = {
        'reviewed': date.today().isoformat(),
        'reason': f'Automated full-take word-level audit ({WHISPER}); narrow-window re-check agreed on all moved '
                  f'boundaries (tolerance {AGREE_TOL}s). Only timestamps changed; needs-review items, if any, were not applied. '
                  'Evidence: build/qa/eplod-audit/.',
        'audioSha256': audio_sha,
        'dialogueSha256': dialogue_sha,
        'bounds': [list(x) for x in new_bounds],
    }
    OVERRIDES.write_text(json.dumps(ov, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    B = __import__('runpy').run_path(str(ROOT / 'pipeline/build_eplod.py'))
    assert B['apply_timing_overrides'](current, audio) == len(new_bounds)
    assert [[x['t0'], x['t1']] for x in current['dialogue']] == new_bounds
    stripped = json.loads(json.dumps(current))
    for a, b in zip(stripped['dialogue'], before['dialogue']):
        a['t0'], a['t1'] = b['t0'], b['t1']
    assert stripped == before, 'only dialogue timestamps may change'
    (BUILD / f'{ep:04d}.json').write_text(json.dumps(current, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    return rep, changed


def upcoming_episodes(days):
    """正式记录(只读)+catalog 顺序 → frontier(最后新学的课)之后下 N 课未练课目。"""
    cat = json.loads(CATALOG.read_text(encoding='utf-8'))
    order = [l['ep'] for l in cat['series'][0]['courses'][0]['lessons']]
    rec = json.loads(RECORDS.read_text(encoding='utf-8'))
    practiced = set()
    for lid, lesson in (rec.get('course') or {}).items():
        m = re.match(r'eplod-(\d+)$', lid)
        if not m:
            continue
        drill = lesson.get('drill') or {}
        rd = drill.get('rd') or {}
        touched = any(isinstance(v, dict) and (v.get('acc') is not None or v.get('latest') or v.get('voice')) for v in rd.values()) or bool(drill.get('wp'))
        if touched:
            practiced.add(int(m.group(1)))
    if not practiced:
        raise SystemExit('no practiced episodes in production records; refusing to guess the frontier')
    frontier = max(order.index(e) for e in practiced if e in order)
    out = [e for e in order[frontier + 1:] if e not in practiced]
    return out[:max(1, days)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--auto', action='store_true')
    ap.add_argument('--days', type=int, default=3)
    ap.add_argument('--eps', type=str, default='')
    ap.add_argument('--check-only', action='store_true')
    args = ap.parse_args()
    out_dir = ROOT / f'build/qa/eplod-audit-{date.today().isoformat()}'
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.auto:
        eps = upcoming_episodes(args.days)
    else:
        eps = [int(x) for x in args.eps.split(',') if x.strip()]
    if not eps:
        print('no upcoming episodes to audit; nothing to do')
        return
    print('auditing episodes:', [f'{e:04d}' for e in eps], flush=True)
    report = {'date': date.today().isoformat(), 'episodes': [], 'changed_files': []}
    for ep in eps:
        ep_dir = out_dir / f'{ep:04d}'
        ep_dir.mkdir(exist_ok=True)
        try:
            rep, changed = audit_episode(ep, ep_dir, args.check_only)
        except Exception as e:
            print(f'{ep:04d} AUDIT ERROR: {e}', flush=True)
            report['episodes'].append({'ep': f'{ep:04d}', 'error': str(e)})
            continue
        report['episodes'].append(rep)
        status = 'changed' if rep['changes'] else ('needs-review' if rep['needs_review'] else 'clean')
        print(f"{ep:04d}: {status}; changes={len(rep['changes'])} needs_review={len(rep['needs_review'])}", flush=True)
        if rep['changes']:
            report['changed_files'] += [f'pipeline/eplod-timing-overrides.json', f'build/eplod/{ep:04d}.json']
    (out_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    if report['changed_files'] and not args.check_only:
        r = subprocess.run([sys.executable, '-I', str(ROOT / 'pipeline/test_eplod_timing.py')], cwd=ROOT,
                           capture_output=True, text=True)
        (out_dir / 'timing-tests.exit').write_text(str(r.returncode) + '\n', encoding='utf-8')
        print('timing tests REAL_EXIT=' + str(r.returncode), flush=True)
        if r.returncode != 0:
            print(r.stdout[-2000:] + r.stderr[-2000:], flush=True)
            raise SystemExit(2)
    print('DONE', flush=True)


if __name__ == '__main__':
    main()
