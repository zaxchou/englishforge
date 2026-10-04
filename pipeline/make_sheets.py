#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
拼图工具 (sheets)

把一串图片纵向拼接成 contact sheet, 便于一次性阅读多道题。
每张图右上角会打上来源标记 (p007.png), 保证回填时能对号入座。

用法:
    python make_sheets.py --dir build/pages/2026-01-28/listening --per 2 --out build/sheets
"""

from __future__ import annotations
import argparse
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
LABEL_H = 34          # 顶部标签条高度
GAP = 10
MAX_W = 1500          # 单图最大宽度, 超过则等比缩小


def load_font(size: int = 22):
    """尽量用带中文的字体; 找不到就退回默认。"""
    for name in ("msyh.ttc", "msyhbd.ttc", "simhei.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except Exception:  # noqa: BLE001
            continue
    return ImageFont.load_default()


def build_sheet(paths: list[Path], out: Path, font) -> None:
    imgs = []
    for p in paths:
        im = Image.open(p).convert("RGB")
        if im.width > MAX_W:
            h = int(im.height * MAX_W / im.width)
            im = im.resize((MAX_W, h), Image.LANCZOS)
        imgs.append((p.name, im))

    w = max(i.width for _, i in imgs) + 20
    h = sum(i.height + LABEL_H + GAP for _, i in imgs) + GAP

    sheet = Image.new("RGB", (w, h), "#e9e9ee")
    d = ImageDraw.Draw(sheet)
    y = GAP
    for name, im in imgs:
        d.rectangle([10, y, w - 10, y + LABEL_H], fill="#1f2d3d")
        d.text((18, y + 5), name, fill="#ffffff", font=font)
        y += LABEL_H
        sheet.paste(im, (10, y))
        d.rectangle([10, y, 10 + im.width, y + im.height], outline="#9aa4b2", width=2)
        y += im.height + GAP

    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=90, optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--per", type=int, default=2, help="每张拼图放几道题")
    ap.add_argument("--out", required=True)
    ap.add_argument("--prefix", default="sheet")
    a = ap.parse_args()

    src = Path(a.dir)
    files = sorted([p for p in src.iterdir()
                    if p.suffix.lower() in IMAGE_EXT],
                   key=lambda p: int(re.search(r"(\d+)", p.stem).group(1))
                   if re.search(r"(\d+)", p.stem) else 0)
    if not files:
        print("没有图片:", src)
        return 1

    font = load_font()
    outdir = Path(a.out) / src.name
    groups = [files[i:i + a.per] for i in range(0, len(files), a.per)]
    for gi, g in enumerate(groups, 1):
        # 文件名跨 3 位数时补零, 保持排序稳定
        build_sheet(g, outdir / f"{a.prefix}{gi:03d}.jpg", font)

    (outdir / "manifest.json").write_text(
        __import__("json").dumps(
            {f"sheet{gi:03d}": [p.name for p in g]
             for gi, g in enumerate(groups, 1)},
            ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{len(files)} 张图 -> {len(groups)} 张拼图  ({outdir})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
