# -*- coding: utf-8 -*-
"""新东方词汇课(ndf-01) 第31课起: 源 .mov → faststart .mp4 副本(流复制, 画质不变)。
单进程串行(用户裁决: 不用批量并发); 每课完成即打印, 可随时中断重跑(已存在则跳过)。"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / 'build' / 'courses' / 'catalog.json'
OUTDIR = ROOT / 'build' / 'media' / 'ndf'
SRC_BASE = ROOT.parent / '新D方' / '新D方新托福全套'

c = json.loads(CATALOG.read_text(encoding='utf-8'))
lessons = [l for se in c['series'] for co in se.get('courses', [])
           for l in co.get('lessons', []) if l.get('id', '').startswith('ndf-01-')]
todo = [l for l in lessons if int(l['no']) >= 31]
print(f'待转换 {len(todo)} 课', flush=True)
OUTDIR.mkdir(parents=True, exist_ok=True)
fail = []
for k, l in enumerate(todo, 1):
    src = SRC_BASE / urllib.parse.unquote(urllib.parse.urlparse(l['video']).path).split('/新D方/')[-1].split('新D方新托福全套/')[-1]
    # 视频路径形如 /media/ndf/<课程目录>/<文件名>, 源在 新D方/新D方新托福全套/<课程目录>/<文件名>
    parts = urllib.parse.unquote(urllib.parse.urlparse(l['video']).path).split('/')
    src = SRC_BASE / parts[-2] / parts[-1]
    dst = OUTDIR / (parts[-1].rsplit('.', 1)[0] + '.mp4')
    if dst.exists() and dst.stat().st_size > 1_000_000:
        print(f'[{k}/{len(todo)}] {l["no"]} 已存在, 跳过', flush=True)
        continue
    if not src.exists():
        print(f'[{k}/{len(todo)}] {l["no"]} 源缺失: {src}', flush=True)
        fail.append(l['no'])
        continue
    t0 = time.time()
    r = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(src),
                        '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', str(dst)],
                       capture_output=True, text=True)
    if r.returncode != 0 or not dst.exists():
        print(f'[{k}/{len(todo)}] {l["no"]} 失败: {r.stderr[-200:]}', flush=True)
        fail.append(l['no'])
        dst.unlink(missing_ok=True)
        continue
    mb = dst.stat().st_size / 1048576
    print(f'[{k}/{len(todo)}] {l["no"]} {l["title"][:24]} → {mb:.0f}MB, {time.time()-t0:.0f}s', flush=True)
print('完成' + ('，失败: ' + ','.join(fail) if fail else '，全部成功'), flush=True)
