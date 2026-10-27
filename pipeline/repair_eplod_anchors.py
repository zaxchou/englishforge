#!/usr/bin/env python3
"""修复 EnglishPod dialogue 无音频锚句(build/eplod/<ep>.json, t0/t1 为 null 的行)。

背景: ASR 全局对齐对 ~127 期各有 1~3 句没配上锚(官方文本与音频措辞/顺序不一致),
这些句在页面上灰色不可播。修复 = whisper 词级扫描 dg.mp3, 对每条无锚句做词序列
模糊匹配(数字归一+容忍 ASR 误听+窗长容错), 把词时间写回锚点。约束:
  ① 匹配跨度不得与任何已有锚点区间重叠;
  ② 无锚句之间保持句序(依次向后匹配);
  ③ 相似度低于阈值的句保持无锚(前端已有跳过兜底), 不硬造。

用法:
  python pipeline/repair_eplod_anchors.py 0001 0016        # 指定期(dry-run)
  python pipeline/repair_eplod_anchors.py --all            # 全库扫描(dry-run)
  python pipeline/repair_eplod_anchors.py --all --apply    # 实际写回
"""
import sys, re, json, difflib, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build' / 'eplod'
MEDIA = ROOT.parent / 'EnglishPod音频库'
MIN_RATIO = 0.55          # 词序列相似度门槛(低于此不硬造锚)

_NUM_WORDS = {"0":"zero","1":"one","2":"two","3":"three","4":"four","5":"five","6":"six","7":"seven",
              "8":"eight","9":"nine","10":"ten","11":"eleven","12":"twelve","13":"thirteen","14":"fourteen",
              "15":"fifteen","16":"sixteen","17":"seventeen","18":"eighteen","19":"nineteen","20":"twenty",
              "30":"thirty","40":"forty","50":"fifty","60":"sixty","70":"seventy","80":"eighty","90":"ninety",
              "100":"hundred","1000":"thousand"}

def toks(text):
    out = []
    for w in re.findall(r"[a-z0-9']+", text.lower()):
        w = _NUM_WORDS.get(w, w).strip("'")
        out.append(w)
    return out

def flat_words(segs):
    flat = []
    for s in segs:
        for (t0, t1, w) in (s.get('words') or []):
            for tw in toks(w):
                flat.append((t0, t1, tw))
    return flat

def best_match(words, tgt, pos, anchored):
    """从 pos 起按窗长 n-1..n+2 找相似度最高的词窗; 返回 (起点词下标, t0, t1, ratio) 或 None。
    密度上限 1.4s/词: 防止长句稀疏跨段匹配出怪物锚(0074 曾出 41s 锚)。"""
    n = len(tgt)
    nw = len(words)
    tgt_s = ' '.join(tgt)
    max_span = n * 1.4
    best = None
    for size in (n, n - 1, n + 1, n + 2):
        if size < 1:
            continue
        for i in range(pos, nw - size + 1):
            t0, t1 = words[i][0], words[i + size - 1][1]
            if t1 - t0 > max_span:
                continue
            if any(t0 < b - 0.05 and t1 > a + 0.05 for a, b in anchored):
                continue
            r = difflib.SequenceMatcher(None, tgt_s, ' '.join(w for _, _, w in words[i:i + size])).ratio()
            if best is None or r > best[3]:
                best = (i, t0, t1, r)
            if r > 0.995:
                return best
    return best

def repair_ep(ep, apply):
    f = BUILD / f'{ep}.json'
    d = json.loads(f.read_text())
    dia = d.get('dialogue') or []
    missing = [i for i, l in enumerate(dia) if l.get('t0') is None]
    if not missing:
        return None
    mp3 = MEDIA / ep / 'dg.mp3'
    if not mp3.exists():
        return (ep, 'NO_MEDIA', missing, [])
    from build_eplod import whisper_segments
    words = flat_words(whisper_segments(str(mp3), skip_first=0.0))
    if not words:
        return (ep, 'NO_ASR', missing, [])
    anchored = [(l['t0'], l['t1']) for l in dia if l.get('t0') is not None]
    results, pos, patched = [], 0, 0
    for mi in missing:
        tgt = toks(dia[mi]['text'])
        if not tgt or len(tgt) < 2:   # 单词句(Okay.../So...)匹配证据太弱, 保持无锚交给前端跳过
            results.append((mi, dia[mi]['text'][:42], None, None, 0))
            continue
        m = best_match(words, tgt, pos, anchored)
        if m and m[3] >= MIN_RATIO:
            i, t0, t1, r = m
            anchored.append((t0, t1))
            results.append((mi, dia[mi]['text'][:42], t0, t1, round(r, 3)))
            pos = i + len(tgt)
            patched += 1
        else:
            results.append((mi, dia[mi]['text'][:42], None, None, round(m[3], 3) if m else 0))
    if apply and patched:
        for mi, _, t0, t1, _ in results:
            if t0 is not None:
                dia[mi]['t0'], dia[mi]['t1'] = round(t0, 2), round(t1, 2)
        f.write_text(json.dumps(d, ensure_ascii=False, indent=1))
    status = 'OK' if patched and patched == len(results) else ('PARTIAL' if patched else 'NOMATCH')
    return (ep, status, missing, results)

def main():
    argv = sys.argv[1:]
    apply = '--apply' in argv
    if '--all' in argv:
        eps = sorted(p.stem for p in BUILD.glob('*.json'))
    else:
        eps = [a.zfill(4) for a in argv if not a.startswith('--')]
    sys.path.insert(0, str(ROOT / 'pipeline'))
    stats = {}
    for ep in eps:
        r = repair_ep(ep, apply)
        if r is None:
            continue
        _, status, missing, results = r
        stats[status] = stats.get(status, 0) + 1
        print(f'[{ep}] {status} 待修{len(missing)}: ' + '; '.join(
            (f'#{mi} "{txt}" → {t0:.2f}-{t1:.2f} sim{s}' if t0 is not None else f'#{mi} "{txt}" → 无匹配 best{s}')
            for mi, txt, t0, t1, s in results), flush=True)
    print('SUMMARY', json.dumps(stats), 'apply' if apply else 'dry-run', flush=True)

if __name__ == '__main__':
    main()
