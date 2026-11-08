#!/usr/bin/env python3
"""全库对话文本审计: 官方文本(勘误后) vs 音频逐句比对, 找出文本与原音不符的嫌疑句。

背景(2026-11-08): EP 官方 PDF/逐字稿是印刷品, 与配音存在漏词/错词(0033 漏 even、
0039 多 how、0040 漏 try/of/for 三处)。音频才是学习基准。本脚本用本地 whisper
(免费、无偏置)把每期 dg 音频转写, 与官方文本逐句比对相似度, 产出嫌疑清单供
人工双引擎复核(qwen 无偏置 ASR), 复核坐实的走 apply_errata 勘误手册。

只读审计: 不改 build 产物、不写 records、不调 ASR API。单进程顺序跑, 遵守
eplod-no-batch-policy 的"用户点名的轻量顺序批"例外(用户要求确保全库正确)。
用法: python -I pipeline/audit_eplod_text.py [起始期 结束期]
"""
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD_EP = ROOT / "build" / "eplod"
AUDIO_LIB = ROOT.parent / "EnglishPod音频库"
OUT_DIR = ROOT / "build" / "qa" / "eplod-text-audit"

SIM_SUSPECT = 0.90   # 低于此 = 嫌疑句(1-2 词级差异也会落进来)
SIM_WEAK = 0.97      # suspect..weak 之间但词数有差 = 弱嫌疑(长句掉 1 词), 二级复核
# 低于 SIM_SUSPECT 较多的(<=0.6)多为 whisper 误听或锚点问题, 复核时降权。

_NUM = {"zero":"0","one":"1","two":"2","three":"3","four":"4","five":"5","six":"6","seven":"7",
        "eight":"8","nine":"9","ten":"10","eleven":"11","twelve":"12","thirteen":"13","fourteen":"14",
        "fifteen":"15","sixteen":"16","seventeen":"17","eighteen":"18","nineteen":"19","twenty":"20",
        "thirty":"30","forty":"40","fifty":"50","sixty":"60","seventy":"70","eighty":"80","ninety":"90",
        "hundred":"100","thousand":"1000","oh":"0"}

def toks(s):
    """与判分同方向的最小归一: 小写取词, 数词↔数字互通(两侧同变换)。"""
    out = []
    for w in re.findall(r"[a-z0-9']+", s.lower()):
        out.append(_NUM.get(w, w))
    return out

def _lcs_len(a, b):
    if not a or not b:
        return 0
    dp = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            dp[i][j] = dp[i - 1][j - 1] + 1 if a[i - 1] == b[j - 1] else max(dp[i - 1][j], dp[i][j - 1])
    return dp[len(a)][len(b)]

def lcs_sim(a, b):
    if not a or not b:
        return 0.0
    return _lcs_len(a, b) / max(len(a), len(b))

def main():
    lo = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    hi = int(sys.argv[2]) if len(sys.argv) > 2 else 9999
    eps = sorted(int(p.stem) for p in BUILD_EP.glob("*.json") if lo <= int(p.stem) <= hi)
    print(f"审计 {len(eps)} 期: {eps[0]:04d}..{eps[-1]:04d}", flush=True)

    from faster_whisper import WhisperModel
    model = WhisperModel("small.en", device="cpu", compute_type="int8", cpu_threads=4)

    suspects = []
    t0 = time.time()
    for n, ep in enumerate(eps):
        ep4 = f"{ep:04d}"
        data = json.loads((BUILD_EP / f"{ep4}.json").read_text(encoding="utf-8"))
        dialogue = data.get("dialogue") or []
        anchored = [x for x in dialogue if isinstance(x.get("t0"), (int, float)) and isinstance(x.get("t1"), (int, float)) and x["t1"] > x["t0"]]
        if not anchored:
            print(f"[{n+1}/{len(eps)}] {ep4} 无锚点, 跳过", flush=True)
            continue
        audio = AUDIO_LIB / ep4 / "dg.mp3"
        if not audio.exists():
            print(f"[{n+1}/{len(eps)}] {ep4} 无音频, 跳过", flush=True)
            continue
        try:
            with tempfile.TemporaryDirectory() as td:
                wav = str(Path(td) / "dg.wav")
                subprocess.run(["ffmpeg", "-v", "error", "-i", str(audio), "-ar", "16000", "-ac", "1",
                                "-c:a", "pcm_s16le", wav, "-y"], check=True, timeout=300)
                segs, _ = model.transcribe(wav, language="en", word_timestamps=True, vad_filter=False,
                                           no_speech_threshold=1.0, condition_on_previous_text=False)
                words = []
                for s in segs:
                    for w in (s.words or []):
                        words.append((w.start, w.end, w.word))
        except Exception as e:
            print(f"[{n+1}/{len(eps)}] {ep4} 转写失败: {e}", flush=True)
            continue
        ep_sus = 0
        for i, line in enumerate(dialogue):
            t0s, t1s = line.get("t0"), line.get("t1")
            if not (isinstance(t0s, (int, float)) and isinstance(t1s, (int, float)) and t1s > t0s):
                continue
            # 词中点落在句窗内才算这句的(词级时间戳, 抗邻句渗入)
            heard = " ".join(w.strip() for a, b, w in words
                             if t0s - 0.2 <= (a + b) / 2 <= t1s + 0.2).strip()
            off = line["text"]
            ot, ht = toks(off), toks(heard)
            sim = lcs_sim(ot, ht)
            diff = max(len(ot), len(ht)) - _lcs_len(ot, ht)
            if sim < SIM_SUSPECT:
                tier = "no-heard" if not ht else ("low" if sim < 0.6 else "suspect")
                suspects.append({"ep": ep, "i": i, "sim": round(sim, 3), "diff": diff, "level": tier,
                                 "official": off, "whisper": heard[:220]})
                ep_sus += 1
            elif diff >= 1 and sim < SIM_WEAK:
                suspects.append({"ep": ep, "i": i, "sim": round(sim, 3), "diff": diff, "level": "weak",
                                 "official": off, "whisper": heard[:220]})
                ep_sus += 1
        print(f"[{n+1}/{len(eps)}] {ep4} {ep_sus} 嫌疑 (累计 {len(suspects)}, {round(time.time()-t0)}s)", flush=True)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    report = {"generated": time.strftime("%F %T"), "episodes": len(eps), "suspects": suspects}
    (OUT_DIR / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    hi_first = [s for s in suspects if s["level"] == "suspect"]
    print(f"完成: {len(eps)} 期, 嫌疑 {len(suspects)} 句 (复核优先 {len(hi_first)} 句, 低置信 {len(suspects)-len(hi_first)} 句)")
    print(f"报告: {OUT_DIR / 'report.json'}", flush=True)

if __name__ == "__main__":
    main()
