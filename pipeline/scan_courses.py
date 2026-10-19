#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""扫描视频课程素材（vince托福课 + 新D方新托福全套），生成课程目录与讲义文本。

产物（只写 build/courses/，源素材只读）：
  build/courses/catalog.json      课程目录（web 原型经 /api/courses 读取）
  build/courses/notes/<id>.json   讲义提取文本（PPTX 逐页 / PDF 逐页，保留来源页码）

用法：
  python scan_courses.py --root <JunEnglish 根> --build <toefl-lab/build>
约定：
  - 文件名自带章节结构，可解析为目录树；但文件名只能生成目录，不能生成教学映射。
  - 本脚本只做：配对(视频↔讲义)、提取讲义文本、分类(科目)。教学要点标注状态为 draft，
    由人工/agent 实际阅读后在 catalog 上游标注 verified。
"""
import argparse
import json
import re
import sys
import zipfile
from datetime import date
from pathlib import Path
from xml.etree import ElementTree as ET

A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def pptx_slides(p: Path):
    """PPTX -> [{"page": n, "text": "..."}]，纯标准库解 zip+XML。"""
    out = []
    try:
        with zipfile.ZipFile(p) as z:
            names = [n for n in z.namelist()
                     if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)]
            names.sort(key=lambda n: int(re.search(r"(\d+)", n).group(1)))
            for n in names:
                root = ET.fromstring(z.read(n))
                texts = [t.text for t in root.iter(A_NS + "t") if t.text and t.text.strip()]
                out.append({"page": len(out) + 1, "text": "\n".join(texts)})
    except Exception as e:
        print(f"  ! pptx 解析失败 {p.name}: {e}", file=sys.stderr)
    return out


def pdf_pages(p: Path):
    try:
        import fitz
    except ImportError:
        print("  ! 需要 PyMuPDF 才能读 PDF 讲义", file=sys.stderr)
        return []
    out = []
    try:
        doc = fitz.open(str(p))
        for i, page in enumerate(doc):
            out.append({"page": i + 1, "text": page.get_text("text")})
        doc.close()
    except Exception as e:
        print(f"  ! pdf 解析失败 {p.name}: {e}", file=sys.stderr)
    return out


def enc(p: str) -> str:
    """构造可直接放进 <video src> 的相对 URL（路径段逐段转义）。"""
    from urllib.parse import quote
    return quote(p)


def notes_write(notes_dir: Path, nid: str, kind: str, source_file: str, pages) -> str:
    notes_dir.mkdir(parents=True, exist_ok=True)
    obj = {"id": nid, "kind": kind, "source_file": source_file,
           "extracted": date.today().isoformat(),
           "pages": pages, "status": "extracted"}
    (notes_dir / f"{nid}.json").write_text(
        json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    return nid


def extract_slide_images(p: Path, nid: str, build: Path):
    """图片版 PPTX：把每页媒体截图按页序抽到 build/courses/slide_images/<nid>/。
    返回抽出的张数（0 = 文字版或无图）。"""
    try:
        with zipfile.ZipFile(p) as z:
            slide_names = sorted(
                (n for n in z.namelist()
                 if re.fullmatch(r"ppt/slides/slide\d+\.xml", n)),
                key=lambda n: int(re.search(r"(\d+)", n).group(1)))
            out_dir = build / "courses" / "slide_images" / nid
            n = 0
            for i, sn in enumerate(slide_names, start=1):
                rels_name = f"ppt/slides/_rels/slide{i}.xml.rels"
                if rels_name not in z.namelist():
                    continue
                rels = z.read(rels_name).decode("utf-8")
                for img in re.findall(r'Target="\.\./media/([^"]+)"', rels):
                    ext = img.rsplit(".", 1)[-1].lower()
                    if ext not in ("png", "jpg", "jpeg"):
                        continue
                    out_dir.mkdir(parents=True, exist_ok=True)
                    (out_dir / f"s{i:02d}.{ext}").write_bytes(z.read("ppt/media/" + img))
                    n += 1
                    break   # 每页取第一张主图
            return n
    except Exception as e:
        print(f"  ! 讲义页图抽取失败 {p.name}: {e}", file=sys.stderr)
        return 0


def scan_vince(root: Path, notes_dir: Path, build: Path):
    """vince托福课：17 个 mp4 + 同名 PPTX。按编号前缀聚成课程。"""
    d = root / "vince托福课"
    if not d.is_dir():
        return None
    vids = sorted(d.glob("*.mp4"))
    courses = {}
    for v in vids:
        m = re.match(r"(\d+)\.(.+)\.mp4$", v.name)
        if not m:
            continue
        no, title = int(m.group(1)), m.group(2)
        pptx = None
        for cand in d.glob(f"{v.stem}_*.pptx"):
            pptx = cand
            break
        subj = ("intro" if no == 1 else
                "reading" if no in (2, 3, 4, 5, 6) else
                "listening" if no == 7 else
                "writing" if no == 8 else "speaking")
        c = courses.setdefault(no, {
            "id": f"vince-{no}", "series": "vince", "no": no,
            "title": re.sub(r"^(阅读|听力|写作|口语)\s*", "", title) or title,
            "raw_title": title, "subject": subj, "teacher": "vince",
            "lessons": [], "notes_ids": [], "notes_status": "none",
        })
        lid = f"vince-{no}-l{len(c['lessons']) + 1}"
        c["lessons"].append({
            "id": lid, "title": title,
            "video": f"/media/vince/{enc(v.name)}", "video_file": v.name,
            "video_size": v.stat().st_size,
            "handout": f"/media/vince/{enc(pptx.name)}" if pptx else None,
            "handout_file": pptx.name if pptx else None,
            "duration_sec": None,
        })
        if pptx:
            nid = lid
            pages = pptx_slides(pptx)
            n_imgs = 0
            if not any(pg["text"].strip() for pg in pages):
                # 文字层为空 = 图片版讲义（视频截图帧），抽页图供浏览器展示
                n_imgs = extract_slide_images(pptx, nid, build)
            notes_write(notes_dir, nid, "pptx", pptx.name, pages)
            if n_imgs:
                meta = notes_dir / f"{nid}.json"
                obj = json.loads(meta.read_text(encoding="utf-8"))
                obj["slide_images"] = n_imgs
                meta.write_text(json.dumps(obj, ensure_ascii=False, indent=1),
                                encoding="utf-8")
            c["notes_ids"].append(nid)
            c["notes_status"] = "extracted"
    out = []
    for no in sorted(courses):
        c = courses[no]
        c["lesson_count"] = len(c["lessons"])
        out.append(c)
    return {"id": "vince", "name": "vince 托福课",
            "note": f"{sum(c['lesson_count'] for c in out)} 节 · 每节配 PPTX 讲义",
            "courses": out}


# Display titles only: keep source filenames, lesson IDs and media URLs unchanged.
VOCAB_ROOT_FORMS = {
    "scribscript": "scrib / script", "spectvis": "spect / vis",
    "versvert": "vers / vert", "vocnouncedict": "voc / nounce / dict",
    "pelpuls": "pel / puls", "cedceedcess": "ced / ceed / cess",
    "optsn": "opt / sn", "humanthropgen": "hum / anthrop / gen",
    "capsci": "cap / sci", "candflamphoto": "cand / flam / photo",
    "amtim": "am / tim",
}


def vocab_lesson_title(title: str) -> str:
    """Readable labels based on reviewed transcript root groupings; no guessed splits."""
    match = re.fullmatch(r"(基础|核心|进阶)词汇之(?:词根)?\s*([a-z]+)", title.strip())
    if not match:
        return title
    roots = VOCAB_ROOT_FORMS.get(match.group(2), match.group(2))
    return f"{match.group(1)}词汇 · 词根 {roots}"


def scan_ndf(root: Path, notes_dir: Path):
    """新D方新托福全套：01~07 课目录，.mov 课节 + PDF 讲义。"""
    base = root / "新D方" / "新D方新托福全套"
    if not base.is_dir():
        return None
    META = {
        "01": ("词汇", "孙曦", "vocab"), "02": ("阅写基础能力", "基础能力", "reading"),
        "03": ("听口基础能力", "基础能力", "listening"),
        "04": ("听力", "郭小钰", "listening"), "05": ("阅读", "刘倩俐", "reading"),
        "06": ("写作", "徐欣", "writing"), "07": ("口语", "张莹炜", "speaking"),
    }
    courses = []
    for d in sorted(base.iterdir()):
        if not d.is_dir():
            continue
        m = re.match(r"(\d+)\s+(.+)$", d.name)
        if not m or m.group(1) not in META:
            continue
        no, unit, teacher, subj = m.group(1), *META[m.group(1)]
        movs = sorted(d.glob("*.mov"))
        lessons = []
        for v in movs:
            t = re.match(r"(\d+)\s+(.+)\.mov$", v.name)
            lessons.append({
                "id": f"ndf-{no}-{t.group(1)}" if t else f"ndf-{no}-{len(lessons)+1}",
                "no": t.group(1) if t else None,
                "title": vocab_lesson_title(t.group(2) if t else v.stem) if no == "01" else (t.group(2) if t else v.stem),
                "video": f"/media/ndf/{enc(d.name)}/{enc(v.name)}",
                "video_file": v.name, "video_size": v.stat().st_size,
                "duration_sec": None,
            })
        c = {"id": f"ndf-{no}", "series": "ndf", "no": int(no), "unit": unit,
             "title": d.name, "subject": subj, "teacher": teacher,
             "lessons": lessons, "lesson_count": len(lessons),
             "handout_pdfs": [], "notes_ids": [], "notes_status": "none"}
        pdfs = sorted(d.glob("*.pdf")) + sorted(p for p in d.rglob("*.pdf") if p.parent != d)
        for i, pdf in enumerate(pdfs):
            relative = pdf.relative_to(d).as_posix()
            c["handout_pdfs"].append(relative)
            nid = f"ndf-{no}-h{i+1}"
            pages = pdf_pages(pdf)
            if pages:
                notes_write(notes_dir, nid, "pdf", relative, pages)
                c["notes_ids"].append(nid)
                c["notes_status"] = "extracted"
        # Explicit dedicated mappings are review-owned. Preserve their one-file links
        # after a rescan; never infer a match from nearest filename or page.
        mapping_file = notes_dir.parent / "lesson-handout-map.json"
        if mapping_file.exists():
            mapping = json.loads(mapping_file.read_text(encoding="utf-8"))
            for lesson in lessons:
                match = mapping.get(c["id"], {}).get("lessons", {}).get(lesson["id"], {})
                if match.get("status") != "dedicated" or match.get("nid") not in c["notes_ids"]:
                    continue
                note = json.loads((notes_dir / (match["nid"] + ".json")).read_text(encoding="utf-8"))
                relative = note["source_file"]
                if relative in c["handout_pdfs"]:
                    lesson["handout_file"] = relative
                    lesson["handout"] = f"/media/ndf/{enc(d.name)}/{enc(relative)}"
        courses.append(c)
    return {"id": "ndf", "name": "新D方 新托福全套",
            "note": f"{len(courses)} 门课 · {sum(c['lesson_count'] for c in courses)} 节 · 配 PDF 讲义",
            "courses": courses}


CN_DIGITS = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn2int(s: str) -> int:
    """中文数字课号（本课程范围 1~99）：十/廿组合，如 三十六 -> 36。"""
    s = s.strip()
    if s.isdigit():
        return int(s)
    if s == "十":
        return 10
    total, rest = 0, s
    if "十" in rest:
        head, rest = rest.split("十", 1)
        total += CN_DIGITS[head] * 10 if head else 10
    if rest:
        total += CN_DIGITS[rest]
    return total


CFCM_DIR = "炒粉炒面万词班（待更新）"
CFCM_LESSON_HEAD = re.compile(r"万词班第([一二三四五六七八九十百零]+|\d+)课讲义（(\d+) 个）")
CFCM_ROOT_HEAD = re.compile(r"词根\d+：([A-Za-z][A-Za-z \-]*?)，([^（]+)（(\d+) 个）")


def scan_cfcm(root: Path, notes_dir: Path):
    """炒粉炒面万词班（最终季 36 节）：视频 + 合订本讲义按课边界拆页。

    讲义是一份 582 页 PDF，每课以「万词班第X课讲义（N 个）」标题行开始；
    逐课切成独立 notes（nid=课节 id，页码在本课内重新从 1 计），
    前端讲义 tab 命中 notes_ids 含课节 id 的分支即一课一份。
    官方课后练习由 import_cfcm_quiz.py 另行解析导入，不在本扫描内。"""
    base = root / CFCM_DIR
    if not base.is_dir():
        return None
    handout = base / "资料合集" / "1.直播课讲义+ppt" / "（1）1-36课讲义.pdf"
    if not handout.is_file():
        print(f"  ! cfcm 讲义缺失: {handout}", file=sys.stderr)
        return None
    pages = pdf_pages(handout)
    if not pages:
        return None
    starts = []   # (页下标0, 课号, 词数)
    for i, pg in enumerate(pages):
        m = CFCM_LESSON_HEAD.search(pg["text"])
        if m:
            starts.append((i, cn2int(m.group(1)), int(m.group(2))))
    nos = [no for _, no, _ in starts]
    if nos != list(range(1, len(nos) + 1)):
        print(f"  ! cfcm 课边界异常: {len(nos)} 课, 序列 {nos[:6]}...{nos[-3:]}", file=sys.stderr)
        return None

    # 每课的词根清单（标题用）与词表（解释溯源用，import_cfcm_quiz.py 复读同一逻辑）
    lessons, notes_ids, total_words = [], [], 0
    for i, (idx0, no, wc) in enumerate(starts):
        end = starts[i + 1][0] if i + 1 < len(starts) else len(pages)
        seg = [pg["text"] for pg in pages[idx0:end]]
        seg_text = "\n".join(seg)
        roots = [r.strip() for r, _g, _n in
                 ((m.group(1), m.group(2), m.group(3)) for m in CFCM_ROOT_HEAD.finditer(seg_text))]
        title = f"第{no:02d}课"
        if roots:
            title += " · " + " / ".join(roots[:3]) + ("…" if len(roots) > 3 else "")
        nid = f"cfcm-01-{no:02d}"
        notes_write(notes_dir, nid, "pdf", handout.name,
                    [{"page": j + 1, "text": t} for j, t in enumerate(seg)])
        notes_ids.append(nid)
        total_words += wc
        # 视频文件名是中文数字（[1]--第一课.mp4 … [36]--第三十六课.mp4）；
        # 文件名含字面方括号，glob 的 [] 是字符类语法，故用前缀匹配。
        vid = next((p for p in base.iterdir()
                    if p.name.startswith(f"[{no}]--") and p.suffix == ".mp4"), None)
        if vid is None:
            print(f"  ! cfcm 第{no}课视频缺失", file=sys.stderr)
            continue
        lessons.append({
            "id": nid, "no": str(no).zfill(2), "title": title,
            "raw_title": vid.stem, "cn_title": vid.stem.split("--", 1)[-1],
            "video": f"/media/cfcm/{enc(vid.name)}", "video_file": vid.name,
            "video_size": vid.stat().st_size, "duration_sec": None,
            "words": wc, "root_count": len(roots),
        })
    c = {"id": "cfcm-01", "series": "cfcm", "no": 1, "unit": "词汇",
         "title": "万词班·最终季", "raw_title": base.name,
         "subject": "vocab", "teacher": "炒面学姐",
         "lessons": lessons, "lesson_count": len(lessons),
         "handout_pdfs": [], "notes_ids": notes_ids, "notes_status": "extracted"}
    return {"id": "cfcm", "name": "炒粉炒面万词班",
            "note": f"{len(lessons)} 节 · {total_words} 词 · 老师官方课后练习",
            "courses": [c]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="JunEnglish 根目录（含 vince托福课/ 新D方/）")
    ap.add_argument("--build", required=True, help="toefl-lab/build 目录")
    args = ap.parse_args()
    root, build = Path(args.root), Path(args.build)
    notes_dir = build / "courses" / "notes"
    series = []
    v = scan_vince(root, notes_dir, build)
    if v:
        series.append(v)
    n = scan_ndf(root, notes_dir)
    if n:
        series.append(n)
    cf = scan_cfcm(root, notes_dir)
    if cf:
        series.append(cf)
    catalog = {
        "generated": date.today().isoformat(),
        "status_rule": ("notes_status=extracted 表示讲义文本已提取（草稿）；"
                        "教学要点 verified 需人工/agent 实际阅读后另行标注。"
                        "文件名生成的目录不是教学映射。"),
        "series": series,
    }
    out = build / "courses" / "catalog.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(catalog, ensure_ascii=False, indent=1), encoding="utf-8")
    n_lessons = sum(c["lesson_count"] for s in series for c in s["courses"])
    n_notes = len(list(notes_dir.glob("*.json"))) if notes_dir.is_dir() else 0
    print(f"[scan_courses] {len(series)} 系列 · {n_lessons} 节 · 讲义提取 {n_notes} 份 -> {out}")


if __name__ == "__main__":
    main()
