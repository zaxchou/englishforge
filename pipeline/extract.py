#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
素材抽取器 (extractor)

把 manifest 里的每个"套题"拆成可识别的图片序列 + 结构化答案文本。

产出布局:
    build/pages/<set_id>/<subject>/
        p000.png            <- 统一按序号命名, 便于按序识别
        index.json          <- 每张图的来源 (原文件名/页码/原始题号提示)
    build/answers/<set_id>.json   <- 结构化答案
    build/audio/<set_id>.json     <- 音频清单 (含时长)

三类素材来源:
    docx_embedded  : DOCX 内嵌截图, 1 图 = 1 题 (主力形态)
    pdf_render     : 扫描版 PDF, 渲染每页为 PNG
    video_frames   : 录屏视频 (口语题目), 按场景切分抽帧
"""

from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
RENDER_DPI = 150          # 扫描 PDF 渲染 DPI, 150 足够 OCR 且不至于爆体积
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


# ------------------------------------------------------------------ 工具

def natural_key(name: str):
    """自然排序: image2 < image10 (避免字典序把 10 排在 2 前)。"""
    return [int(t) if t.isdigit() else t.lower()
            for t in re.split(r"(\d+)", name)]


def ffprobe_duration(path: Path) -> float | None:
    try:
        r = subprocess.run(
            [FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=60)
        val = r.stdout.strip()
        return round(float(val), 2) if val and val != "N/A" else None
    except Exception:  # noqa: BLE001
        return None


# ------------------------------------------------------------------ DOCX

def extract_docx_images(docx_path: Path, out_dir: Path) -> list[dict]:
    """DOCX -> 顺序编号 PNG。同时导出纯文本 (答案/文字版题目都要用)。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    recs = []
    with zipfile.ZipFile(docx_path) as z:
        media = [n for n in z.namelist()
                 if n.lower().startswith("word/media/")
                 and os.path.splitext(n)[1].lower() in IMAGE_EXT]
        media.sort(key=lambda n: natural_key(os.path.basename(n)))
        for i, name in enumerate(media):
            ext = os.path.splitext(name)[1].lower()
            if ext == ".jpeg":
                ext = ".jpg"
            dst = out_dir / f"p{i:03d}{ext}"
            dst.write_bytes(z.read(name))
            recs.append({"idx": i, "file": dst.name,
                         "origin": os.path.basename(docx_path),
                         "origin_media": os.path.basename(name)})
    return recs


def docx_text(docx_path: Path, mark_images: bool = True) -> str:
    """
    DOCX -> 纯文本 (保留段落/表格单元格换行)。

    mark_images=True 时, 在内嵌图片所在位置插入 [[IMG:n]] 占位符。
    为什么需要: 素材里阅读的邮件/影评/短信/通知是**截图**而非文字
    (6.22 的 Reading.docx 文字层只有题干, 4 段材料全是内嵌 PNG)。
    不留占位符的话, 解析器看不出"这里本该有材料", 就会静默产出
    只有题目没有原文的残缺电子档。
    """
    with zipfile.ZipFile(docx_path) as z:
        if "word/document.xml" not in z.namelist():
            return ""
        xml = z.read("word/document.xml").decode("utf-8", errors="ignore")

    # 图片占位: <a:blip r:embed="rId7"/> -> [[IMG:7]]
    if mark_images:
        def _img(m):
            rid = re.search(r'r:embed="([^"]+)"', m.group(0))
            return f" [[IMG:{rid.group(1) if rid else '?'}]] "
        xml = re.sub(r"<a:blip[^>]*/>", _img, xml)
        # 有些用 <w:pict>/<v:imagedata>, 同样处理
        xml = re.sub(r"<v:imagedata[^>]*/>",
                     lambda m: f" [[IMG:{re.search(r'r:id=.([^\"]+)', m.group(0)).group(1)
                                   if re.search(r'r:id=.([^\"]+)', m.group(0)) else '?'}]] ",
                     xml)

    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"</w:tc>", "\t", xml)
    xml = re.sub(r"<w:br[^>]*/>", "\n", xml)
    txt = re.sub(r"<[^>]+>", "", xml)
    txt = txt.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    txt = re.sub(r"[ \t]+\n", "\n", txt)
    txt = re.sub(r"\n{3,}", "\n\n", txt).strip()
    # 单独占位符占一行时去掉空行噪声, 但保留行内标记
    txt = re.sub(r"\n\s*\[\[IMG:[^\]]+\]\]\s*\n", "\n[[IMG]]\n", txt)
    return txt


def docx_image_map(docx_path: Path) -> dict[str, str]:
    """rId -> 图片文件名, 供 [[IMG:7]] 占位符还原成真实文件。"""
    out: dict[str, str] = {}
    try:
        with zipfile.ZipFile(docx_path) as z:
            rels = z.read("word/_rels/document.xml.rels").decode("utf-8", "ignore")
            for m in re.finditer(r'Id="([^"]+)"[^>]*Target="([^"]+)"', rels):
                out[m.group(1)] = os.path.basename(m.group(2))
    except Exception:  # noqa: BLE001
        pass
    return out


