#!/usr/bin/env python3
"""批量应用文本勘误表: 受影响期自动固化生产锚点(防重建 whisper 漂移) → 单期重建 → 刷词块库。

锚点来源=生产 /api/eplod/lesson/<ep>(用户正在用的就是它); 文本指纹按勘误后正文计算。
顺序单进程; 重建日志实时落盘供轮询。
"""
import hashlib
import json
import ssl
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
import build_eplod as B  # noqa: E402

TABLE = json.loads((ROOT / "pipeline" / "eplod-text-errata.json").read_text(encoding="utf-8"))
OVERRIDES = Path(__file__).with_name("eplod-timing-overrides.json")
PROD = "https://192.168.31.246:8018"
CTX = ssl._create_unverified_context()

def prod_dialogue(ep4):
    with urllib.request.urlopen(f"{PROD}/api/eplod/lesson/{ep4}", timeout=30, context=CTX) as r:
        return json.load(r)["dialogue"]

def corrected_texts(dialogue, reps):
    out = []
    for x in dialogue:
        t = x["text"]
        for a, b in reps:
            t = t.replace(a, b)
        out.append(t)
    return out

def main():
    eps = sorted(int(k) for k in TABLE["episodes"])
    if len(sys.argv) > 1:
        only = {int(x) for x in sys.argv[1].split(",")}
        eps = [e for e in eps if e in only]
    print(f"受影响 {len(eps)} 期: {eps}", flush=True)
    ovr = json.loads(OVERRIDES.read_text(encoding="utf-8"))
    for n, ep in enumerate(eps):
        ep4 = f"{ep:04d}"
        reps = TABLE["episodes"][ep4]["replacements"]
        t0 = time.time()
        try:
            # 1) 固化/更新锚点指纹: 无 override 则从生产固化; 已有则按勘误后文本重算指纹
            pd = prod_dialogue(ep4)
            corr = corrected_texts(pd, reps)
            th = hashlib.sha256("\n".join(corr).encode("utf-8")).hexdigest()
            if ep4 not in ovr["episodes"]:
                bounds = [[x["t0"], x["t1"]] for x in pd]
                if any(not isinstance(t[0], (int, float)) for t in bounds):
                    print(f"[{n+1}/{len(eps)}] {ep4} 生产锚点不全, 跳过固化(重建将走 whisper 对齐)", flush=True)
                else:
                    src = next((ROOT.parent / "EnglishPod音频库" / ep4).glob("*dg.mp3"))
                    ah = hashlib.sha256(src.read_bytes()).hexdigest()
                    ovr["episodes"][ep4] = {
                        "reviewed": time.strftime("%F"),
                        "reason": "批量文本勘误(空格/拼写)前固化生产锚点, 防重建漂移",
                        "audioSha256": ah, "dialogueSha256": th, "bounds": bounds}
            else:
                ovr["episodes"][ep4]["dialogueSha256"] = th
            OVERRIDES.write_text(json.dumps(ovr, ensure_ascii=False, indent=1), encoding="utf-8")
            # 2) 单期重建(不带 --chunks, 复用 AI 产物)
            r = subprocess.run([sys.executable, "-I", str(ROOT / "pipeline" / "build_eplod.py"), ep4, "--apply"],
                               capture_output=True, text=True, timeout=600, cwd=str(ROOT))
            if r.returncode != 0:
                print(f"[{n+1}/{len(eps)}] {ep4} 重建失败 EXIT={r.returncode}: {r.stdout[-300:]} {r.stderr[-200:]}", flush=True)
                continue
            # 3) 刷词块库
            d = json.loads((B.BUILD_EP / f"{ep4}.json").read_text(encoding="utf-8"))
            B.update_chunk_bank(d)
            print(f"[{n+1}/{len(eps)}] {ep4} 完成 {round(time.time()-t0)}s", flush=True)
        except Exception as e:
            print(f"[{n+1}/{len(eps)}] {ep4} 异常: {e}", flush=True)
    print("全部完成", flush=True)

if __name__ == "__main__":
    main()
