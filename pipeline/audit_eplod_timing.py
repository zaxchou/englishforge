# -*- coding: utf-8 -*-
"""EnglishPod 逐句时间轴校对: 取证 + 候选切点 (不写任何项目文件)。

2026-11-24 重写。旧版只在当前切点以内找词, 候选边界只会向内收(把被截掉的首尾词当成"句外"),
还把"切片转写与原文一致"当成完整——句尾被截 0.2s 时转写照样认得出那个词 (0101 第 1 句的教训)。
现在:
  1. 多窗口词级转写 (9s 窗, 2.5s 步进) → 按原文做序列对齐 → 每个原文词取各窗口时间的中位数;
  2. 能量包络找停顿: 句间有 >=0.10s 停顿时, 前句收到停顿起点, 后句从停顿终点前 0.35s 起;
     连续语流没有停顿时切在两词交界;
  3. 按候选切点实际切段, small.en 与 large-v3 各转写一遍, 用站内评分引擎对照原文。
脚本只输出证据和候选草稿 (corrections-plan.draft.json); 复核后用 pipeline/apply_eplod_corrections.py 写回。
"转写一致"只是必要条件: 句子起止以能量图上的语音起止为准。

用法 (仓库根, python -X utf8 -I):
  python pipeline/audit_eplod_timing.py --auto --days 3              # 从正式记录推算接下来 N 课
  python pipeline/audit_eplod_timing.py --eps 103,110                # 指定课目
  python pipeline/audit_eplod_timing.py --auto --days 3 --list       # 只列课目与上次复核日期
  python pipeline/audit_eplod_timing.py --eps 103 --view 31.5 32.3 [...]     # 能量图 (20ms/字符)
  python pipeline/audit_eplod_timing.py --eps 103 --words 31.2 32.9 [...]    # 问题窗口的词级时间 (双模型)
可选: --no-second 跳过 large-v3; --variants 让 --words 再加 5 个小模型; --check-only 兼容旧参数 (无作用)。
输出 build/qa/eplod-audit-<日期>/{report.json,corrections-plan.draft.json,<ep>/probe.json,...}; 退出码 0=跑完, 2=脚本错误。
"""
import argparse
import hashlib
import json
import re
import runpy
import statistics
import subprocess
import sys
from datetime import date
from functools import lru_cache
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
AUDIO_ROOT = ROOT.parent / 'EnglishPod音频库'
BUILD = ROOT / 'build/eplod'
OVERRIDES = ROOT / 'pipeline/eplod-timing-overrides.json'
RECORDS = ROOT.parent / 'data/toefl-lab-production/records/records.json'
CATALOG = ROOT / 'build/courses/eplod-catalog.json'
SR = 16000
WINDOW, HOP = 9.0, 2.5           # 滑窗词级转写
EDGE_IGNORE = 0.12               # 贴着窗口边缘的词会被解码器拉长, 不参与取中位数
MIN_PAUSE, BRIDGE = 0.06, 0.03   # 低于阈值的帧: 合并 <30ms 的空隙, 保留 >=60ms 的静音段
SEPARATOR = 0.10                 # >=0.10s 的静音段才算句间停顿
EPS = 0.02                       # 时间比较容差(秒)
LEAD, TAIL = 0.35, 0.08           # 句首留白; 句尾留白 (后面有停顿时)
LONG_PAUSE = 0.25                 # 未识别出首词时, 退回到最近一个这么长的停顿之后
LAST_EXTRA, LAST_TAIL = 0.30, 0.30  # 末句: 最后一个识别词之后最多再算多长的语音, 及其后留白
FIRST, SECOND = 'small.en', 'large-v3'
VARIANTS = ('small', 'base.en', 'base', 'tiny.en', 'tiny')


def load_dialogue(ep):
    return json.loads((BUILD / f'{ep:04d}.json').read_text(encoding='utf-8'))


@lru_cache(maxsize=8)
def decoded(audio):
    """Whole file decoded once: slicing PCM avoids VBR MP3 seek drift."""
    from faster_whisper.audio import decode_audio
    return decode_audio(str(audio), sampling_rate=SR)


@lru_cache(maxsize=None)
def whisper_model(name=FIRST):
    from faster_whisper import WhisperModel
    return WhisperModel(name, device='cpu', cpu_threads=4, compute_type='int8')


