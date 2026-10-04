#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
托福真题素材盘点器 (manifest scanner)

作用: 遍历素材根目录, 识别出所有"套题"(set), 以及每套题里的
      题目文件 / 答案文件 / 听力原文 / 音频, 输出 machine-readable 的 manifest.json。

设计要点
--------
素材有两个家族, 结构完全不同, 必须分别对待:

  A) DOCX 家族  (2026真题持续更新中/**)
     - 题目 = DOCX 内嵌截图 (word/media/*.png), 每张图 = 一道题
     - 答案 = DOCX 纯文本 (word/document.xml), 可直接抽取
     - 音频 = 同目录或子目录的 m4a/mp3

  B) PDF 家族   (托福18套/**, 【201】新版本自学礼包/**, 2026新托福改革新题型13套/**)
     - 题目 = 扫描版 PDF (仅水印文字层), 需渲染成图片后识别
     - 答案 = 文字版 PDF, 可直接抽文本
     - 音频 = 同目录 mp3/m4a

用法
----
python scan_manifest.py --root "Z:/.../819新托福真题持续更新" --out build/manifest.json
"""

from __future__ import annotations
import argparse
import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- 关键词规则

# 学科关键词 -> 规范学科名。顺序即优先级 (先匹配到的胜出)。
SUBJECT_RULES = [
    ("listening",  re.compile(r"听力|Listening|listening", re.I)),
    ("speaking",  re.compile(r"口语|Speaking|speaking", re.I)),
    ("reading",   re.compile(r"阅读|Reading|reading", re.I)),
    ("writing",   re.compile(r"写作|Writing|writing", re.I)),
]

# 角色关键词
ANSWER_RE    = re.compile(r"答案|answer|key", re.I)
TRANSCRIPT_RE = re.compile(r"听力原文|原文|transcript|script", re.I)
AUDIO_RE     = re.compile(r"\.(m4a|mp3|ogg|wav|mp4|mov|ts)$", re.I)
MEDIA_RE     = re.compile(r"\.(pdf|docx)$", re.I)

# 明显不是真题的目录/文件 (词汇书、课程、评分标准等)
EXCLUDE_RE = re.compile(
    r"词汇|语法|网课|课程|评分|标准|样题说明|改革后综述|一键通|"
    r"TOEFL\+Essentials|母题|自学礼包|体验日|付费新题",
    re.I,
)

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


# ---------------------------------------------------------------- 工具函数

def classify_subject(name: str):
    """按关键词判定学科; 判定不了返回 None。"""
    base = os.path.basename(name)
    for canon, rx in SUBJECT_RULES:
        if rx.search(base):
            return canon
    return None


def is_excluded(relpath: str) -> bool:
    return bool(EXCLUDE_RE.search(relpath))


def guess_set_id(rel_dir: str) -> str:
    """
    从相对目录推断套题 ID。
    '2026真题持续更新中/1月/1.28' -> '2026-01-28'
    '托福18套/00. TPO1-6 .../2026新托福Pack-1' -> 'TPO-Pack-1'
    """
    parts = [p for p in rel_dir.split(os.sep) if p and p != "."]

    # 命中 "N月/N.D" 形态
    for i, p in enumerate(parts):
        if re.fullmatch(r"\d{1,2}月", p) and i + 1 < len(parts):
            nxt = parts[i + 1]
            m = re.match(r"(\d{1,2})[.\-](\d{1,2})", nxt)
            if m:
                return f"2026-{int(m.group(1)):02d}-{int(m.group(2)):02d}"
            if re.fullmatch(r"\d{1,2}[.\-]\d{1,2}.*", nxt):
                return f"2026-{nxt}"

    # 退化: 用目录名本身
    return parts[-1] if parts else "root"


def guess_set_title(rel_dir: str) -> str:
    parts = [p for p in rel_dir.split(os.sep) if p and p != "."]
    return " / ".join(parts[-2:]) if len(parts) >= 2 else (parts[-1] if parts else "root")


# ---------------------------------------------------------------- DOCX 探查

def probe_docx(path: Path) -> dict:
    """统计 DOCX 内嵌图片数与是否含文字层。"""
    import zipfile
    info = {"images": 0, "has_text": False, "text_len": 0}
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            info["images"] = sum(
                1 for n in names
                if n.lower().startswith("word/media/")
                and os.path.splitext(n)[1].lower() in IMAGE_EXT
            )
            if "word/document.xml" in names:
                xml = z.read("word/document.xml").decode("utf-8", errors="ignore")
                txt = re.sub(r"<[^>]+>", "", xml)
                info["text_len"] = len(txt.strip())
                info["has_text"] = info["text_len"] > 30
    except Exception as e:  # noqa: BLE001
        info["error"] = str(e)
    return info


# ---------------------------------------------------------------- PDF 探查

def probe_pdf(path: Path) -> dict:
    """判断 PDF 是扫描版还是文字版, 并统计页数。"""
    info = {"pages": 0, "text_chars": 0, "scanned": None}
    try:
        import fitz
        # 部分 PDF xref 损坏, 会刷大量 MuPDF error; 属正常, 静音掉
        fitz.TOOLS.mupdf_display_errors(False)
        with fitz.open(path) as d:
            info["pages"] = d.page_count
            total = 0
            for i in range(min(d.page_count, 8)):
                total += len(d[i].get_text().strip())
            info["text_chars"] = total
            # 抽样前8页平均每页 <30 字符 -> 视为扫描版
            avg = total / max(1, min(d.page_count, 8))
            info["scanned"] = avg < 30
    except Exception as e:  # noqa: BLE001
        info["error"] = str(e)
    return info


# ---------------------------------------------------------------- 主扫描

def scan(root: Path, out_path: Path):
    sets = {}
    skipped = []

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in ("__MACOSX", ".accelerate")]
        dp = Path(dirpath)
        rel_dir = os.path.relpath(dp, root)

        media_files = [f for f in filenames if MEDIA_RE.search(f)]
        audio_files = [f for f in filenames if AUDIO_RE.search(f)]
        if not media_files and not audio_files:
            continue

        if is_excluded(rel_dir):
            skipped.append({"dir": rel_dir, "reason": "excluded-vocab-or-course"})
            continue

        set_id = guess_set_id(rel_dir)
        node = sets.setdefault(set_id, {
            "set_id": set_id,
            "title": guess_set_title(rel_dir),
            "dir": rel_dir,
            "abs_dir": str(dp),
            "subjects": {},     # subject -> {"questions": [...], "answers": [...], ...}
            "audio": [],
        })

        for f in sorted(media_files):
            fp = dp / f
            subject = classify_subject(f)
            role = "answers" if ANSWER_RE.search(f) else (
                   "transcript" if TRANSCRIPT_RE.search(f) else "questions")
            rec = {"file": f, "path": str(fp), "size": fp.stat().st_size}
            if fp.suffix.lower() == ".docx":
                rec.update(probe_docx(fp))
                rec["kind"] = "docx"
            else:
                rec.update(probe_pdf(fp))
                rec["kind"] = "pdf"

            bucket = node["subjects"].setdefault(
                subject or "unknown", {"questions": [], "answers": [], "transcript": []})
            if role == "answers":
                bucket["answers"].append(rec)
            elif role == "transcript":
                bucket["transcript"].append(rec)
            else:
                bucket["questions"].append(rec)

        for f in sorted(audio_files):
            if f.startswith("._"):
                continue
            fp = dp / f
            node["audio"].append({
                "file": f,
                "path": str(fp),
                "size": fp.stat().st_size,
                "ext": fp.suffix.lower(),
                # 从文件名里认模块 (part1/module1/module2/口语...)
                "hint": (f.lower() if re.search(r"part|module|口语|speaking|听力|listening", f.lower())
                         else None),
            })

    # 只保留"有内容"的套题
    result = []
    for sid, node in sorted(sets.items()):
        has_q = any(b["questions"] for b in node["subjects"].values())
        if not has_q:
            skipped.append({"dir": node["dir"], "reason": "no-question-file"})
            continue
        result.append(node)

    payload = {
        "root": str(root),
        "set_count": len(result),
        "sets": result,
        "skipped": skipped,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- 控制台摘要 ----
    def w(s: str, n: int) -> str:
        """按显示宽度补齐 (CJK 算2格)。"""
        s = str(s)
        width = sum(2 if ord(c) > 0x2E80 else 1 for c in s)
        return s + " " * max(1, n - width)

    print(f"\n扫描完成: {len(result)} 套题  ->  {out_path}\n")
    print(w("套题ID", 26) + w("学科", 36) + w("题(扫描/文字)", 18)
          + w("答案", 8) + "音频")
    print("-" * 104)
    for node in result:
        subj_bits, q_scan, q_txt, ans_n = [], 0, 0, 0
        for s, b in sorted(node["subjects"].items()):
            n = len(b["questions"])
            if not n:
                continue
            # unknown = 整卷合并册 (一个 PDF 含四科), 单独标注
            subj_bits.append({"listening": "听", "reading": "读",
                              "writing": "写", "speaking": "口",
                              "unknown": "整卷"}[s])
            for r in b["questions"]:
                if r.get("scanned") is True or (r.get("images", 0) > 0 and not r.get("has_text")):
                    q_scan += 1
                else:
                    q_txt += 1
            ans_n += len(b["answers"])
        print(w(node["set_id"], 26) + w(",".join(subj_bits), 36)
              + w(f"{q_scan}/{q_txt}", 18) + w(ans_n, 8) + str(len(node["audio"])))
    if skipped:
        print(f"\n跳过 {len(skipped)} 个目录 (词汇/课程/无题目)")
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--out", default="build/manifest.json")
    a = ap.parse_args()
    scan(Path(a.root), Path(a.out))


if __name__ == "__main__":
    sys.exit(main())
