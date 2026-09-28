#!/usr/bin/env python3
"""EnglishForge 图标资产生成（4 文件规范）

源图：白底方形母版（默认取开发机上的原始下载图，可用参数覆盖）。
产出（写入 ../public/）：
  icon-1024.png         应用图标母版：裁到形状、四角补满（满幅不透明 RGB）
  apple-touch-icon.png  iOS 主屏 180：同母版处理
  icon-96.png           侧栏品牌位：圆角透明（RGBA，角外 alpha=0）
  icon-32.png           浏览器标签页 favicon：圆角透明

算法要点：
- 有效区域 = 非近白像素的 bbox（蓝形四周留边裁掉）
- 圆角半径按 0.223 × 边长（实测源图 ≈0.222，用 0.223 略大抵消蒙版误差）
- 不透明母版的四角：按"四角双线性插值色"补满（OS 会再裁圆角，接缝不可见）
- 透明版从"补满后的方形"切圆角蒙版再缩，避免源图烘焙圆角留下的白边
用法：python scripts/make-icons.py [源图路径]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

DEFAULT_SRC = r"D:\Download\bbad4842-277a-4342-8660-c727037910f2.png"
OUT_DIR = Path(__file__).resolve().parent.parent / "public"
RADIUS_RATIO = 0.223
BG_THRESHOLD = 236  # 近白判定阈值
SS = 4              # 圆角蒙版超采样倍数


def find_shape(im: Image.Image) -> Image.Image:
    a = np.asarray(im).astype(int)
    fg = ~((a[:, :, 0] > BG_THRESHOLD) & (a[:, :, 1] > BG_THRESHOLD) & (a[:, :, 2] > BG_THRESHOLD))
    ys, xs = np.where(fg)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    shape = im.crop(box)
    w, h = shape.size
    if w != h:  # 强制正方形，取中心
        s = min(w, h)
        shape = shape.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))
    print(f"  有效区域 {box} → 裁后 {shape.size}")
    return shape


def corner_samples(shape: Image.Image):
    arr = np.asarray(shape).astype(int)
    s = shape.size[0]

    def safe(x, y):
        for k in range(40):  # 向内推直到不是近白，拿到真实蓝色
            px = arr[min(y + k, s - 1), min(x + k, s - 1)]
            if not (px[0] > BG_THRESHOLD and px[1] > BG_THRESHOLD and px[2] > BG_THRESHOLD):
                return px[:3].astype(float)
        return arr[y, x][:3].astype(float)

    inset = int(s * 0.08)
    return (
        safe(inset, inset),
        safe(s - 1 - inset, inset),
        safe(inset, s - 1 - inset),
        safe(s - 1 - inset, s - 1 - inset),
    )


def opaque_master(shape: Image.Image, colors, size: int) -> Image.Image:
    """裁到形状 → 缩放到 size → 圆角外按四角双线性色补满（满幅不透明）"""
    img = np.asarray(shape.resize((size, size), Image.LANCZOS)).astype(np.float64)
    r = RADIUS_RATIO * size
    yy, xx = np.mgrid[0:size, 0:size]
    cx = np.clip(xx, r, size - 1 - r)
    cy = np.clip(yy, r, size - 1 - r)
    outside = (xx - cx) ** 2 + (yy - cy) ** 2 > r * r
    u = (xx / (size - 1))[..., None]
    v = (yy / (size - 1))[..., None]
    tl, tr, bl, br = colors
    fill = (tl * (1 - u) + tr * u) * (1 - v) + (bl * (1 - u) + br * u) * v
    img[outside] = fill[outside]
    return Image.fromarray(img.clip(0, 255).astype(np.uint8))


def rounded_transparent(shape: Image.Image, colors, size: int) -> Image.Image:
    """从补满方形切圆角蒙版（超采样）再缩到目标，角外完全透明、无白边"""
    big = size * SS
    base = opaque_master(shape, colors, big).convert("RGBA")
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=RADIUS_RATIO * big, fill=255
    )
    base.putalpha(mask)
    return base.resize((size, size), Image.LANCZOS)


def corner_report(img: Image.Image, name: str):
    w, h = img.size
    mid = w // 2
    pts = {"左上": (1, 1), "右上": (w - 2, 1), "左下": (1, h - 2), "右下": (w - 2, h - 2), "中心": (mid, mid)}
    info = {k: img.getpixel(p) for k, p in pts.items()}
    print(f"  {name}: {img.size[0]}×{img.size[1]} {img.mode} | 角: {info['左上']} α={info['左上'][-1]} | 中心: {info['中心']}")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    print(f"源图: {src}")
    im = Image.open(src).convert("RGB")
    print(f"  原始尺寸 {im.size} {im.mode}")
    shape = find_shape(im)
    colors = corner_samples(shape)
    print("  四角补色采样:", [tuple(int(v) for v in c) for c in colors])

    outputs = [
        ("icon-1024.png", opaque_master(shape, colors, 1024)),
        ("apple-touch-icon.png", opaque_master(shape, colors, 180)),
        ("icon-96.png", rounded_transparent(shape, colors, 96)),
        ("icon-32.png", rounded_transparent(shape, colors, 32)),
    ]
    for name, img in outputs:
        path = OUT_DIR / name
        img.save(path)
        corner_report(img, name)
        print(f"    → {path} ({path.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