def frame_db(pcm, win=0.02, hop=0.01):
    n, h = int(SR * win), int(SR * hop)
    k = (len(pcm) - n) // h + 1
    out, x = np.empty(k), pcm.astype(np.float64)
    for a in range(0, k, 1000):
        b = min(k, a + 1000)
        idx = np.arange(n)[None, :] + h * np.arange(a, b)[:, None]
        out[a:b] = np.sqrt(np.mean(x[idx] ** 2, axis=1))
    return 20 * np.log10(out + 1e-9), hop


def quiet_runs(db, hop, lo, hi):
    """Quietest-frame runs of the whole track; the threshold comes from the dialogue span only."""
    seg = db[int(max(0.0, lo) / hop):int(hi / hop)]
    floor, peak = float(np.percentile(seg, 8)), float(seg.max())
    thr = max(floor + 10.0, peak - 38.0)
    idx, runs, start, prev = np.flatnonzero(db < thr), [], None, None
    for k in idx:
        if start is None:
            start = prev = int(k)
            continue
        if (k - prev) * hop > BRIDGE:
            runs.append((start, prev + 1))
            start = int(k)
        prev = int(k)
    if start is not None:
        runs.append((start, prev + 1))
    return {'floor_db': round(floor, 1), 'thr_db': round(thr, 1), 'peak_db': round(peak, 1),
            'runs': [(round(a * hop, 3), round(b * hop, 3)) for a, b in runs if (b - a) * hop >= MIN_PAUSE]}


def transcribe(model, samples, offset=0.0, words=False):
    kw = {'word_timestamps': True} if words else {}
    segs, _ = model.transcribe(samples, language='en', beam_size=5, condition_on_previous_text=False, **kw)
    segs = list(segs)   # faster-whisper returns a generator
    return (' '.join(s.text.strip() for s in segs),
            [{'s': round(offset + w.start, 2), 'e': round(offset + w.end, 2), 'w': w.word.strip()}
             for s in segs for w in (s.words or [])])


def sliding_words(pcm, lo, hi):
    wins, t = [], lo
    while True:
        b = min(hi, t + WINDOW)
        _, ws = transcribe(whisper_model(), pcm[int(t * SR):int(b * SR)], offset=t, words=True)
        wins.append({'window': [round(t, 2), round(b, 2)], 'words': ws})
        if b >= hi:
            return wins
        t += HOP


# ---- 原文词 ↔ 转写词 的序列对齐 (Needleman-Wunsch, 子词级) ----
NUM = {'0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five', '6': 'six', '7': 'seven',
       '8': 'eight', '9': 'nine', '10': 'ten', '20': 'twenty', '30': 'thirty', '40': 'forty', '50': 'fifty',
       '100': 'hundred', '1st': 'first', '2nd': 'second', '3rd': 'third'}
SUFFIX = {"'re": 'are', "'ll": 'will', "'ve": 'have', "'d": 'would', "'m": 'am', "'s": "'s"}


def expand(word):
    w = re.sub(r"[^a-z0-9']", '', word.lower())
    if not w:
        return []
    if w in NUM:
        return [NUM[w]]
    parts = w.split("'")
    if len(parts) == 2 and parts[1] and parts[0]:
        body, suffix = parts[0], "'" + parts[1]
        if suffix == "'t" and body.endswith('n'):
            return [body[:-1], 'not']
        if suffix in SUFFIX:
            return [body, SUFFIX[suffix]]
    return [w.replace("'", '')]


@lru_cache(maxsize=None)
def lev(a, b):
    if abs(len(a) - len(b)) > 2:
        return 9
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def sim(a, b):
    if a == b:
        return 3
    if a == "'s" and b in ('is', 'has') or b == "'s" and a in ('is', 'has'):
        return 2
    if a.isdigit() or b.isdigit():
        return -2
    d = lev(a, b)
    if len(a) >= 4 and len(b) >= 4 and d <= 1:
        return 2
    if len(a) >= 7 and len(b) >= 7 and d <= 2:
        return 1
    return -2


