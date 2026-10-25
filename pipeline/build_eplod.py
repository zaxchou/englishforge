# -*- coding: utf-8 -*-
"""EnglishPod 导入管线：官方材料 → build/eplod/<ep>.json + 音频库 + 目录 + 词块词库。

来源（只读）：SIB/【EnglishPod】视频及文档都有 全网最全/Englishpod音频、主持人讲解、对话等文本材料/
  每期四件套：dg.mp3 对话 / pb.mp3 主持人讲解课 / rv.mp3 复习 / PDF（对话+Key Vocabulary）
  逐字稿全文来自 ../Englishpod视频及文档资料/EnglishPodAllText.zip（0001.txt…0365.txt）

产物：
  build/eplod/<ep>.json          课节数据（对话+时间戳+词表+词块+讲解逐字稿）
  build/courses/eplod-catalog.json  课程目录（server loadCourses 合并进 series）
  build/vocab/eplod-chunks.json  词块词库（server vocabIndex 合并进背单词 SM-2）
  ../EnglishPod音频库/<ep>/*.mp3  播放用音频（扁平拷贝, 与源目录结构解耦）

时间戳：faster-whisper（本机 CPU, base/int8）只供时间与分段，文本一律以官方 PDF/逐字稿为准。
词块：DeepSeek（TFL_AI_*，同 cfcm 管线），机械护栏=词块必须逐字出现在对话原句里。

用法：
  python pipeline/build_eplod.py 0001            # 解析+对齐（不调 AI）
  python pipeline/build_eplod.py 0001 --chunks   # 追加 DeepSeek 翻译+词块
  python pipeline/build_eplod.py 0001 --apply    # 拷贝音频 + 落盘产物
"""
import json
import re
import shutil
import sys
import time
import unicodedata
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SIB = ROOT.parent
SRC = SIB / "【EnglishPod】视频及文档都有 全网最全" / "Englishpod音频、主持人讲解、对话等文本材料"
TXT_ZIP = SIB / "【EnglishPod】视频及文档都有 全网最全" / "Englishpod视频及文档资料" / "EnglishPodAllText.zip"
AUDIO_LIB = SIB / "EnglishPod音频库"
BUILD_EP = ROOT / "build" / "eplod"
CATALOG = ROOT / "build" / "courses" / "eplod-catalog.json"
CHUNK_BANK = ROOT / "build" / "vocab" / "eplod-chunks.json"

POS_WORDS = {"Phrase", "Verb", "Adjective", "Noun", "Adverb", "Expression", "Preposition", "Conjunction", "Interjection", "Pronoun"}
FOOTER = re.compile(r"Visit the Online Review|Praxis Language|^\s*c⃝", re.M)


