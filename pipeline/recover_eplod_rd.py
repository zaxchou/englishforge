# -*- coding: utf-8 -*-
"""从用户录音存档恢复 eplod-0001 的 drill.rd/sd.
录音是朗读的原始凭证: ASR 转写 → 与原文逐词比对(epDiff 同算法) → ffprobe 时长 → 重建 rd/sd."""
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(r'Z:/BaiduNetdiskWorkspace/myagent-work/zcode/JunEnglish/toefl-lab')
PROD = Path(r'Z:/BaiduNetdiskWorkspace/myagent-work/zcode/JunEnglish/data/toefl-lab-production/records/records.json')
RECDIR = Path(r'Z:/BaiduNetdiskWorkspace/myagent-work/zcode/JunEnglish/data/toefl-lab-production/records/recordings')

env = {}
for line in (ROOT / 'deploy' / 'backups' / '2026-10-13.r12-20261013164202' / 'compose.env').read_text(encoding='utf-8').splitlines():
    m = re.match(r'^(TFL_ASR_KEY|TFL_ASR_URL|TFL_ASR_MODEL)=(.*)$', line)
    if m:
        env[m.group(1)] = m.group(2).strip()
ASR_URL = re.sub(r'/api/v1/services/aigc/multimodal-generation/generation$', '', env['TFL_ASR_URL']) + '/compatible-mode/v1/chat/completions'


def asr(b64):
    body = {'model': env.get('TFL_ASR_MODEL', 'qwen3-asr-flash'),
            'messages': [{'role': 'user', 'content': [{'type': 'input_audio', 'input_audio': {'data': b64}}]}],
            'stream': False, 'asr_options': {'enable_itn': False}}
    req = urllib.request.Request(ASR_URL, data=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env['TFL_ASR_KEY']})
    with urllib.request.urlopen(req, timeout=180) as r:
        j = json.load(r)
    c = j['choices'][0]['message']['content']
    return (c if isinstance(c, str) else ''.join(x.get('text', '') for x in c)).strip()


def epdiff(official, mine):
    T = lambda s: s.lower().replace('’', "'") and [w for w in re.findall(r"[a-z0-9']+", s.lower())]
    o, m = T(official), T(mine)
    dp = [[0] * (len(m) + 1) for _ in range(len(o) + 1)]
    for i in range(1, len(o) + 1):
        for j in range(1, len(m) + 1):
            dp[i][j] = dp[i - 1][j - 1] + 1 if o[i - 1] == m[j - 1] else max(dp[i - 1][j], dp[i][j - 1])
    return (dp[-1][-1] / len(o)) if o else 0.0


lesson = json.loads((ROOT / 'build' / 'eplod' / '0001.json').read_text(encoding='utf-8'))
dialogue = lesson['dialogue']

prod = json.loads(PROD.read_text(encoding='utf-8'))
course = prod.setdefault('course', {}).setdefault('eplod-0001', {})
drill = course.setdefault('drill', {})
rd = drill.setdefault('rd', {})
sd = drill.setdefault('sd', {})

now = __import__('time').time() * 1000
restored = 0
for i in range(len(dialogue)):
    f = RECDIR / f'eplod-0001-{i}.webm'
    if not f.exists():
        print(f'#{i+1} 无录音, 跳过')
        continue
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(f)],
                               capture_output=True, text=True).stdout.strip() or 0)
    b64 = 'data:audio/webm;base64,' + __import__('base64').b64encode(f.read_bytes()).decode()
    text = asr(b64)
    acc = epdiff(dialogue[i]['text'], text)
    orig_dur = (dialogue[i]['t1'] or 0) - (dialogue[i]['t0'] or 0)
    rd[str(i)] = {'acc': round(acc, 4), 'last': text, 'at': now, 'mode': 'voice', 'dur': round(dur)}
    if dur > 0 and dur <= orig_dur * 1.15 + 0.5:
        sd[str(i)] = {'dur': round(dur), 'at': now}
    restored += 1
    print(f"#{i+1} 词准 {round(acc*100)}% 用时 {dur:.1f}s/原句 {orig_dur:.1f}s | {text[:50]}")

course['drill'] = drill
prod['revision'] = prod.get('revision', 0) + 1
from datetime import datetime, timezone
prod['saved_at'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + f"{int(now % 1000):03d}Z"
PROD.write_text(json.dumps(prod, ensure_ascii=False, indent=1), encoding='utf-8')
print(f'恢复 {restored} 句 → 已写回生产 records.json（容器需重启生效）')