def align(off, asr):
    """Return {official word index: set(transcribed word indices)} for positively scored pairs."""
    o, owner, a, a_owner = [], [], [], []
    for i, subs in enumerate(off):
        for s in subs:
            o.append(s)
            owner.append(i)
    for j, subs in enumerate(asr):
        for s in subs:
            a.append(s)
            a_owner.append(j)
    n, m, GAP = len(o), len(a), -1.5
    score, ptr, cache = np.zeros((n + 1, m + 1)), np.zeros((n + 1, m + 1), dtype=np.int8), {}
    score[:, 0], score[0, :], ptr[1:, 0], ptr[0, 1:] = np.arange(n + 1) * GAP, np.arange(m + 1) * GAP, 1, 2
    for i in range(1, n + 1):
        row, prev, oi = score[i], score[i - 1], o[i - 1]
        for j in range(1, m + 1):
            key = (oi, a[j - 1]) if oi <= a[j - 1] else (a[j - 1], oi)
            s = cache.get(key)
            if s is None:
                s = cache[key] = sim(oi, a[j - 1])
            d, u, l = prev[j - 1] + s, prev[j] + GAP, row[j - 1] + GAP
            if d >= u and d >= l:
                row[j], ptr[i, j] = d, 0
            elif u >= l:
                row[j], ptr[i, j] = u, 1
            else:
                row[j], ptr[i, j] = l, 2
    matched, i, j = {}, n, m
    while i > 0 and j > 0:
        p = ptr[i, j]
        if p == 0:
            if o[i - 1] == a[j - 1] or sim(o[i - 1], a[j - 1]) >= 0:
                matched.setdefault(owner[i - 1], set()).add(a_owner[j - 1])
            i, j = i - 1, j - 1
        elif p == 1:
            i -= 1
        else:
            j -= 1
    return matched


def anchored(dialogue, wins):
    """Per official word: median start/end over the windows that recognised it away from their edges."""
    off_words, off_line = [], []
    for li, line in enumerate(dialogue):
        for w in re.findall(r"[a-zA-Z0-9'’]+", line['text']):
            off_words.append(w)
            off_line.append(li)
    off, times = [expand(w) for w in off_words], [[] for _ in off_words]
    for win in wins:
        matched = align(off, [expand(w['w']) for w in win['words']])
        a, b = win['window']
        for oi, js in matched.items():
            ws = [win['words'][j] for j in js]
            if min(w['s'] for w in ws) < a + EDGE_IGNORE or max(w['e'] for w in ws) > b - EDGE_IGNORE:
                continue
            times[oi].append((min(w['s'] for w in ws), max(w['e'] for w in ws)))
    lines = []
    for li in range(len(dialogue)):
        cells = []
        for i, o in enumerate(off_line):
            if o != li:
                continue
            ts = times[i]
            cells.append({'w': off_words[i], 'n': len(ts),
                          's': round(statistics.median(t[0] for t in ts), 2) if ts else None,
                          'e': round(statistics.median(t[1] for t in ts), 2) if ts else None})
        lines.append(cells)
    return lines


