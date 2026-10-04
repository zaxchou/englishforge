#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图片版套题的抽图与清单 (setshot)

图片版素材（2026 年 1-5 月的真题、Pack、模考等）的题面**整份是官方
界面截图**，不是扫描件。这类图有三个很好用的特征：

  1. 左上角自带 **"Question 12 of 32"** / **"Questions 1-10 of 35"**
     -> 题号和总题数不用猜，直接读
  2. 右上角自带 **"00:12:51"** 计时器（部分隐藏）
     -> 能反推该题在音频里的时间点（隐藏时只给区间）
  3. 阅读填空题的空格是**灰色方块遮罩**，不是下划线

所以图片版的处理链路是：
    抽图 -> 拼图(多图一张, 省 token) -> 多模态识别 -> 结构化 -> 回填

用法:
    python setshot.py extract --build build --only 2026-03-15 ...
    python setshot.py plan    --build build --only 2026-03-15
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from extract import extract_docx_images, extract_pdf_pages  # noqa: E402
from make_sheets import build_sheet, load_font              # noqa: E402

# 一张拼图放几张题面图。
# 实测 2 张可读（选项文字够大）；3 张开始选项字母会认错，先保守用 2。
PER_SHEET = 2

# 官方界面截图的题号标记
RE_QMARK = re.compile(
    r"Question\s+s?\s*(\d{1,2})\s+of\s+(\d{1,2})", re.I)
RE_QMARK_RANGE = re.compile(
    r"Questions\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})\s+of\s+(\d{1,2})", re.I)


def set_dir_from_manifest(manifest: dict, set_id: str) -> Path | None:
    for n in manifest["sets"]:
        if n["set_id"] == set_id:
            d = Path(n["dir"])
            if not d.is_absolute():
                d = Path(manifest["root"]) / d
            return d
    return None


def subject_files(manifest: dict, set_id: str) -> list[tuple[str, Path]]:
    """返回 [(学科, 题面文件路径), ...]"""
    d = set_dir_from_manifest(manifest, set_id)
    if not d or not d.exists():
        return []
    out = []
    for n in manifest["sets"]:
        if n["set_id"] != set_id:
            continue
        for subj, bucket in n["subjects"].items():
            for q in bucket.get("questions", []):
                p = d / q["file"]
                if p.exists():
                    out.append((subj, p))
    return out


def do_extract(manifest_path: Path, build: Path, only: list[str] | None) -> None:
    """把图片版套题的题面图抽出来, 并按学科分目录。"""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    targets = only or [n["set_id"] for n in manifest["sets"]]

    for sid in targets:
        files = subject_files(manifest, sid)
        if not files:
            continue
        got = 0
        for subj, p in files:
            out = build / "ocr_images" / sid / subj
            if (out / "index.json").exists():
                got += len(json.loads(
                    (out / "index.json").read_text(encoding="utf-8")))
                continue
            out.mkdir(parents=True, exist_ok=True)
            try:
                if p.suffix.lower() == ".docx":
                    recs = extract_docx_images(p, out)
                elif p.suffix.lower() == ".pdf":
                    recs = extract_pdf_pages(p, out)
                else:
                    continue
            except Exception as e:  # noqa: BLE001
                print(f"  ! {sid}/{subj} 抽图失败: {e}")
                continue
            (out / "index.json").write_text(
                json.dumps(recs, ensure_ascii=False, indent=2),
                encoding="utf-8")
            got += len(recs)
        if got:
            print(f"  ✓ {sid:<22} 图 {got:>4} 张")


def do_plan(manifest_path: Path, build: Path, only: list[str] | None) -> None:
    """抽图 + 拼图, 产出待识别清单。"""
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    targets = only or [n["set_id"] for n in manifest["sets"]]
    font = load_font()

    for sid in targets:
        sdir = build / "ocr_images" / sid
        if not sdir.exists():
            continue
        for subdir in sorted(sdir.iterdir()):
            if not subdir.is_dir():
                continue
            imgs = sorted([p for p in subdir.iterdir()
                           if p.suffix.lower() in (".png", ".jpg", ".jpeg")],
                          key=_img_key)
            if not imgs:
                continue
            sd = build / "ocr_sheets" / sid / subdir.name
            sd.mkdir(parents=True, exist_ok=True)
            groups = [imgs[i:i + PER_SHEET]
                      for i in range(0, len(imgs), PER_SHEET)]
            built = 0
            for gi, g in enumerate(groups, 1):
                out = sd / f"sheet{gi:03d}.jpg"
                if out.exists():
                    built += 1
                    continue
                try:
                    build_sheet(g, out, font)
                    built += 1
                except Exception as e:  # noqa: BLE001
                    print(f"  ! {sid}/{subdir.name} 第{gi}张拼图失败: {e}")
            (sd / "manifest.json").write_text(json.dumps(
                {f"sheet{gi:03d}": [p.name for p in g]
                 for gi, g in enumerate(groups, 1)},
                ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"  {sid:<22} {subdir.name:<10} "
                  f"图 {len(imgs):>4} -> 拼图 {built:>3} 张")


def _img_key(p: Path):
    m = re.search(r"(\d+)", p.stem)
    return int(m.group(1)) if m else 9999


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("extract", "plan"):
        sp = sub.add_parser(name)
        sp.add_argument("--manifest", default="build/manifest.json")
        sp.add_argument("--build", default="build")
        sp.add_argument("--only", nargs="*")
    a = ap.parse_args()
    mp, bld = Path(a.manifest), Path(a.build)
    if a.cmd == "extract":
        do_extract(mp, bld, a.only)
    else:
        do_plan(mp, bld, a.only)
    return 0


if __name__ == "__main__":
    sys.exit(main())
