#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
待识别清单 (todo)

流水线跑完后, 题目是扫描图/截图的那部分素材拿不到文本, 只能先把图抽出来,
再由多模态模型逐张识别。这个脚本负责:

  1. 扫描 output/*/**.json 里 pending_images, 汇总成一份待办
  2. 为每张待识别的图生成"题目清单" (contact sheet), 供模型一次性阅读
  3. 接受模型回填的 jsonl, 合并回结构化中间文件
  4. 重跑装配, 让识别结果进入 Markdown

为什么要有这一步
----------------
素材里近一半是扫描版 PDF / 截图式 DOCX, 没有文字层, 纯解析拿不到内容。
与其让 pipeline 静默产出空文档, 不如显式标成"待识别", 并把图集中导出,
让识别这一步可批量、可断点续跑、可人工校对。

用法:
    # 1) 导出待识别清单 + 拼图
    python transcribe.py todo --out output --build build
    # 2) 识别完回填 build/ocr/*.jsonl 后合并
    python transcribe.py merge --build build
"""

from __future__ import annotations
import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from extract import extract_docx_images, extract_pdf_pages  # noqa: E402
from make_sheets import build_sheet, load_font  # noqa: E402

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
# 每张拼图放几张题: 2 张可读性最好 (4 张实测选项字太小, 容易认错)
PER_SHEET = 2


def collect_todo(out_root: Path) -> list[dict]:
    """汇总所有待识别的题面文件。"""
    todo = []
    for jf in sorted(out_root.rglob("*.json")):
        if jf.name == "INDEX.md":
            continue
        try:
            rec = json.loads(jf.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        sid = rec.get("set_id")
        for item in rec.get("pending_images", []):
            todo.append({
                "set_id": sid,
                "subject": item.get("subject", ""),
                "file": item.get("file", ""),
                "path": item.get("path", ""),
            })
    return todo


def do_todo(out_root: Path, build: Path, only: set[str] | None = None) -> None:
    todo = collect_todo(out_root)
    if only:
        todo = [t for t in todo if t["set_id"] in only]
    if not todo:
        print("没有待识别的文件 —— 全部素材都有文字层。")
        return

    img_root = build / "ocr_images"
    sheet_root = build / "ocr_sheets"
    font = load_font()
    total_img = 0

    print(f"待识别文件 {len(todo)} 个, 开始抽图 ...")
    for t in todo:
        sid = t["set_id"]
        subj = re.sub(r"[^\w一-鿿\-]+", "_", t["subject"]) or "unknown"
        src = Path(t["path"])
        if not src.exists():
            print(f"  ! 源文件不存在: {src}")
            continue
        d = img_root / sid / subj
        # 已抽过就跳过, 支持断点续跑
        if (d / "index.json").exists():
            n = len(json.loads((d / "index.json").read_text(encoding="utf-8")))
        else:
            if src.suffix.lower() == ".docx":
                recs = extract_docx_images(src, d)
            elif src.suffix.lower() == ".pdf":
                recs = extract_pdf_pages(src, d)
            else:
                continue
            (d / "index.json").write_text(
                json.dumps(recs, ensure_ascii=False, indent=2), encoding="utf-8")
            n = len(recs)
        total_img += n

        # 拼图
        files = sorted([p for p in d.iterdir() if p.suffix.lower() in IMAGE_EXT],
                       key=lambda p: int(re.search(r"(\d+)", p.stem).group(1))
                       if re.search(r"(\d+)", p.stem) else 0)
        sd = sheet_root / sid / subj
        sd.mkdir(parents=True, exist_ok=True)
        groups = [files[i:i + PER_SHEET] for i in range(0, len(files), PER_SHEET)]
        for gi, g in enumerate(groups, 1):
            out = sd / f"sheet{gi:03d}.jpg"
            if out.exists():
                continue
            build_sheet(g, out, font)
        (sd / "manifest.json").write_text(
            json.dumps({f"sheet{gi:03d}": [p.name for p in g]
                        for gi, g in enumerate(groups, 1)},
                       ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  {sid:<22} {subj:<12} 图 {n:>4} -> 拼图 {len(groups):>3} 张")

    print(f"\n合计 {total_img} 张图, 输出到 {sheet_root}")
    print("识别完成后把结果写成 jsonl 放进 build/ocr/, 再执行 merge。")
    print("jsonl 每行一个对象, 至少包含: set_id / subject / sheet / items")


def do_merge(build: Path, out_root: Path | None = None) -> None:
    """
    把识别结果合并回 <out_root>/<set_id>/<set_id>.json。

    out_root 显式传入。早前这里硬编码 build.parent / "output", 换个输出
    目录名就静默失效 (识别结果合并 0 组 -> 题量 0), 很难查。

    识别结果用 json 落盘 (一个套题一科一个文件), 字段:
        set_id / subject / passages[]
        passages[i] = {order, q_range, instruction, kind, title, text}

    阅读材料按 q_range 对号入座: 识别出来的这段文字替换掉
    "材料原文待识别" 的空位。宁可多花一次匹配, 也不能把邮件正文
    挂到影评那一组去。
    """
    ocr_dir = build / "ocr"
    if not ocr_dir.exists():
        print("没有 build/ocr 目录, 无可合并内容。")
        return
    if out_root is None:                     # 向后兼容旧的调用方式
        out_root = build.parent / "output"
    n_merged = n_pass = 0
    for jf in sorted(list(ocr_dir.glob("*.json")) + list(ocr_dir.glob("*.jsonl"))):
        rows = []
        if jf.suffix == ".jsonl":
            rows = [json.loads(l) for l in
                    jf.read_text(encoding="utf-8").splitlines() if l.strip()]
        else:
            rows = [json.loads(jf.read_text(encoding="utf-8"))]
        for r in rows:
            sid = r.get("set_id")
            target = out_root / sid / f"{sid}.json"
            if not target.exists():
                print(f"  ! 找不到 {target}")
                continue
            rec = json.loads(target.read_text(encoding="utf-8"))
            if r.get("subject") == "reading-passage" and r.get("passages"):
                k = _fill_reading_passages(rec.get("subjects", {}).get("reading"),
                                          r["passages"])
                rec.setdefault("subjects", {})["reading"] = k
                n_merged += 1
                n_pass += len(r["passages"])
                # 已识别的材料不该再挂着"待识别"
                rec["pending_images"] = [
                    p for p in rec.get("pending_images", [])
                    if not (p.get("subject") == "reading-passage"
                            and p.get("file", "").lower().endswith(".docx"))
                ]
            else:
                subj = r.get("subject", "")
                if subj in rec.get("subjects", {}):
                    rec["subjects"][subj] = _merge_ocr(
                        rec["subjects"][subj], r.get("items", []))
                    n_merged += 1
            target.write_text(json.dumps(rec, ensure_ascii=False, indent=2),
                              encoding="utf-8")
    print(f"合并 {n_merged} 组识别结果, 回填 {n_pass} 段阅读材料。")


def _range_overlap(a: str, b: str) -> bool:
    """
    两个题号区间是否有交集。

    不能要求完全相等: 识别结果里标的是 "21-22" (这段材料覆盖 21~22),
    而解析出的组 q_range 是 "21" (只记了首题, 因为组是按指令切出来的)。
    所以按**区间重叠**判定, 严格相等反而匹配不上。
    """
    def parse(x: str) -> tuple[int, int] | None:
        x = str(x or "").strip()
        m = re.match(r"^(\d+)\s*[-–—]\s*(\d+)$", x)
        if m:
            a1, a2 = int(m.group(1)), int(m.group(2))
            return (min(a1, a2), max(a1, a2))
        m = re.match(r"^(\d+)$", x)
        if m:
            return (int(m.group(1)), int(m.group(1)))
        return None

    ra, rb = parse(a), parse(b)
    if not ra or not rb:
        return False
    return not (ra[1] < rb[0] or rb[1] < ra[0])


def _fill_reading_passages(reading: dict | None,
                           passages: list[dict]) -> dict | None:
    """按题号区间重叠把识别出的材料填回对应题组。

    守卫规则：
    - 识别结果带 verified 标记（人工对照原题图核录）→ 无条件覆盖同区间的组。
      人工核对版是权威，不能被 prior 贴回的旧文本挡住。
    - 未核对的识别结果 → 只填 passage_image（待识别）的组，已有真文字不动。"""
    if not reading:
        return reading
    used: set[int] = set()
    verified = any(p.get("verified") for p in passages)

    for m in reading.get("modules", []):
        for g in m["groups"]:
            if not verified and not g.get("passage_image"):
                continue        # 已经有真文字, 不动（verified 版不受此限）
            hit = None
            for i, p in enumerate(passages):
                if i in used:
                    continue
                if _range_overlap(p.get("q_range", ""), g.get("q_range", "")):
                    hit = (i, p)
                    break
            if not hit:
                continue
            i, p = hit
            text = (p.get("text") or "").strip()
            if not text:
                continue
            used.add(i)
            g["passage"] = text
            g.pop("passage_image", None)      # 已有真文字, 去掉"待识别"标记
            if p.get("instruction"):
                g["instruction"] = p["instruction"]
            if p.get("title") and not g.get("title"):
                g["title"] = p["title"]
            g["passage_source"] = "ocr"
            if p.get("verified"):
                g["passage_verified"] = p["verified"]
    return reading


def _merge_ocr(parsed: dict, items: list[dict]) -> dict:
    """把识别出的题目并入解析结果 (按题号对齐)。"""
    by_no = {it.get("no"): it for it in items if it.get("no") is not None}
    if "modules" in parsed:
        for m in parsed["modules"]:
            for g in m["groups"]:
                for q in g["questions"]:
                    ocr = by_no.get(q["no"])
                    if ocr:
                        q["stem_ocr"] = ocr.get("stem", q.get("stem", ""))
                        if ocr.get("options"):
                            q["options"] = ocr["options"]
    return parsed


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t1 = sub.add_parser("todo", help="导出待识别清单与拼图")
    t1.add_argument("--out", default="output")
    t1.add_argument("--build", default="build")
    t1.add_argument("--only", nargs="*")
    t2 = sub.add_parser("merge", help="合并识别结果")
    t2.add_argument("--build", default="build")
    t2.add_argument("--out", default="output", help="题库输出目录")
    a = ap.parse_args()

    if a.cmd == "todo":
        do_todo(Path(a.out), Path(a.build), set(a.only) if a.only else None)
    else:
        do_merge(Path(a.build), Path(a.out))


if __name__ == "__main__":
    main()