def propose(lines, runs, duration):
    """Candidate [t0, t1] per sentence plus flags; None where no word was recognised.

    Recognised words anchor each sentence; the energy envelope only decides where the speech around them
    starts and stops. Quiet stretches shorter than SEPARATOR are ignored on both sides, so a stop closure
    inside a word is not mistaken for a sentence boundary.
    """
    pauses = [(a, b) for a, b in runs if b - a >= SEPARATOR - EPS]
    n = len(lines)
    head, tail, first_end = [None] * n, [None] * n, [None] * n
    lead_bad, trail_bad, flags, notes = [False] * n, [False] * n, [], []
    for i, cells in enumerate(lines):
        got = [k for k, c in enumerate(cells) if c['n']]
        if not got:
            flags.append({'severity': 'high', 'sentence': i + 1, 'issue': 'no word of this sentence was recognised; word evidence needed'})
            continue
        head[i], first_end[i], tail[i] = cells[got[0]]['s'], cells[got[0]]['e'], cells[got[-1]]['e']
        lead_bad[i], trail_bad[i] = got[0] > 0, got[-1] < len(cells) - 1
        if lead_bad[i]:
            flags.append({'severity': 'high', 'sentence': i + 1, 'issue': 'leading word(s) not recognised; the onset is only estimated',
                          'words': [c['w'] for c in cells[:got[0]]]})
        if trail_bad[i]:
            flags.append({'severity': 'high', 'sentence': i + 1, 'issue': 'trailing word(s) not recognised; the end is only estimated',
                          'words': [c['w'] for c in cells[got[-1] + 1:]]})

    def onset(i):
        """Start of the speech this sentence opens with: the end of the last real pause before its first
        recognised word is over (word starts are often estimated late), else a backward walk from the word
        start over quiet stretches shorter than SEPARATOR."""
        t = head[i]
        if lead_bad[i]:   # unrecognised opening words: back up to the last long pause
            before = [p for p in pauses if p[1] - p[0] >= LONG_PAUSE - EPS and p[1] <= first_end[i] + EPS]
            return before[-1][1] if before else t
        before = [p for p in pauses if p[1] <= first_end[i] + EPS]
        if before:
            return before[-1][1]
        pos = t
        for x, y in reversed(runs):
            if x > t + EPS:
                continue
            if y < pos - SEPARATOR + EPS:
                break
            pos = x
        return pos

    def end_pause(i):
        """First real pause at or after the last recognised word: covering its end (if long enough to be
        a real pause rather than a stop closure) or starting no earlier than it."""
        t = tail[i]
        return next((p for p in pauses if (p[0] <= t + EPS <= p[1] and p[1] - p[0] >= 0.15 - EPS) or p[0] >= t - 0.02), None)

    out = [None] * n
    for i in range(n):
        if head[i] is None:
            continue
        start = max(0.0, onset(i) - LEAD)
        if i > 0 and head[i - 1] is not None:
            # Opening words of this sentence that were not recognised are spoken between the two recognised
            # words, so everything after the previous sentence's closing pause belongs to this one.
            d = end_pause(i - 1)
            if d is not None and d[1] <= first_end[i] + EPS:
                off = max(d[0], tail[i - 1] - 0.02)
                end = off + min(TAIL, (d[1] - off) / 4)
                start = max(end, d[1] - LEAD) if lead_bad[i] else max(start, end)
                if d[0] - tail[i - 1] > 0.25:
                    flags.append({'severity': 'high', 'sentence': i, 'issue': f'speech continues {d[0] - tail[i - 1]:.2f}s after the last recognised word',
                                  'last_word_end': tail[i - 1], 'speech_end': d[0]})
                if head[i] - d[1] > SEPARATOR - EPS:
                    flags.append({'severity': 'high', 'sentence': i + 1, 'issue': f'speech starts {head[i] - d[1]:.2f}s before the first recognised word',
                                  'speech_start': d[1], 'first_word_start': head[i]})
                notes.append(f'sentence {i}/{i + 1}: pause {d[0]:.2f}-{d[1]:.2f}')
            else:
                lo, hi = min(tail[i - 1], head[i]), max(tail[i - 1], head[i])
                end = start = min(max((tail[i - 1] + head[i]) / 2, lo), hi)
                flags.append({'severity': 'note', 'sentence': i + 1, 'issue': 'no pause before this sentence; boundary placed between the '
                              f'previous last word (ends {tail[i - 1]}) and the first word (starts {head[i]})', 'boundary': end})
                notes.append(f'sentence {i}/{i + 1}: continuous, cut at {end:.2f}')
            if end < out[i - 1][0] + 0.05:   # keep the override validator happy for degenerate estimates
                end = out[i - 1][0] + 0.05
            out[i - 1][1] = round(end, 2)
        start = max(start, out[i - 1][1] if i > 0 and out[i - 1] else 0.0)
        out[i] = [round(start, 2), None]
    if out[-1] is not None:
        p = end_pause(n - 1)
        off = p[0] if p else tail[-1]
        if off > tail[-1] + LAST_EXTRA:
            flags.append({'severity': 'high', 'sentence': n, 'issue': f'sound continues {off - tail[-1]:.2f}s after the last recognised word '
                          '(outro music or an unlisted word?)', 'last_word_end': tail[-1], 'quiet_from': off})
            off = tail[-1] + LAST_EXTRA
        out[-1][1] = round(min(duration - 0.01, off + LAST_TAIL), 2)
    return out, flags, notes


def node_score(pairs):
    code = '''
        const fs = require('node:fs');
        const E = require('./web/eplod-records.js');
        const clips = JSON.parse(fs.readFileSync(0, 'utf8'));
        for (const clip of clips) {
          const score = E.scoreTokens(clip.official, clip.transcript, true);
          clip.missing = E.normTokens(clip.official).filter((_, i) => !score.marks[i]);
          clip.extras = score.extras;
        }
        process.stdout.write(JSON.stringify(clips));
    '''
    out = subprocess.run(['node', '-e', code], input=json.dumps(pairs), cwd=ROOT, capture_output=True,
                         encoding='utf-8', check=True)
    return json.loads(out.stdout)


