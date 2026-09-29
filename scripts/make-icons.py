#!/usr/bin/env python3
"""EnglishForge 图标资产生成（4 文件规范）

源图：方形母版（白底/黑底留边都可），默认取新主图，可用参数覆盖。
产出（写入 ../public/）：
  icon-1024.png         应用图标母版：满幅不透明 RGB
  apple-touch-icon.png  iOS 主屏 180
  icon-96.png           侧栏品牌位：圆角透明（RGBA，角外 alpha=0）
  icon-32.png           浏览器标签页 favicon：圆角透明

算法要点：
1. 背景 = 近白 或 近黑（两种底色的留边都算背景；只看颜色）
2. 形状 bbox 先用**形态学开运算**滤掉与主体不相连的杂点：
   源图边缘常有几像素到几十像素的孤立亮点（2026-09-29 主图顶部就有一簇纯蓝杂点，
   与卡片断开 ~40px 纯黑）。不滤掉会把 bbox 撑高 ~60px、主体被迫缩小，
   四周就多出一圈背景色的"框"。
3. bbox 内的背景像素（主体自身圆角外的四个角）用**同列最近前景色**延展：
   圆角矩形的角部，最近的前景像素本来就在同一列 —— 即最近邻填充，纵向渐变无缝延续。
   **历史事故**：旧实现补边/补角取的是"bbox 外缘的背景色"。白底源图上恰好接近作品色
   所以看不出来；黑底源图取到纯黑 → 成品四周一圈黑框（用户报"图标有黑边"）。
4. w≠h 时按边缘复制补成正方形（**不裁切**）。
5. 圆角半径 0.223 × 边长（品牌值，与源图自身烘焙的圆角无关）。
6. 数值验收（肉眼看不到也要机器兜住）：
   ① 圆角蒙版不得切掉**实心主体**（近黑墨迹或近白像素 = 文字、角色等）；
   ② 成品最外圈边框不得出现近黑像素 —— 这是"黑边/黑框"的回归护栏。
   注：验收①不能用"与局部背景差异大"来定义主体 —— 渐变卡片自身就会被判成细节
   （实测误报 9201 px）。用"近黑/近白"这个判据，渐变不触发、主体跑不掉。

用法：python scripts/make-icons.py [源图路径]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

DEFAULT_SRC = r"D:\Download\ChatGPT 图像 2026年9月29日 12_51_27-1.png"
OUT_DIR = Path(__file__).resolve().parent.parent / "public"
RADIUS_RATIO = 0.223   # 品牌圆角
BG_WHITE = 236        # 近白判定阈值
BG_BLACK = 8          # 近黑判定阈值
OPEN_K = 12           # 开运算半径（剔除最大边小于 ~24px 的孤立杂点）
SS = 4                # 圆角蒙版超采样倍数
RING_FRAC = 0.08      # 外圈边框宽度占比（黑边护栏取样带；旧图黑边实测 4.2%~5.6%，
                      #   带子窄了会"差几像素"漏掉事故，取 8% 留余量）
INK_DARK = 90         # "近黑墨迹"阈值（验收①的主体判据）
INK_WHITE = 200       # "近白"阈值（验收①的主体判据）
INK_TOLERANCE = 8     # 抗锯齿容差（512 尺度上允许被切的像素数）


def backdrop(a: np.ndarray) -> np.ndarray:
    """近白或近黑都算背景（只看颜色，不看连通性）"""
    nw = (a[:, :, 0] > BG_WHITE) & (a[:, :, 1] > BG_WHITE) & (a[:, :, 2] > BG_WHITE)
    nb = a.max(axis=2) <= BG_BLACK
    return nw | nb


def erode4(m: np.ndarray, k: int) -> np.ndarray:
    """4 邻域腐蚀 k 次（形态学开运算；纯 numpy，不依赖 scipy）"""
    for _ in range(k):
        m = m & np.roll(m, 1, 0) & np.roll(m, -1, 0) & np.roll(m, 1, 1) & np.roll(m, -1, 1)
    return m


def extend_from_column(crop: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """把背景像素填成**同列最近前景色**（最近邻延展，渐变无缝）"""
    H, W = valid.shape
    out = crop.astype(np.float64)
    rows = np.arange(H)[:, None]
    above = np.maximum.accumulate(np.where(valid, rows, -1), axis=0)             # 上方最近有效行
    below = np.minimum.accumulate(np.where(valid, rows, H)[::-1], axis=0)[::-1]   # 下方最近有效行
    has_a, has_b = above >= 0, below < H
    da = np.where(has_a, rows - above, 1 << 30)
    db = np.where(has_b, below - rows, 1 << 30)
    src = np.where(has_a | has_b, np.where(da <= db, np.maximum(above, 0), below), 0)
    cols = np.broadcast_to(np.arange(W), (H, W))
    nearest = out[src, cols, :]                                                   # 每个背景像素取同列最近前景色
    return np.where(valid[:, :, None], out, nearest)


def build_square(im: Image.Image) -> Image.Image:
    """源图 → 满幅方形作品（已延展、已补边、四周无背景留边）"""
    a = np.asarray(im).astype(int)
    H, W = a.shape[:2]
    fg = ~backdrop(a)

    core = erode4(fg, OPEN_K)
    if core.any():
        ys, xs = np.where(core)
        y0 = max(0, ys.min() - OPEN_K); y1 = min(H, ys.max() + 1 + OPEN_K)
        x0 = max(0, xs.min() - OPEN_K); x1 = min(W, xs.max() + 1 + OPEN_K)
    else:
        ys, xs = np.where(fg)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    dropped = int(fg.sum() - fg[y0:y1, x0:x1].sum())
    print(f"  形状 bbox ({x0}, {y0}, {x1}, {y1}) → {x1 - x0}×{y1 - y0}"
          f"（开运算剔除孤立杂点 {dropped} px）")

    crop = a[y0:y1, x0:x1]
    filled = extend_from_column(crop, ~backdrop(crop))

    h, w = filled.shape[:2]
    if h != w:
        s = max(h, w)
        top, left = (s - h) // 2, (s - w) // 2
        filled = np.pad(filled, ((top, s - h - top), (left, s - w - left), (0, 0)), mode="edge")
        print(f"  非正方形 {w}×{h} → 边缘复制补边成 {s}×{s}（补的是作品自身边缘色，不是背景色）")
    else:
        print(f"  正方形 {w}×{h}，无需补边")
    return Image.fromarray(filled.clip(0, 255).astype(np.uint8))


def rounded_mask(size: int) -> np.ndarray:
    """0.223 圆角蒙版（超采样抗锯齿）"""
    big = size * SS
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, big - 1, big - 1], radius=RADIUS_RATIO * big, fill=255)
    return np.asarray(m.resize((size, size), Image.LANCZOS)) > 127


def rounded_transparent(square: Image.Image, size: int) -> Image.Image:
    """满幅方形 + 圆角 alpha（角外完全透明，无白边/黑边）"""
    big = size * SS
    base = square.resize((big, big), Image.LANCZOS).convert("RGBA")
    m = Image.new("L", (big, big), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, big - 1, big - 1], radius=RADIUS_RATIO * big, fill=255)
    base.putalpha(m)
    return base.resize((size, size), Image.LANCZOS)


def subject_cut(square: Image.Image, size: int = 512) -> tuple[int, int]:
    """圆角切掉的"实心主体"像素数 / 主体总数。

    主体 = 近黑墨迹 或 近白像素（文字、角色等实心内容）。
    刻意不用"与局部背景的差异"来定义：渐变卡片整体都是差异，会把整张图判成主体。
    """
    img = square.resize((size, size), Image.LANCZOS)
    arr = np.asarray(img).astype(int)
    ink = (arr.max(axis=2) <= INK_DARK) | (arr.min(axis=2) > INK_WHITE)
    return int((ink & ~rounded_mask(size)).sum()), int(ink.sum())


def ring_near_black(img: Image.Image) -> tuple[int, int]:
    """最外圈边框里的近黑像素数 / 边框像素数（黑边回归护栏）

    注意：必须只看 RGB 三个通道 —— RGBA 上直接 max(axis=2) 会把 alpha=255 算进去，
    判据恒假、护栏永远不触发（实测踩过：旧图黑边 43px 也报 0）。
    """
    arr = np.asarray(img.convert("RGBA")).astype(int)
    s = arr.shape[0]
    k = max(1, int(s * RING_FRAC))
    ring = np.zeros((s, s), bool)
    ring[:k, :] = ring[-k:, :] = ring[:, :k] = ring[:, -k:] = True
    ring &= arr[:, :, 3] > 127            # 透明像素不算（favicon 角外本就透明）
    rgb = arr[:, :, :3]
    nb = rgb.max(axis=2) <= BG_BLACK
    return int((nb & ring).sum()), int(ring.sum())


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    print(f"源图: {src}")
    im = Image.open(src).convert("RGB")
    print(f"  原始尺寸 {im.size} {im.mode}")
    square = build_square(im)

    outputs = [
        ("icon-1024.png", square.resize((1024, 1024), Image.LANCZOS)),
        ("apple-touch-icon.png", square.resize((180, 180), Image.LANCZOS)),
        ("icon-96.png", rounded_transparent(square, 96)),
        ("icon-32.png", rounded_transparent(square, 32)),
    ]

    ring_bad = 0
    for name, img in outputs:
        path = OUT_DIR / name
        img.save(path)
        nb, ring = ring_near_black(img)
        ring_bad += nb
        s = img.size[0]
        mid = s // 2
        print(f"  {name:22s} {s}×{s} {img.mode} | 角 {img.getpixel((1, 1))} | 中心 {img.getpixel((mid, mid))}"
              f" | 外圈近黑 {nb}/{ring}")
        print(f"    → {path} ({path.stat().st_size / 1024:.1f} KB)")

    cut, total = subject_cut(square)
    print(f"  数值验收①：被圆角切掉的实心主体像素 = {cut} / {total}（容差 {INK_TOLERANCE}；超了说明半径切进主体）")
    print(f"  数值验收②：成品外圈近黑像素合计 = {ring_bad}（应为 0 —— 黑边回归护栏）")
    if cut > INK_TOLERANCE:
        raise SystemExit(f"验收失败：{cut} 个主体像素被圆角切掉 —— 半径或定位有问题")
    if ring_bad > 0:
        raise SystemExit(f"验收失败：成品外圈有 {ring_bad} 个近黑像素 —— 补色又取到背景色了")


if __name__ == "__main__":
    main()