# ------------------------------------------------------------------ PDF

def extract_pdf_pages(pdf_path: Path, out_dir: Path) -> list[dict]:
    """扫描版 PDF -> 逐页 PNG。"""
    import fitz
    fitz.TOOLS.mupdf_display_errors(False)
    out_dir.mkdir(parents=True, exist_ok=True)
    recs = []
    with fitz.open(pdf_path) as d:
        for i in range(d.page_count):
            pix = d[i].get_pixmap(dpi=RENDER_DPI)
            dst = out_dir / f"p{i:03d}.png"
            pix.save(dst)
            recs.append({"idx": i, "file": dst.name,
                         "origin": os.path.basename(pdf_path),
                         "page": i + 1})
    return recs


def pdf_text(pdf_path: Path) -> str:
    """文字版 PDF -> 纯文本。"""
    import fitz
    fitz.TOOLS.mupdf_display_errors(False)
    out = []
    with fitz.open(pdf_path) as d:
        for i in range(d.page_count):
            out.append(d[i].get_text())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


# ------------------------------------------------------------------ 视频

def extract_video_frames(video_path: Path, out_dir: Path,
                         scene_thresh: float = 0.30) -> list[dict]:
    """
    录屏 -> 场景切分抽帧。
    口语题目视频里每道题是一张静止画面, 用场景变化阈值切即可,
    比固定 fps 抽帧干净得多 (不会抽到同一题的重复帧)。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [FFMPEG, "-v", "error", "-i", str(video_path),
           "-vf", f"select='gt(scene,{scene_thresh})',scale=1400:-1",
           "-vsync", "vfr", "-q:v", "3",
           str(out_dir / "p%03d.jpg")]
    subprocess.run(cmd, capture_output=True, timeout=1800)
    recs = []
    for p in sorted(out_dir.glob("p*.jpg"), key=lambda x: natural_key(x.name)):
        recs.append({"idx": len(recs), "file": p.name,
                     "origin": os.path.basename(video_path), "from": "video"})
    return recs


# ------------------------------------------------------------------ 答案解析

ANSWER_SECTION_RE = re.compile(
    r"^\s*(阅读|听力|写作|口语|Reading|Listening|Writing|Speaking)\s*[:：]?\s*$",
    re.I)
MODULE_RE = re.compile(r"(module\s*\d|第[一二三四五六]部份|部分\s*\d)", re.I)

# 一行里连续出现 "1. word  2. word  21b  22d" 几种写法。
#  - "N. word"  -> 填空题, 答案是整个词 (module1 常见)
#  - "N word"   -> 填空题, 无点号   (module2 加试常见, 如 "1 however")
#  - "Nletter"  -> 选择题, 答案是单个字母
# 必须一次抓 "题号 + 完整词", 再判断是词还是字母;
# 若分开用两条正则, "2. aspects" 会被误判成选项 A (a)。
ANSWER_TOKEN_RE = re.compile(
    r"(\d{1,2})\s*[.．、]\s*([A-Za-z][A-Za-z\-']*)"        # 1. word
    r"|(\d{1,2})\s+([A-Za-z][A-Za-z\-']+)(?=\s|$)"          # 1 however
    r"|(\d{1,2})\s*([A-Da-d])(?![A-Za-z])"                  # 21b
)


def _classify(val: str) -> str:
    """单个 A-D 视为选项, 其余视为填空答案。"""
    return "choice" if re.fullmatch(r"[A-Da-d]", val) else "fill"


# 另一套排版 (2026-06/07/08 月的 docx):
#   "Reading Module 1 Fill-in-the-Blank Q1-Q10: 1 losses; 2 species; ..."
#   "Module 1: Q1 A; Q2 B; ..."
# 这种每行自带 "学科 + 模块 + 题型 + 题号区间", 用行级正则整体吃。
# 答案区标题行。素材写法极不统一, 一个正则必须同时吃下:
#
#   "Listening Answers"                                       纯学科
#   "Listening Module 1: Q1 C; Q2 D"                          同行带答案
#   "Reading Module 1 Complete the Words (Questions 1-10): Modern Biochemistry"
#   "Reading Module 1 Daily-Life Reading (Questions 21-30)"   答案在下一行
#   "Reading Module 2 Academic Reading: Linguistic Structural Diversity (Q11-15)"
#      ^ 这种"冒号后先出文章名、题号区间在括号里"最容易漏
#
# 两个关键点:
#  1. 题号区间要允许 **括号 + Questions 字面量** (写作 (Questions 1-10)),
#     不只是 Q1-10 或 1-10。漏了这点阅读整科答案会 0 条, 而听力正常, 极难发现。
#  2. body 允许为空 -> 不用再写第二个"纯标题"正则。
RE_STRUCT_ANSWER = re.compile(
    r"^\s*(?:TOEFL\s+)?(?P<subject>Listening|Reading|Writing|Speaking)"
    r"(?:\s+Answers)?"
    r"(?:\s+Module\s*(?P<module>\d+))?"
    r"(?:\s+(?P<kind>Fill-in-the-Blank|Complete the Words|Multiple Choice"
    r"|Sentence Construction|Daily-Life Reading|Academic Reading"
    r"|Academic Reading Passage|Academic|Daily Life))?"
    r"\s*(?:\(\s*(?:Q(?:uestions?)?\s*)?(?P<q1>\d{1,2})\s*[-–—]\s*"
    r"(?:Q(?:uestions?)?\s*)?(?P<q2>\d{1,2})\s*\))?"
    r"\s*(?::\s*)?(?P<body>.+)?$",
    re.I)
# 纯标题行: 有学科/模块/题型, 但**答案在下一行** (行尾没有 "1. xxx")
#   "Reading Module 1 Daily-Life Reading (Questions 21-30)"
#   "Reading Module 1 Complete the Words (Questions 1-10): Modern Biochemistry" <- 这个有冒号但冒号后是标题不是答案
# 之前两种都不匹配, 导致 cur_subj 一直设不上, 整科答案 0 条。
RE_STRUCT_HEADONLY = re.compile(
    r"^\s*(?:TOEFL\s+)?(?P<subject>Listening|Reading|Writing|Speaking)"
    r"(?:\s+Answers)?"
    r"(?:\s+Module\s*(?P<module>\d+))?"
    r"(?:\s+(?P<kind>Fill-in-the-Blank|Complete the Words|Multiple Choice"
    r"|Sentence Construction|Daily-Life Reading|Academic Reading"
    r"|Academic Reading Passage|Daily Life))?"
    r"\s*(?:(?:Q(?:uestions?)?\s*)?(?P<q1>\d{1,2})\s*[-–—]\s*(?:Q(?:uestions?)?\s*)?(?P<q2>\d{1,2}))?\s*"
    r"(?::\s*(?P<title>[^:]*))?$",
    re.I)
# 结构化排版里的 "题号 + 答案" 对:
#   选择题 "Q21 C" / 填空题 "1 losses" / "21. events"
# 关键: "Q21 C" 数字后面只有空格, 没有标点, 所以标点必须可选;
# 否则会把选择题整段漏掉 (而它和填空题还会共用题号, 更难发现)。
RE_STRUCT_PAIR = re.compile(
    r"Q?\s*(?P<q>\d{1,2})\s*[.．、:：]?\s+(?P<a>.+?)"
    r"(?=\s*;?\s*Q?\d{1,2}\s*[.．、:：]?\s+[A-Za-z]|\s*$)")


def _pairs(body: str, hint: str = "") -> list[tuple[int, str, str]]:
    """从一段答案文本里抽出 [(题号, 答案, kind), ...]。
    hint 是标题行题型（如 Academic/Multiple Choice）: 长句答案也按该题型
    归类, 不能靠 _classify(整句) 猜。"""
    out = []
    hint_choice = bool(re.search(r"choice|academic|daily", hint or "", re.I))
    for m in RE_STRUCT_PAIR.finditer(body):
        q, a = m.group("q"), (m.group("a") or "").strip()
        if not q or not a:
            continue
        kind = "choice" if hint_choice else _classify(a)
        out.append((int(q), a.upper() if kind == "choice" else a, kind))
    if out:
        return out
    return _pairs_glued(body, hint)


# 2026 年 1-5 月素材的答案排版: **题号紧贴答案、答案与下一个题号之间只有空格**
#   "1might 2that 3people 4only 5the 6work 7was 8for 9hunting 10food"
#   "21c 22d 23b 24a 25b"
# 这种不能靠分隔符切 (答案本身含空格, 如 "10food 11explains"), 只能靠
# **"下一个题号"的位置**切: 用 (?=\b\d{1,2}(?=[A-Za-z])) 前瞻切段。
#
# 安全性: 写作句子建构的答案 ("do you know if the position requires
# experience?") 不以"数字+字母"开头, 不会被误切。
RE_GLUED_SPLIT = re.compile(r"(?=\b\d{1,2}(?=[A-Za-z]))")
RE_GLUED_PAIR = re.compile(r"^(\d{1,2})([A-Za-z].*)$", re.S)


def _pairs_glued(body: str, hint: str = "") -> list[tuple[int, str, str]]:
    """
    解析"题号紧贴答案"的排版。

    hint 是题型提示 (从上文标题行传来, 如 "Fill-in-the-Blank" /
    "Multiple Choice")。**必须有这个提示**: 加试的阅读答案里
    "1c 2b 3c 4b 5b" 这种选择题答案和 "1might 2that 3people" 填空答案
    用的是同一种排版, 光看行本身分不出来 ("11c" 既可能是选择题的 C,
    也可能是填空的 "11c..."), 只能靠上下文判定。
    """
    is_choice = bool(re.search(r"multiple\s*choice|选择", hint or "", re.I))
    is_fill = bool(re.search(r"fill|complete the words|complete the sentences"
                             r"|c-test|填空", hint or "", re.I))
    out = []
    for seg in RE_GLUED_SPLIT.split(body or ""):
        m = RE_GLUED_PAIR.match(seg.strip())
        if not m:
            continue
        q, a = int(m.group(1)), m.group(2).strip()
        if not a:
            continue
        if is_choice:
            kind = "choice"
        elif is_fill:
            kind = "fill"
        else:
            kind = _classify(a)
        out.append((q, a.upper() if kind == "choice" else a, kind))
    return out
# 答案区之后就是原文/范文区, 到此为止
# 原文区标题。素材里带各种后缀:
#   "Listening Transcript"
#   "Listening Transcript - Role-Labeled"      (6.10 等)
#   "Listening Transcript (Role-Labeled)"
# 不允许后缀的话, 带后缀那版就匹配不上 -> 原文区的 "Module 1 Short Responses"
# 会被当成答案标题, 听力 M2 混进 "Short" 这种垃圾答案。
RE_TRANSCRIPT_HEAD = re.compile(
    r"^\s*Listening Transcript\b.*$", re.I)


def _looks_like_pairs(s: str) -> bool:
    """
    判断一段文本是不是 "题号 + 答案" 的答案串。

    答案区的标题行冒号后可能是**文章名**而不是答案:
        "Reading Module 1 Complete the Words (Questions 1-10): Modern Biochemistry"
    这种不能当答案收, 否则会凭空多出 "Modern Biochemistry -> Q1" 这种脏数据。
    """
    return bool(_pairs(s))


def _pairs_by_continuity(body: str, already: list[dict]) -> list:
    """
    解析答案行, 并用"题号连续性"决定题型。

    为什么必须看连续性: 2026 年 1-5 月素材里, 填空答案和选择题答案
    **用的是同一种排版** (题号紧贴):
        填空: "1might 2that 3people 4only 5the"      (1 词, 字母开头)
        选择: "21c 22d 23b 24a 25b"                  (单字母)
    光看一行分不出 "11c" 是"第11题选C"还是"第11空填 c..."。

    可靠判据 —— 题号从哪开始、连续到几:
        从 1 开始连续到 10/20  -> 填空 (每模块头 10 个空的分组)
        从 11 或 21 开始        -> 选择
    再结合本模块已收录的题号, 避免与已有分组重复。
    """
    pairs = _pairs(body)
    if not pairs:
        return []
    qs = [q for q, _, _ in pairs]
    start, end = min(qs), max(qs)
    contiguous = (end - start + 1) == len(qs)
    # 已有答案里出现过同一批题号 -> 说明这段是另一个分组的重复, 按选择处理
    dup = any(x["q"] in set(qs) for x in already)

    is_choice = (not contiguous) or start > 1 or dup
    out = []
    for q, a, _k in pairs:
        if is_choice:
            # 只有 A-D 单字母才算选项答案（'21c' 紧贴排版的多词/短词都
            # 是填空——'of'/'to'/'in' 这类 2 字母真实答案曾被 len<=2
            # 误判成 choice, 再被组切片 kind 过滤丢掉）。
            kind = "choice" if re.fullmatch(r"[A-Da-d]", a) else "fill"
            out.append((q, a.upper() if kind == "choice" else a, kind))
        else:
            out.append((q, a, "fill"))
    return out


def parse_answers_structured(text: str) -> dict:
    """
    解析"每行一段"的新式答案排版。返回 {subject: {module: [{q,a,kind}]}}。
    识别不出的行会被跳过 (返回空 dict), 由调用方回退到旧解析器。
    """
    # 预处理: 答案跨行 ("Q9 Later; Q10 \ninventor." -> Q10 的答案在下一行,
    # 按行解析会把 Q10 丢掉)。把"行尾悬空题号"与下一行拼回来;
    # 下一行若是新题号 (Q10) 或区块标题 (C-Test/Module/科目名等) 则不合并。
    text = re.sub(
        r"(Q\d+\s*[:：；;]?\s*)\n"
        r"(?!\s*Q\d)"
        r"(?!\s*(?:C-?Test|Module|Reading|Listening|Writing|Speaking|Answers|Listening Transcript))",
        r"\1 ", text, flags=re.I)
    result: dict = {}
    cur_subj = None
    cur_mod = "module1"

    for raw in text.splitlines():
        line = raw.strip()
        if not line or line in ("TOEFL Answers",):
            continue
        # 进入原文/范文区就不再解析答案了, 否则 Transcript 里的
        # "Q1. How long is..." 会被当成答案混进来。
        if RE_TRANSCRIPT_HEAD.match(line) or re.match(
                r"^\s*(Sentence Construction Answers|Write an Email|"
                r"Write for an Academic Discussion|Speaking Answers|"
                r"Task\s*\d+\s*[-–—])", line, re.I):
            break

        m = RE_STRUCT_ANSWER.match(line)
        if not m:
            # "Module N C-Test: Q1 ..." —— 模块号写在 C-Test 前面。
            # 必须先于下面的纯 C-Test 分支处理, 否则模块号会被丢掉,
            # Module 2 的答案全归到 module1。
            mc2 = re.match(r"^\s*Module\s*(\d+)\s+C-Test\s*\d*\s*[:：]\s*(.+)$",
                           line, re.I)
            if mc2 and cur_subj:
                cur_mod = f"module{mc2.group(1)}"
                bucket = result.setdefault(cur_subj, {"module1": [], "module2": []})
                for q, a, kind in _pairs(mc2.group(2)):
                    bucket[cur_mod].append({"q": q, "a": a, "kind": kind})
                continue

            # "C-Test N: Q1 had; Q2 wheels" —— 只有模块内的小题号, 没有学科名。
            # 不处理的话会落进下面的"纯答案行"分支, 被 _pairs 抓成
            # (1, 'Q', 'choice') —— 把 "Q1" 的字母 Q 当成答案, 整段错位。
            mc = re.match(r"^\s*C-Test\s*(\d+)\s*[:：]\s*(.+)$", line, re.I)
            if mc and cur_subj:
                # C-Test 1/2 都属当前模块 (C-Test 1 = Q1-10, C-Test 2 = Q11-20)
                bucket = result.setdefault(cur_subj, {"module1": [], "module2": []})
                for q, a, kind in _pairs(mc.group(2)):
                    bucket[cur_mod].append({"q": q, "a": a, "kind": kind})
                continue

            # "Module 2 Fill-in-the-Blank Q1-Q10: shelter; influencing; ..."
            # —— 模块号+题型名+题号区间+分号列表 (07-13 排版)。
            # 不处理会掉进"纯答案行"分支被 _pairs_by_continuity 错位解析。
            mfb = re.match(
                r"^\s*Module\s*(\d+)\s+[A-Za-z][A-Za-z \-]*?"
                r"Q\d+\s*[-–—]\s*Q\d+\s*[:：]\s*(.+)$", line, re.I)
            if mfb and cur_subj:
                cur_mod = f"module{mfb.group(1)}"
                bucket = result.setdefault(cur_subj, {"module1": [], "module2": []})
                kind = "fill" if re.search(r"fill|c-test", line, re.I) else "choice"
                items = [x.strip() for x in mfb.group(2).split(";") if x.strip()]
                qs = re.search(r"Q(\d+)\s*[-–—]\s*Q(\d+)", line, re.I)
                start = int(qs.group(1)) if qs else 1
                for i, a in enumerate(items):
                    a = a.rstrip(".。")
                    if a:
                        bucket[cur_mod].append(
                            {"q": start + i, "a": a, "kind": kind})
                continue

            # "Module N: ..." 单独出现时沿用当前学科
            m2 = re.match(r"^\s*Module\s*(\d+)\s*[:：]\s*(.+)$", line, re.I)
            if m2 and cur_subj:
                cur_mod = f"module{m2.group(1)}"
                for q, a, kind in _pairs(m2.group(2)):
                    result[cur_subj][cur_mod].append(
                        {"q": q, "a": a, "kind": kind})
                continue

            # 中文科目行 + "加试" (2026 年 1-5 月素材的排版):
            #   "阅读" / "听力" / "写作" / "口语"
            #   "加试" = Module 2 (加试), 单独一行, 紧跟其后的答案行属于 module2
            if re.match(r"^\s*(阅读|听力|写作|口语|阅读|听力)\s*$", line):
                cn2en = {"阅读": "reading", "听力": "listening",
                         "写作": "writing", "口语": "speaking"}
                cur_subj = cn2en[line.strip()]
                cur_mod = "module1"
                result.setdefault(cur_subj, {"module1": [], "module2": []})
                continue
            if re.match(r"^\s*加\s*试\s*$", line):
                cur_mod = "module2"
                if cur_subj:
                    result.setdefault(
                        cur_subj, {"module1": [], "module2": []})
                continue

            # 纯答案行, 归属当前学科/模块:
            #   "1. It; 2. from; ..."              (阅读填空, 6.7 排版)
            #   "Q21 B; Q22 C; ..."                 (阅读选择, 6.7 排版)
            #   "1might 2that 3people ..."          (2026 年 1-5 月: 紧贴排版)
            # 上面刚由标题行设好了 cur_subj/cur_mod, 这里只管收答案。
            # 前提: 这一行整体就是答案 (不含 "Q1 had" 这种前缀标记),
            # 否则会把标记里的字母当答案。
            if cur_subj and not re.match(r"^\s*[A-Za-z][A-Za-z \-]*\d*\s*[:：]",
                                         line):
                bucket = result.setdefault(
                    cur_subj, {"module1": [], "module2": []})
                # 题号连续性是判定题型最稳的信号:
                #   从 1 开始且连续 -> 填空 (10 题一组)
                #   从 11/21 开始  -> 选择 (题号成段)
                # 加试的 "11c 12b 13c" 若被当成填空, 会和 module1 的
                # 1-20 填空混在一起, 造成题号重复。
                for q, a, kind in _pairs_by_continuity(
                        line, bucket[cur_mod]):
                    bucket[cur_mod].append({"q": q, "a": a, "kind": kind})
            continue

        subj = m.group("subject").lower()
        if subj != cur_subj:
            # 进入新学科, 之后遇到 Listening Transcript 等标题要能退出
            cur_subj = subj
            cur_mod = f"module{m.group('module')}" if m.group("module") else "module1"
        elif m.group("module"):
            cur_mod = f"module{m.group('module')}"

        body = (m.group("body") or "").strip()
        # 填空题的分号列表（题号区间写在 body 里，无括号）:
        #   "... Fill-in-the-Blank Q1-Q10: shelter; influencing; ..."
        # 带着区间前缀会被 _looks_like_pairs 误判成答案对 -> 先在这里拦截,
        # 按区间起点顺序编号。不是 pairs, 不处理会错位/丢弃。
        mfb2 = (body and m.group("kind")
                and re.search(r"fill|complete|c-test", m.group("kind"), re.I)
                and ";" in body          # 必须真是分号列表: 否则 "...(Q1-10): Modern Biochemistry"
                                         # 这类"标题行带文章名"会被当成单条答案污染 q1
                and re.match(r"^\s*Q?(\d+)\s*[-–—]\s*Q?(\d+)\s*[:：]\s*(.+)$", body))
        if mfb2:
            bucket = result.setdefault(cur_subj, {"module1": [], "module2": []})
            items = [x.strip().rstrip(".。") for x in mfb2.group(3).split(";")]
            for i, a in enumerate(items):
                if a:
                    bucket[cur_mod].append(
                        {"q": int(mfb2.group(1)) + i, "a": a, "kind": "fill"})
        elif body and _looks_like_pairs(body):
            bucket = result.setdefault(cur_subj, {"module1": [], "module2": []})
            for q, a, kind in _pairs(re.sub(r"^\s*Q?\d+\s*[-–—]\s*Q?\d+\s*[:：]\s*", "", body), hint=m.group("kind") or ""):
                bucket[cur_mod].append({"q": q, "a": a, "kind": kind})
        elif not body:
            # 纯标题行: 建好桶, 答案在后续行
            result.setdefault(cur_subj, {"module1": [], "module2": []})
        elif (m.group("kind") and m.group("q1") and ";" in body and re.search(
                r"fill|complete|c-test", m.group("kind"), re.I)):
            # 填空题的分号列表: "... Fill-in-the-Blank Q1-Q10: shelter; influencing; ..."
            # 没有 Q 号前缀, 按区间起点顺序编号。不是 pairs, 不处理会整段丢弃。
            bucket = result.setdefault(cur_subj, {"module1": [], "module2": []})
            items = [x.strip().rstrip(".。") for x in body.split(";")]
            for i, a in enumerate(items):
                if a:
                    bucket[cur_mod].append(
                        {"q": int(m.group("q1")) + i, "a": a, "kind": "fill"})
        # body 存在但不是答案对 (如文章名 "Modern Biochemistry") -> 只切学科/模块

    # 去重: 同一模块里 "Q21 C"(选择题) 和 "21 losses"(填空题) 可能
    # 共用题号, 所以要用 (题号, 题型) 做键, 不能只看题号。
    for s, mods in result.items():
        for mod, lst in mods.items():
            seen, dedup = set(), []
            for it in lst:
                key = (it["q"], it.get("kind", "choice"))
                if key in seen:
                    continue
                seen.add(key)
                dedup.append(it)
            mods[mod] = sorted(dedup, key=lambda x: x["q"])
    return {s: m for s, m in result.items() if any(m.values())}


def parse_answers(text: str) -> dict:
    """
    解析答案文本 -> {subject: {"module1": [...], "module2": [...]}}。

    素材里存在两套排版, 都要能吃下:
      A) 紧凑式 (6.22 等)  "Reading Module 1 Fill-in-the-Blank Q1-Q10: 1 losses; ..."
         -> parse_answers_structured
      B) 分行式 (1.28 等)  "阅读" / "1. encourage 2. aspects" / "第二部份：加试"
         -> parse_answers_loose

    先跑结构化解析, 跑不出东西再回退到宽松解析; 两者结果合并,
    这样同一份答案文件里混用两种排版也不会漏。
    """
    # Wrapped numeric answer: "17.\nD;" must stay one pair.
    text = re.sub(r"(\b(?:Q)?\d{1,2}[.．:]?\s*)\r?\n(?=[A-D](?:\s*[;.]|\s*$))", r"\1 ", text, flags=re.M)
    result = parse_answers_structured(text)
    for subj, mods in parse_answers_loose(text).items():
        for mod, lst in mods.items():
            tgt = result.setdefault(subj, {"module1": [], "module2": []})
            # 宽松解析器不认识"加试"这类中文标记, 会把同一批题再收一遍,
            # 且题型判定可能与结构化解析不同 (choice vs fill) 导致去重键
            # 对不上而重复计入。所以这里**按题号**去重, 不看题型:
            # 同一模块同一题号, 以先解析出的 (结构化优先) 为准。
            have = {x["q"] for x in tgt[mod]}
            tgt[mod].extend([x for x in lst if x["q"] not in have])

    for subj, mods in result.items():
        for mod, lst in mods.items():
            mods[mod] = sorted(lst, key=lambda x: x["q"])
    return {s: m for s, m in result.items() if any(m.values())}


def parse_answers_loose(text: str) -> dict:
    """
    把答案文本切成 {subject: {"module1": [...], "module2": [...]}}。

    观察到两种排版:
      A) 分行式 (1.28 等):
         阅读
         1. encourage 2. aspects ... 20.time
         21b 22d 23b
         第二部份：加试
         1 however ... 15b
      B) 紧凑式 (8.12 等):
         "阅读 1. encourage 2. aspects ..."
    两种都要能吃下, 尽量宽松。
    """
    result: dict = {}
    subj = None
    module = "module1"

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue

        # 学科切换
        m = ANSWER_SECTION_RE.match(line)
        if m:
            canon = {"阅读": "reading", "听力": "listening", "写作": "writing",
                     "口语": "speaking", "Reading": "reading",
                     "Listening": "listening", "Writing": "writing",
                     "Speaking": "speaking"}[m.group(1)]
            subj = canon
            module = "module1"
            result.setdefault(subj, {"module1": [], "module2": []})
            continue

        if subj is None:
            continue

        # 模块切换 (加试 / module 2) —— 该行不含题号答案对时才认
        if MODULE_RE.search(line) and not re.search(r"\d\s*[.．、]?\s*[A-Za-z]", line):
            module = "module2"
            continue

        # 学科名可能和答案同行 (紧凑式)
        inline = re.match(r"^\s*(阅读|听力|写作|口语)\s*[:：]?\s*(.*)$", line)
        if inline:
            canon = {"阅读": "reading", "听力": "listening",
                     "写作": "writing", "口语": "speaking"}[inline.group(1)]
            if canon != subj:
                subj = canon
                module = "module1"
                result.setdefault(subj, {"module1": [], "module2": []})
            line = inline.group(2).strip()
            if not line:
                continue

        # 一次抓出所有 "题号 + 答案"
        n_tok = 0
        for mm in ANSWER_TOKEN_RE.finditer(line):
            if mm.group(1) is not None:
                q, val = int(mm.group(1)), mm.group(2)
            elif mm.group(3) is not None:
                q, val = int(mm.group(3)), mm.group(4)
            else:
                q, val = int(mm.group(5)), mm.group(6)
            kind = _classify(val)
            result[subj][module].append({
                "q": q,
                "a": val.upper() if kind == "choice" else val,
                "kind": kind,
            })
            n_tok += 1
        if n_tok:
            continue

        # 写作句子建构 / 口语的答案就是**整句**, 没有题号前缀:
        #   "do you know if the position requires experience?"
        #   "Soccer matches and practice take place here"
        # 这类只能按出现顺序编号 —— 素材里它们本来就是 1..N 顺序排列的。
        if subj in ("writing", "speaking") and line:
            cur = result[subj][module]
            nxt = len(cur) + 1
            if not any(x["q"] == nxt for x in cur):
                cur.append({"q": nxt, "a": line, "kind": "sentence"})

    # 去重 (同一题可能重复出现), 保留首个
    for s, mods in result.items():
        for mod, lst in mods.items():
            seen, dedup = set(), []
            for it in lst:
                if it["q"] in seen:
                    continue
                seen.add(it["q"])
                dedup.append(it)
            mods[mod] = sorted(dedup, key=lambda x: x["q"])
    return {s: m for s, m in result.items() if any(m.values())}


# ------------------------------------------------------------------ 主流程

def process(manifest_path: Path, build_dir: Path, only: set[str] | None = None):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    pages_root = build_dir / "pages"
    ans_root = build_dir / "answers"
    aud_root = build_dir / "audio"
    for p in (pages_root, ans_root, aud_root):
        p.mkdir(parents=True, exist_ok=True)

    summary = []
    for node in manifest["sets"]:
        sid = node["set_id"]
        if only and sid not in only:
            continue

        rec = {"set_id": sid, "dir": node["dir"],
               "subjects": {}, "answers": {}, "answer_images": {},
               "answers_image_only": [], "audio": []}

        # ---- 题目图片 ----
        for subject, bucket in sorted(node["subjects"].items()):
            for q in bucket["questions"]:
                src = Path(q["path"])
                if not src.exists():
                    continue
                out_dir = pages_root / sid / subject
                # PDF 整卷: 按文件名区分, 避免互相覆盖
                if len(bucket["questions"]) > 1:
                    stem = re.sub(r"[^\w一-鿿]+", "_", src.stem)[:24]
                    out_dir = pages_root / sid / f"{subject}__{stem}"

                if src.suffix.lower() == ".docx":
                    imgs = extract_docx_images(src, out_dir)
                    # 文字层单独存 (可能是纯文字题目)
                    txt = docx_text(src)
                    if txt:
                        (build_dir / "text").mkdir(parents=True, exist_ok=True)
                        (build_dir / "text" /
                         f"{sid}__{subject}__{re.sub(r'[^\w一-鿿]+','_',src.stem)[:24]}.txt"
                        ).write_text(txt, encoding="utf-8")
                elif src.suffix.lower() == ".pdf":
                    imgs = extract_pdf_pages(src, out_dir)
                    txt = pdf_text(src)
                    if txt and len(txt) > 200:
                        (build_dir / "text").mkdir(parents=True, exist_ok=True)
                        (build_dir / "text" /
                         f"{sid}__{subject}__{re.sub(r'[^\w一-鿿]+','_',src.stem)[:24]}.txt"
                        ).write_text(txt, encoding="utf-8")
                else:
                    continue

                key = out_dir.name
                (out_dir / "index.json").write_text(
                    json.dumps(imgs, ensure_ascii=False, indent=2), encoding="utf-8")
                rec["subjects"].setdefault(key, {
                    "source": str(src), "count": len(imgs),
                    "dir": str(out_dir.relative_to(build_dir))})

        # ---- 答案 ----
        # 答案文件名通常只有"答案"/"Answers", 不带学科名, 所以按内容里的
        # 学科标题自行分流: 一个答案文件往往同时含四科。
        for subject, bucket in sorted(node["subjects"].items()):
            for a in bucket["answers"]:
                src = Path(a["path"])
                if not src.exists():
                    continue
                txt = (docx_text(src) if src.suffix.lower() == ".docx"
                       else pdf_text(src))
                if not txt.strip():
                    continue
                parsed = parse_answers(txt)
                if not parsed:
                    # 图片型答案 (扫描/截图), 抽图后交给识别阶段
                    rec["answers_image_only"].append(str(src))
                    if src.suffix.lower() == ".docx":
                        aimgs = extract_docx_images(
                            src, pages_root / sid / "_answers")
                    else:
                        aimgs = extract_pdf_pages(
                            src, pages_root / sid / "_answers")
                    if aimgs:
                        d = pages_root / sid / "_answers"
                        (d / "index.json").write_text(
                            json.dumps(aimgs, ensure_ascii=False, indent=2),
                            encoding="utf-8")
                        rec["answer_images"][subject] = {
                            "source": str(src), "count": len(aimgs),
                            "dir": str(d.relative_to(build_dir))}
                    continue
                for subj_key, val in parsed.items():
                    rec["answers"].setdefault(subj_key, val)
                    (ans_root / f"{sid}__{subj_key}.json").write_text(
                        json.dumps(val, ensure_ascii=False, indent=2),
                        encoding="utf-8")

        # ---- 音频 ----
        for a in node["audio"]:
            src = Path(a["path"])
            if not src.exists() or src.name.startswith("._"):
                continue
            item = {"file": a["file"], "path": str(src),
                    "ext": a["ext"], "size": a["size"]}
            if a["ext"] in {".m4a", ".mp3", ".ogg", ".wav"}:
                item["duration_sec"] = ffprobe_duration(src)
            rec["audio"].append(item)
        if rec["audio"]:
            (aud_root / f"{sid}.json").write_text(
                json.dumps(rec["audio"], ensure_ascii=False, indent=2),
                encoding="utf-8")

        n_img = sum(v["count"] for v in rec["subjects"].values())
        summary.append(rec)
        print(f"[{sid:<22}] 图片 {n_img:>4} 张 | 答案学科 {list(rec['answers'])} "
              f"| 音频 {len(rec['audio'])} 个")

    (build_dir / "extract_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", default="build/manifest.json")
    ap.add_argument("--build", default="build")
    ap.add_argument("--only", nargs="*", help="只处理指定 set_id")
    a = ap.parse_args()
    process(Path(a.manifest), Path(a.build), set(a.only) if a.only else None)


if __name__ == "__main__":
    sys.exit(main())