def clip_check(pcm, dialogue, bounds, models, second=True):
    """Decode every clip exactly as the player would and compare with the lesson text."""
    rows = []
    for i, (line, b) in enumerate(zip(dialogue, bounds), 1):
        if not b or b[0] is None:
            rows.append(None)
            continue
        row = {'sentence': i, 'bounds': b, 'official': line['text']}
        for name in models:
            row[name] = transcribe(whisper_model(name), pcm[round(b[0] * SR):round(b[1] * SR)])[0]
        rows.append(row)
    use = [m for m in models if second or m != SECOND]
    pairs, keys = [], []
    for r in rows:
        if r:
            for name in use:
                # -in' is how the models spell -ing: a spelling variant, not a difference from the text
                pairs.append({'official': r['official'], 'transcript': re.sub(r"(\w)in'\b", r"\1ing", r[name])})
                keys.append((r['sentence'], name))
    scored = {}
    for (sent, name), s in zip(keys, node_score(pairs)):
        scored[(sent, name)] = s
    flags = []
    for r in rows:
        if not r:
            continue
        r['scored'] = {}
        for name in use:
            s = scored[(r['sentence'], name)]
            r['scored'][name] = {k: s[k] for k in ('missing', 'extras')}
            if not r[name] or s['missing'] or s['extras']:
                flags.append({'severity': 'note', 'sentence': r['sentence'], 'model': name, 'issue': 'clip transcript differs from the text',
                              'transcript': r[name], 'missing': s['missing'], 'extras': s['extras']})
    return rows, flags


def audit_episode(ep, out_dir, second=True):
    d, audio = load_dialogue(ep), AUDIO_ROOT / f'{ep:04d}' / 'dg.mp3'
    rep = {'ep': f'{ep:04d}', 'title': d.get('title'), 'sentences': len(d['dialogue']), 'flags': [], 'notes': []}
    if not audio.exists():
        rep['flags'].append({'severity': 'high', 'issue': 'audio missing'})
        return rep
    ov = json.loads(OVERRIDES.read_text(encoding='utf-8')).get('episodes', {}).get(f'{ep:04d}')
    pcm = decoded(audio)
    duration = len(pcm) / SR
    dialogue = d['dialogue']
    current = [[x.get('t0'), x.get('t1')] for x in dialogue]
    starts = [b[0] for b in current if isinstance(b[0], (int, float))]
    if not starts:
        rep['flags'].append({'severity': 'high', 'issue': 'no sentence has an anchor; give the first sentence a rough start first'})
        return rep
    lo = max(0.0, min(starts) - 3.0)
    ends = [b[1] for b in current if isinstance(b[1], (int, float)) and b[1] > b[0]]
    hi = min(duration, (max(ends) if ends else max(starts) + 10.0) + 4.0)
    db, hop = frame_db(pcm)
    quiet = quiet_runs(db, hop, lo, hi)
    wins = sliding_words(pcm, lo, hi)
    lines = anchored(dialogue, wins)
    bounds, flags, notes = propose(lines, quiet['runs'], duration)
    rep.update({'window': [round(lo, 2), round(hi, 2)], 'energy': quiet, 'flags': flags, 'notes': notes,
                'reviewed': (ov or {}).get('reviewed')})
    if ov and ov.get('audioSha256') != hashlib.sha256(audio.read_bytes()).hexdigest():
        rep['flags'].append({'severity': 'high', 'issue': 'existing override was made against a different audio file'})
    (out_dir / 'probe.json').write_text(json.dumps(
        {'lines': [{'i': i + 1, 'text': x['text'], 'current': current[i], 'proposed': bounds[i], 'words': lines[i]}
                   for i, x in enumerate(dialogue)],
         'quiet': quiet, 'windows': wins}, ensure_ascii=False), encoding='utf-8')
    models = (FIRST, SECOND) if second else (FIRST,)
    rep['current'], cur_flags = clip_check(pcm, dialogue, [b if b and b[0] is not None else None for b in current], models, second)
    rep['proposed'], prop_flags = clip_check(pcm, dialogue, bounds, models, second)
    rep['flags'] += [{'on': 'current', **f} for f in cur_flags]
    rep['flags'] += [{'on': 'proposed', **f} for f in prop_flags]
    moved = [{'sentence': i + 1, 'current': c, 'proposed': p} for i, (c, p) in enumerate(zip(current, bounds))
             if p and (c[0] is None or abs(c[0] - p[0]) > 0.02 or abs(c[1] - p[1]) > 0.02)]
    rep['moved'] = moved
    # 'high' flags mean the estimate cannot be trusted; 'note' flags only ask for a look.
    rep['status'] = 'review' if any(f.get('severity') == 'high' for f in rep['flags']) else ('candidate' if moved else 'same')
    return rep


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
    return [e for e in order[frontier + 1:] if e not in practiced][:max(1, days)]


