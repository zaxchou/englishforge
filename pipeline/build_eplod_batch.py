# -*- coding: utf-8 -*-
"""EnglishPod 批量导入: 3 进程池, 每期 全管线(解析→whisper分窗对齐→AI词块/翻译/意群→落盘).
用法: python pipeline/build_eplod_batch.py [--workers 3] [--from 1] [--to 365]
已有 build/eplod/<ep>.json 的期跳过(0001/0002 已导入). 日志: build/eplod/batch.log + 失败清单."""
import multiprocessing
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

BUILD = Path(__file__).resolve().parent.parent / 'build' / 'eplod'
LOG = BUILD / 'batch.log'
SKIP = {'0164'}   # 缺 dg/rv 音频, 只有 pb


def worker(ep):
    import build_eplod as B
    if (BUILD / f'{ep}.json').exists():
        return (ep, 'skip', '已导入')
    for attempt in (1, 2):
        try:
            B.run_episode(ep, do_chunks=True, do_apply=True, dg_lang_only=True,
                          log=lambda m: print(f'[{ep}] {m}', flush=True))
            return (ep, 'ok', '')
        except Exception as e:
            if attempt == 2:
                return (ep, 'fail', f'{type(e).__name__}: {e}')
            time.sleep(3)
    return (ep, 'fail', 'unreachable')


def main():
    args = sys.argv[1:]
    workers = int(args[args.index('--workers') + 1]) if '--workers' in args else 3
    lo = int(args[args.index('--from') + 1]) if '--from' in args else 1
    hi = int(args[args.index('--to') + 1]) if '--to' in args else 365
    eps = [f'{i:04d}' for i in range(lo, hi + 1) if f'{i:04d}' not in SKIP]
    BUILD.mkdir(parents=True, exist_ok=True)
    print(f'批量导入 {len(eps)} 期, {workers} 进程', flush=True)
    t0 = time.time()
    done = {'ok': 0, 'skip': 0, 'fail': 0}
    fails = []
    with multiprocessing.Pool(workers) as pool:
        for n, (ep, status, msg) in enumerate(pool.imap_unordered(worker, eps), 1):
            done[status] += 1
            line = f'[{n}/{len(eps)}] {ep} {status} {msg}'
            print(line, flush=True)
            with LOG.open('a', encoding='utf-8') as f:
                f.write(line + '\n')
            if status == 'fail':
                fails.append((ep, msg))
    el = round(time.time() - t0)
    summary = f'批量完成: ok={done["ok"]} skip={done["skip"]} fail={done["fail"]} 耗时 {el//3600}h{el%3600//60}m{el%60}s'
    print(summary, flush=True)
    if fails:
        print('失败清单:', fails, flush=True)
        with LOG.open('a', encoding='utf-8') as f:
            f.write('FAILS: ' + repr(fails) + '\n')


if __name__ == '__main__':
    multiprocessing.freeze_support()
    main()
