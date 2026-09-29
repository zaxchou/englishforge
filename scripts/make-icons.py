#!/usr/bin/env python3
"""EnglishForge 图标资产生成（4 文件规范）

源图：方形母版（白底/黑底留边都可），默认取新主图，可用参数覆盖。
产出（写入 ../public/）：
  icon-1024.png         应用图标母版：裁到形状、四角补满（满幅不透明 RGB）
  apple-touch-icon.png  iOS 主屏 180：同母版处理
  icon-96.png           侧栏品牌位：圆角透明（RGBA，角外 alpha=0）
  icon-32.png           浏览器标签页 favicon：圆角透明

算法要点：
- 有效区域 = **既非近白也非近黑**像素的 bbox（两种底色的留边都裁掉。
  2026-09-29 的新源图是黑底留边，"只裁近白"的旧逻辑什么都没裁、产出带黑框）
- bbox 非正方形时**补边**而不是裁切：新源图方卡外有机器人探出的突出物，
  中心裁切会把它们切掉；补边色 = bbox 外缘背景色的中位数
- 圆角半径按 0.223 × 边长（品牌值，与源图自身的烘焙圆角无关）
- 不透明母版的四角：按"四角双线性插值色"补满（OS 会再裁圆角，接缝不可见）
- 透明版从"补满后的方形"切圆角蒙版再缩；生成后**数值验收**：统计被圆角切掉的
  非黑内容像素，>阈值即告警（半径切进作品 = 事故，肉眼看不到也要机器兜住）
用法：python scripts/make-icons.py [源图路径]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

DEFAULT_SRC = r"D:\Download\ChatGPT 图像 2026年9月29日 12_51_27-1.png"
OUT_DIR = Path(__file__).resolve().parent.parent / "public"
RADIUS_RATIO = 0.223
BG_WHITE = 236  # 近白判定阈值
BG_BLACK = 8    # 近黑判定阈值（新源图黑区实测最大通道值=4）
SS = 4          # 圆角蒙版超采样倍数


def find_shape(im: Image.Image) -> Image.Image:
    a = np.asarray(im).astype(int)
    mx = a.max(axis=2)
    near_white = (a[:, :, 0] > BG_WHITE) & (a[:, :, 1] > BG_WHITE) & (a[:, :, 2] > BG_WHITE)
    fg = (~near_white) & (mx > BG_BLACK)
    ys, xs = np.where(fg)
    box = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    shape = im.crop(box)
    w, h = shape.size
    if w != h:
        # 补边成正方形（**不裁切**：突出物必须保全）；补边色 = bbox 外缘背景色中位数
        x0, y0, x1, y1 = box
        ext = []
        if x0 > 0:
            ext += [a[y, x0 - 1] for y in range(y0, y1, max(1, (y1 - y0) // 50))]
        if x1 < a.shape[1]:
            ext += [a[y, x1] for y in range(y0, y1, max(1, (y1 - y0) // 50))]
        if y0 > 0:
            ext += [a[y0 - 1, x] for x in range(x0, x1, max(1, (x1 - x0) // 50))]
        if y1 < a.shape[0]:
            ext += [a[y1, x] for x in range(x0, x1, max(1, (x1 - x0) // 50))]
        color = tuple(int(v) for v in np.median(np.array(ext), axis=0)) if ext else (0, 0, 0)
        s = max(w, h)
        canvas = Image.new("RGB", (s, s), color)
        canvas.paste(shape, ((s - w) // 2, (s - h) // 2))
        shape = canvas
        print(f"  有效区域 {box} → 补边成 {shape.size}（补边色 {color}）")
    else:
        print(f"  有效区域 {box} → {shape.size}")
    return shape


def content_lost_outside_mask(shape: Image.Image, size: int = 512) -> int:
    """数值验收：被 0.223 圆角蒙版切掉的"非黑内容"像素数（应接近 0）。"""
    img = shape.resize((size, size), Image.LANCZOS)
    arr = np.asarray(img).astype(int)
    big = size * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=RADIUS_RATIO * big, fill=255
    )
    m = np.asarray(mask.resize((size, size), Image.LANCZOS)) > 127
    content = arr.max(axis=2) > BG_BLACK
    return int((content & ~m).sum())


def corner_samples(shape: Image.Image):
    arr = np.asarray(shape).astype(int)
    s = shape.size[0]

    def safe(x, y):
        for k in range(40):  # 向内推直到不是近白，拿到真实蓝色
            px = arr[min(y + k, s - 1), min(x + k, s - 1)]
            if not (px[0] > BG_WHITE and px[1] > BG_WHITE and px[2] > BG_WHITE):
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

    lost = content_lost_outside_mask(shape)
    print(f"  数值验收：被圆角切掉的非黑内容像素 = {lost}（0 或个位数为抗锯齿，>100 说明半径切进作品）")
    if lost > 100:
        raise SystemExit(f"验收失败：{lost} 个内容像素被切掉 —— 圆角半径或补边有问题，产物已写出但不作数")


if __name__ == "__main__":
    main()