def review_state(ep, recent_days):
    entry = json.loads(OVERRIDES.read_text(encoding='utf-8')).get('episodes', {}).get(f'{ep:04d}')
    if not entry or not entry.get('reviewed'):
        return 'never reviewed'
    try:
        age = (date.today() - date.fromisoformat(entry['reviewed'])).days
    except ValueError:
        return 'reviewed on an unreadable date'
    return f'reviewed {entry["reviewed"]} (skip: within {recent_days} days)' if age < recent_days else f'reviewed {entry["reviewed"]} (old; review again)'


def show_words(ep, pairs, variants=False):
    pcm = decoded(AUDIO_ROOT / f'{ep:04d}' / 'dg.mp3')
    models = [FIRST, SECOND] + (list(VARIANTS) if variants else [])
    for a, b in pairs:
        print(f'--- {ep:04d} window [{a}, {b}]')
        for name in models:
            text, ws = transcribe(whisper_model(name), pcm[round(a * SR):round(b * SR)], offset=a, words=True)
            print(f'    {name:<9}: ' + (' '.join(f'{w["w"]}[{w["s"]}-{w["e"]}]' for w in ws) if ws else text))
        sys.stdout.flush()


def show_view(ep, pairs):
    pcm = decoded(AUDIO_ROOT / f'{ep:04d}' / 'dg.mp3')
    db, hop = frame_db(pcm)
    starts = [x['t0'] for x in load_dialogue(ep)['dialogue'] if isinstance(x.get('t0'), (int, float))]
    ends = [x['t1'] for x in load_dialogue(ep)['dialogue'] if isinstance(x.get('t1'), (int, float))]
    quiet = quiet_runs(db, hop, max(0.0, min(starts) - 3.0), max(ends) + 4.0)
    thr = quiet['thr_db']
    print(f"{ep:04d} thr={thr} floor={quiet['floor_db']} peak={quiet['peak_db']} duration={len(pcm) / SR:.2f}s")
    levels = ('#', '+', '.', ':', '-', ' ')
    for a, b in pairs:
        print(f'--- {a:.2f} .. {b:.2f}   20 ms/char vs threshold (# >= thr, then +3, +6, +10, +15 dB below); 100 ms dB samples')
        t = a
        while t < b - 0.001:
            row, nums = '', []
            for c in range(50):
                tt = t + c * 0.02
                if tt >= b:
                    row += '_'
                    continue
                i = int(round(tt / hop))
                v = (db[i] + db[i + 1]) / 2 if i + 1 < len(db) else db[i]
                dd = thr - v
                row += levels[0] if dd <= 0 else levels[1] if dd < 3 else levels[2] if dd < 6 else levels[3] if dd < 10 else levels[4] if dd < 15 else levels[5]
            for c in range(10):
                tt = t + c * 0.1
                if tt >= b:
                    nums.append('   .')
                    continue
                i = int(round(tt / hop))
                nums.append(f'{(db[i] + db[i + 1]) / 2:4.0f}')
            print(f'{t:6.2f} |{row[:10]}|{row[10:20]}|{row[20:30]}|{row[30:40]}|{row[40:50]}| {" ".join(nums)}')
            t += 1.0