def norm_lig(s):
    return (s.replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬀ", "ff").replace("ﬃ", "ffi").replace("ﬄ", "ffl"))


def dehyph(s):
    return re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", s)


def clean_text(s):
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("—", " - ")
    return re.sub(r"\s+", " ", s).strip()


def find_ep_dir(ep):
    for rng in sorted(SRC.iterdir()):
        if not rng.is_dir() or rng.name == "完整版主持人讲解及对话材料":
            continue
        d = rng / ep
        if d.is_dir():
            return d
        # 331-365 布局：0331-0340/0331
        for sub in sorted(rng.iterdir()):
            if sub.is_dir() and (sub / ep).is_dir():
                return sub / ep
    raise SystemExit(f"未找到期号目录: {ep}")


def parse_pdf(pdf_path):
    import pymupdf

    doc = pymupdf.open(pdf_path)
    raw = "\n".join(p.get_text() for p in doc)
    raw = norm_lig(raw)
    # 页脚/版权行跨页打断词表段落, 解析前统一剔除
    lines = [l for l in raw.splitlines() if l.strip() and not FOOTER.search(l)]

    # 标题行: Elementary - Difficult Customer (B0001)
    title_m = re.search(r"^(.+?)\s*-\s*(.+?)\s*\((B\d+)\)\s*$", lines[0].strip())
    if not title_m:
        raise SystemExit("标题行解析失败: " + lines[0])
    level, title, code = (clean_text(title_m.group(i)) for i in (1, 2, 3))

    # 对话: 说话人标记行(A:/B:/C:) + 其后文本直到下一个标记/节尾
    body_end = min((i for i, l in enumerate(lines) if l.strip().startswith("Key Vocabulary")), default=len(lines))
    dialogue = []
    cur = None
    for l in lines[1:body_end]:
        s = l.strip()
        if FOOTER.search(s) or not s:
            continue
        m = re.match(r"^([A-Z]):\s*$", s)
        if m:
            cur = {"spk": m.group(1), "text": ""}
            dialogue.append(cur)
            continue
        if cur is None:
            continue
        if cur["text"].endswith("-"):
            cur["text"] = cur["text"][:-1] + s   # 行尾连字符 = 词被换行劈开
        else:
            cur["text"] += (" " if cur["text"] else "") + s
    for d in dialogue:
        d["text"] = clean_text(dehyph(d["text"]))

    def parse_vocab_section(start_tok, end_tok):
        try:
            a = next(i for i, l in enumerate(lines) if l.strip() == start_tok)
            if end_tok == "Visit":
                b = len(lines)
            else:
                b = next(i for i, l in enumerate(lines) if i > a and l.strip().startswith(end_tok))
        except StopIteration:
            return []
        seg = [l.strip() for l in lines[a + 1 : b] if l.strip()]
        out, i = [], 0
        while i < len(seg) - 1:
            if seg[i + 1] in POS_WORDS:   # 词条行 = 紧跟词性行的那一行
                term, pos = seg[i], seg[i + 1]
                j = i + 2
                buf = []
                while j < len(seg) and not (j + 1 < len(seg) and seg[j + 1] in POS_WORDS):
                    if buf and buf[-1].endswith("-"):
                        buf[-1] = buf[-1][:-1] + seg[j]   # 行尾连字符 = 词被换行劈开
                    else:
                        buf.append(seg[j])
                    j += 1
                out.append({"term": clean_text(term), "pos": pos, "def": clean_text(" ".join(buf))})
                i = j
            else:
                i += 1
        return out

    keyvocab = parse_vocab_section("Key Vocabulary", "Supplementary Vocabulary")
    suppvocab = parse_vocab_section("Supplementary Vocabulary", "Visit")
    return {"level": level, "title": title, "code": code, "dialogue": dialogue, "keyvocab": keyvocab, "suppvocab": suppvocab}


def load_txt(ep):
    """官方逐字稿: 优先 AllText zip; 用户已删 zip 时回退到音频库存档(首次从 zip 解出的副本)。"""
    raw = None
    if TXT_ZIP.exists():
        with zipfile.ZipFile(TXT_ZIP) as z:
            raw = z.read(f"{ep}.txt").decode("utf-8", "replace")
    else:
        p = AUDIO_LIB / "_transcripts" / f"{ep}.txt"
        if not p.exists():
            raise SystemExit(f"逐字稿缺失: zip 已删且无存档 {p}")
        raw = p.read_text(encoding="utf-8", errors="replace")
    raw = norm_lig(raw).replace("\r\n", "\n")
    # 讲解逐字稿: 保留说话人行结构, 行内硬换行合并; 去掉混排在其中的对话重播段之外的原样保留(讲解即全文)
    lines = []
    for l in raw.splitlines():
        s = l.rstrip()
        if not s.strip():
            if lines and lines[-1]["spk"]:
                lines.append({"spk": "", "text": ""})
            continue
        m = re.match(r"^([A-Z]):\s*(.*)$", s)
        if m:
            lines.append({"spk": m.group(1), "text": m.group(2)})
        elif lines:
            lines[-1]["text"] += " " + s.strip()   # 同一说话人的硬换行
        else:
            lines.append({"spk": "", "text": s.strip()})
    out = []
    for l in lines:
        t = clean_text(dehyph(l["text"]))
        if t:
            out.append({"spk": l["spk"], "text": t})
    return out


# ---------------- 对齐 ----------------
def _tokens(s):
    return re.findall(r"[a-z0-9']+", s.lower())


def _overlap(a, b):
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    from difflib import SequenceMatcher

    return SequenceMatcher(None, ta, tb).ratio()


def whisper_segments(mp3, model=None):
    from faster_whisper import WhisperModel

    if model is None:
        model = WhisperModel("base", device="cpu", compute_type="int8")
    segs, _ = model.transcribe(str(mp3), language="en", word_timestamps=True, vad_filter=False)
    out = []
    for s in segs:
        out.append({
            "t0": round(s.start, 2), "t1": round(s.end, 2), "text": s.text.strip(),
            "words": [(w.start, w.end, w.word.strip()) for w in (s.words or [])],
        })
    return out


def align_inorder(official_lines, segs, window=4, thresh=0.45):
    """顺序贪心: 官方行 ↔ whisper 段。1 段对 1 行为主; 行缺时间则保持 None。
    返回 [t0,t1] 列表(可为 None) + 匹配报告。"""
    times = [None] * len(official_lines)
    si = 0
    hits = 0
    for li, line in enumerate(official_lines):
        best, bi = 0.0, None
        for k in range(si, min(si + window, len(segs))):
            r = _overlap(line, segs[k]["text"])
            if r > best:
                best, bi = r, k
        if bi is not None and best >= thresh:
            times[li] = [segs[bi]["t0"], segs[bi]["t1"]]
            si = bi + 1
            hits += 1
    return times, {"lines": len(official_lines), "matched": hits, "segs": len(segs)}


def split_multi(official_lines, times, segs, thresh=0.55):
    """补刀: 一个 whisper 段被两行共享时按词级时间戳劈开。
    仅处理「行 i 无时间, 但某未消费段与 i+i+1 两行拼接高度重合」的简单情形。"""
    from difflib import SequenceMatcher

    used = {tuple(t) for t in times if t}
    for li in range(len(official_lines) - 1):
        if times[li] or times[li + 1]:
            continue
        pair = official_lines[li] + " " + official_lines[li + 1]
        for seg in segs:
            if [seg["t0"], seg["t1"]] in [list(u) for u in used] or not seg["words"]:
                continue
            if _overlap(pair, seg["text"]) >= thresh:
                # 找第二行首 token 在词序列里的位置做切点
                toks2 = _tokens(official_lines[li + 1])
                cut = None
                wi = 0
                words = seg["words"]
                for wi in range(len(words)):
                    if _tokens(words[wi][2]) and _tokens(words[wi][2])[0] == toks2[0]:
                        rest = [_tokens(w[2])[0] for w in words[wi:] if _tokens(w[2])]
                        if rest == toks2[: len(rest)] and len(rest) >= max(1, len(toks2) - 2):
                            cut = wi
                            break
                if cut:
                    times[li] = [seg["t0"], round(words[cut - 1][1], 2)] if cut > 0 else None
                    times[li + 1] = [round(words[cut][0], 2), seg["t1"]]
                    used.add((seg["t0"], seg["t1"]))
                    break
    return times


def ep_range_dirs():
    return [d for d in SRC.iterdir() if d.is_dir() and re.match(r"^\d+-\d+$", d.name)]


# ---------------- DeepSeek 词块 ----------------
def ai_cfg():
    env = {}
    p = ROOT / ".env.local"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*(TFL_AI_\w+)\s*=\s*(.+?)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("'\"")
    return {"key": env.get("TFL_AI_KEY", ""), "base": env.get("TFL_AI_BASE_URL", "https://api.deepseek.com").rstrip("/"), "model": env.get("TFL_AI_MODEL", "deepseek-chat")}


def ai_chunks(ep_data):
    cfg = ai_cfg()
    if not cfg["key"]:
        raise SystemExit("缺 TFL_AI_KEY（.env.local）")
    import urllib.request

    lines = "\n".join(f"{i}. {d['text']}" for i, d in enumerate(ep_data["dialogue"]))
    prompt = f"""你是英语教师。下面是 EnglishPod 第 {int(ep_data['ep'])} 期《{ep_data['title']}》的官方对话（编号为句子序号）。

任务一：把每个句子翻译成自然的中文（zh 数组，按序号顺序）。
任务二：提取 8~15 个值得积累的「语块」（词组/习语/搭配/口语模板），要求：
- 语块必须是材料里实际用到的、主持人式的高频地道表达；孤立单词不要（官方词汇表已覆盖）；
- chunk 必须逐字出现在某个对话句子里（保留原文大小写与标点风格，不含句尾标点）；
- quote_index 指出它出现在哪一句（从 0 数）；
- def 用简短中文释义；note 用中文 1~2 句讲清用法/语气/场合；zh_quote 给出所在句的中文翻译。

只输出 JSON：{{"zh":["句1翻译",...],"chunks":[{{"chunk":"","pos":"","def":"","note":"","quote_index":0,"zh_quote":""}}]}}

对话：
{lines}"""
    body = json.dumps({"model": cfg["model"], "temperature": 0.3, "max_tokens": 4000,
                       "messages": [{"role": "system", "content": "以材料本身为标准，只依据给定对话内容，不引入外部知识。只输出 JSON。"},
                                    {"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(cfg["base"] + "/chat/completions", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["key"]})
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = json.load(r)["choices"][0]["message"]["content"]
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
    data = json.loads(raw)

    dia = ep_data["dialogue"]
    zh = data.get("zh") or []
    if len(zh) != len(dia):
        raise SystemExit(f"翻译句数不符: {len(zh)} != {len(dia)}")
    ep_data["sentencesZh"] = [clean_text(x) for x in zh]

    vocab_key_len = 60
    out, seen = [], set()
    for c in data.get("chunks", []):
        chunk = clean_text(c.get("chunk", ""))
        qi = c.get("quote_index")
        if not chunk or not isinstance(qi, int) or qi < 0 or qi >= len(dia):
            continue
        sent = dia[qi]["text"]
        if chunk.lower() not in sent.lower():
            continue
        k = re.sub(r"\s+", "", chunk.lower())
        if not k or len(k) > vocab_key_len or k in seen:
            continue
        seen.add(k)
        out.append({
            "chunk": chunk, "pos": clean_text(c.get("pos", "")),
            "def": clean_text(c.get("def", ""))[:80], "note": clean_text(c.get("note", ""))[:160],
            "quote": sent, "zh": clean_text(c.get("zh_quote", ""))[:160], "qi": qi,
        })
    if not out:
        raise SystemExit("词块全被护栏拒绝，检查提示词/对话解析")
    ep_data["chunks"] = out
    return out


def chunk_key_ok(chunk):
    return 0 < len(re.sub(r"\s+", "", chunk.lower())) <= 60


# ---------------- 产物 ----------------
def audio_urls(ep):
    return {"dg": f"/media/eplod/{ep}/dg.mp3", "pb": f"/media/eplod/{ep}/pb.mp3", "rv": f"/media/eplod/{ep}/rv.mp3"}


def ffprobe_sec(p):
    try:
        import subprocess

        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(p)], capture_output=True, text=True, timeout=30)
        return round(float(r.stdout.strip()), 1)
    except Exception:
        return None


def update_catalog(ep_data, dur_pb):
    ep4 = str(ep_data["ep"]).zfill(4)
    cat = {"generated": time.strftime("%F %T"), "kind": "eplod", "series": []}
    if CATALOG.exists():
        cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    s = next((x for x in cat["series"] if x["id"] == "eplod"), None)
    if not s:
        s = {"id": "eplod", "name": "EnglishPod", "courses": []}
        cat["series"].append(s)
    c = next((x for x in s["courses"] if x["id"] == "eplod-01"), None)
    if not c:
        c = {"id": "eplod-01", "title": "EnglishPod 精听深学", "kind": "eplod", "teacher": "Marco & Amira",
             "subject": "听力", "no": None, "lesson_count": 0, "lessons": []}
        s["courses"].append(c)
    lesson = {"id": f"eplod-{ep4}", "title": f"#{ep4} {ep_data['title']}", "level": ep_data["level"],
              "channel": ep_data.get("channel") or "", "audio": audio_urls(ep4),
              "duration_sec": dur_pb, "ep": int(ep_data["ep"])}
    c["lessons"] = [l for l in c["lessons"] if l["id"] != lesson["id"]] + [lesson]
    c["lessons"].sort(key=lambda x: x["ep"])
    c["lesson_count"] = len(c["lessons"])
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")


def update_chunk_bank(ep_data):
    bank = {"version": 1, "generated": time.strftime("%F %T"), "source": "eplod", "batches": []}
    if CHUNK_BANK.exists():
        bank = json.loads(CHUNK_BANK.read_text(encoding="utf-8"))
    bid = f"eplod-{ep_data['ep']}"
    bank["batches"] = [b for b in bank["batches"] if b["id"] != bid]
    words = []
    for c in ep_data.get("chunks", []):
        if not chunk_key_ok(c["chunk"]):
            continue
        words.append({"w": c["chunk"], "ipa": "", "def": c["def"] + ("；" + c["note"] if c["note"] else ""),
                      "sen": c["quote"], "senZh": c["zh"], "lesson": ep_data["ep"]})
    bank["batches"].append({"id": bid, "lesson": ep_data["ep"], "kind": "eplod", "root": "EnglishPod",
                            "gloss": f"#{ep_data['ep']} {ep_data['title']}", "words": words})
    CHUNK_BANK.parent.mkdir(parents=True, exist_ok=True)
    CHUNK_BANK.write_text(json.dumps(bank, ensure_ascii=False, indent=1), encoding="utf-8")


def main():
    ep = sys.argv[1].zfill(4)
    do_chunks = "--chunks" in sys.argv
    do_apply = "--apply" in sys.argv
    t0 = time.time()

    d = find_ep_dir(ep)
    print(f"[1] 目录: {d}")
    pdf = next(d.glob("*.pdf"))
    data = parse_pdf(pdf)
    data["ep"] = int(ep)
    print(f"    {data['level']} - {data['title']} ({data['code']})  对话 {len(data['dialogue'])} 句  词表 {len(data['keyvocab'])}+{len(data['suppvocab'])}")

    print("[2] 逐字稿")
    expl = load_txt(ep)
    print(f"    讲解逐字稿 {len(expl)} 行")

    print("[3] whisper 对齐")
    dg = next(d.glob("*dg.mp3"))
    pb = next(d.glob("*pb.mp3"))
    rv = next(d.glob("*rv.mp3"))
    segs_dg = whisper_segments(dg)
    # 跳过片头 jingle（如 "EnglishPod.com"）
    dia = [x["text"] for x in data["dialogue"]]
    times, rep = align_inorder(dia, segs_dg)
    times = split_multi(dia, times, segs_dg)
    for i, t in enumerate(times):
        data["dialogue"][i]["t0"], data["dialogue"][i]["t1"] = (t if t else [None, None])
    print(f"    对话: {rep['matched']}/{rep['lines']} 句有时间戳")
    if rep["matched"] < rep["lines"] * 0.7:
        print("    !! 对话对齐率过低，先检查再继续", file=sys.stderr)

    segs_pb = whisper_segments(pb)
    expl_lines = [x["text"] for x in expl]
    times_pb, rep_pb = align_inorder(expl_lines, segs_pb, window=6, thresh=0.4)
    times_pb = split_multi(expl_lines, times_pb, segs_pb)
    for i, t in enumerate(times_pb):
        expl[i]["t0"], expl[i]["t1"] = (t if t else [None, None])
    print(f"    讲解: {rep_pb['matched']}/{rep_pb['lines']} 行有时间戳（段 {rep_pb['segs']}）")

    data["explanation"] = expl
    data["audio"] = audio_urls(ep)
    data["durations"] = {"dg": ffprobe_sec(dg), "pb": ffprobe_sec(pb), "rv": ffprobe_sec(rv)}

    if not do_chunks:
        # 重跑解析/对齐时保留已生成的 AI 产物(词块+翻译), 不重复花钱
        prev = BUILD_EP / f"{ep}.json"
        if prev.exists():
            try:
                old = json.loads(prev.read_text(encoding="utf-8"))
                if old.get("chunks"):
                    data["chunks"] = old["chunks"]
                if old.get("sentencesZh"):
                    data["sentencesZh"] = old["sentencesZh"]
            except Exception:
                pass

    if do_chunks:
        print("[4] DeepSeek 翻译+词块")
        chunks = ai_chunks(data)
        print(f"    词块 {len(chunks)} 个（护栏后）")
        update_chunk_bank(data)

    if do_apply:
        print("[5] 拷贝音频 + 落盘")
        outd = AUDIO_LIB / ep
        outd.mkdir(parents=True, exist_ok=True)
        for f, name in ((dg, "dg.mp3"), (pb, "pb.mp3"), (rv, "rv.mp3")):
            shutil.copy2(f, outd / name)   # 归一文件名, 与 /media/eplod/<ep>/dg.mp3 对齐
        BUILD_EP.mkdir(parents=True, exist_ok=True)
        (BUILD_EP / f"{ep}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        update_catalog(data, data["durations"]["pb"])
        print(f"    音频 → {outd}")
        print(f"    课节 → {BUILD_EP / (ep + '.json')}")

    print(f"完成 {round(time.time()-t0,1)}s")


if __name__ == "__main__":
    main()