def validate_plan(draft):
    """The builder's own override checks must accept the draft before anyone applies it."""
    if not draft:
        return []
    probe = OUT_DIR / 'overrides-probe.json'
    table = json.loads(OVERRIDES.read_text(encoding='utf-8'))
    for ep, item in draft.items():
        audio = AUDIO_ROOT / ep / 'dg.mp3'
        table['episodes'][ep] = {'audioSha256': hashlib.sha256(audio.read_bytes()).hexdigest(), 'dialogueSha256': hashlib.sha256(
            '\n'.join(x['text'] for x in load_dialogue(int(ep))['dialogue']).encode('utf-8')).hexdigest(), 'bounds': item['bounds']}
    probe.write_text(json.dumps(table, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    try:
        B = runpy.run_path(str(ROOT / 'pipeline/build_eplod.py'))
        bad = []
        for ep, item in draft.items():
            try:
                B['apply_timing_overrides'](load_dialogue(int(ep)), AUDIO_ROOT / ep / 'dg.mp3', probe)
            except ValueError as e:
                bad.append(str(e))
        return bad
    finally:
        probe.unlink(missing_ok=True)


def main():
    global OUT_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument('--auto', action='store_true')
    ap.add_argument('--days', type=int, default=3)
    ap.add_argument('--eps', type=str, default='')
    ap.add_argument('--check-only', action='store_true')   # kept for older callers: the script never writes project files
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--no-second', action='store_true')
    ap.add_argument('--variants', action='store_true')
    ap.add_argument('--view', type=float, nargs='+', default=None)
    ap.add_argument('--words', type=float, nargs='+', default=None)
    args = ap.parse_args()
    OUT_DIR = ROOT / f'build/qa/eplod-audit-{date.today().isoformat()}'
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    eps = upcoming_episodes(args.days) if args.auto else [int(x) for x in args.eps.split(',') if x.strip()]
    if not eps:
        print('no upcoming episodes to audit; nothing to do')
        return
    if args.list:
        for e in eps:
            print(f'{e:04d}: {review_state(e, 3)}')
        return
    if args.view is not None or args.words is not None:
        if len(eps) != 1 or len(args.view or args.words) % 2:
            raise SystemExit('--view/--words need exactly one episode and time pairs: a b [c d ...]')
        pairs = list(zip((args.view or args.words)[0::2], (args.view or args.words)[1::2]))
        show_view(eps[0], pairs) if args.view is not None else show_words(eps[0], pairs, args.variants)
        return
    print('auditing episodes:', [f'{e:04d}' for e in eps], flush=True)
    report, draft = {'date': date.today().isoformat(), 'episodes': []}, {}
    for ep in eps:
        ep_dir = OUT_DIR / f'{ep:04d}'
        ep_dir.mkdir(exist_ok=True)
        try:
            rep = audit_episode(ep, ep_dir, second=not args.no_second)
        except Exception as e:
            print(f'{ep:04d} AUDIT ERROR: {e!r}', flush=True)
            report['episodes'].append({'ep': f'{ep:04d}', 'error': repr(e)})
            continue
        (ep_dir / 'report.json').write_text(json.dumps(rep, ensure_ascii=False), encoding='utf-8')
        report['episodes'].append(rep)
        fl = rep.get('flags', [])
        print(f"{ep:04d}: {rep['status']}; needs-decision flags={len([f for f in fl if f.get('severity') == 'high'])} "
              f"clip-text notes={len([f for f in fl if 'model' in f])} "
              f"continuous-junction notes={len([f for f in fl if f.get('severity') == 'note' and 'model' not in f])} "
              f"sentences whose bounds would move={len(rep.get('moved', []))}", flush=True)
        for f in fl:
            if f.get('severity') == 'high':
                print('    ' + json.dumps(f, ensure_ascii=False), flush=True)
        if rep['status'] in ('candidate', 'review') and all(rep['proposed']):
            draft[f'{ep:04d}'] = {'reason': 'Text-anchored multi-window word times plus energy pauses; review the evidence in '
                                           f'build/qa/eplod-audit-{date.today().isoformat()}/{ep:04d} before applying.',
                                  'bounds': [list(r['bounds']) for r in rep['proposed']]}
    bad = validate_plan(draft)
    if bad:
        print('DRAFT PLAN REJECTED BY THE OVERRIDE CHECKS: ' + '; '.join(bad), flush=True)
        draft = {}
    (OUT_DIR / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding='utf-8')
    (OUT_DIR / 'corrections-plan.draft.json').write_text(json.dumps(draft, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'DONE  draft plan: {sorted(draft)}  (apply with pipeline/apply_eplod_corrections.py after review)', flush=True)
    if any('error' in r for r in report['episodes']):
        raise SystemExit(2)


if __name__ == '__main__':
    main()
