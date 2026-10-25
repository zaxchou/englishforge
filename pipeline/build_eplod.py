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

# 官方分级表(每日英语听力口径, pipeline/eplod-levels.json): 365 期难度穿插,
# PDF 标题的 level 命名混乱(Upper-Intermediate/Advanced), 排序与展示一律以本表为准。
LEVEL_MAP_FILE = Path(__file__).resolve().parent / "eplod-levels.json"


def load_level_map():
    m = {}
    for lv in json.loads(LEVEL_MAP_FILE.read_text(encoding="utf-8"))["levels"]:
        for e in lv["eps"]:
            m[e] = {"name": lv["name"], "zh": lv["zh"], "rank": lv["rank"]}
    return m


def norm_lig(s):
    return (s.replace("ﬁ", "fi").replace("ﬂ", "fl").replace("ﬀ", "ff").replace("ﬃ", "ffi").replace("ﬄ", "ffl"))


def dehyph(s):
    s = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", s)
    # 已被空格连接的断词(逐字稿行合并后): "compli- mentary" → "complimentary"
    return re.sub(r"(\w)- (?=\w)", r"\1", s)


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


# ---------------- 对齐（全局词级） ----------------
_NUM_WORDS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven",
              "8": "eight", "9": "nine", "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen",
              "15": "fifteen", "16": "sixteen", "17": "seventeen", "18": "eighteen", "19": "nineteen", "20": "twenty",
              "30": "thirty", "40": "forty", "50": "fifty", "60": "sixty", "70": "seventy", "80": "eighty", "90": "ninety",
              "100": "hundred", "1000": "thousand"}


def _tokens(s):
    # 数字归一: ASR 常把 "Twenty minutes?" 写成 "20 minutes?", 对齐时等值处理
    return [_NUM_WORDS.get(w, w) for w in re.findall(r"[a-z0-9']+", s.lower())]


def global_align(official_lines, segs):
    """官方行序列 vs whisper 词序列的全局对齐（difflib 词级 LCS）。
    whisper 词时间映射回官方词 → 行时间 = 行内匹配词的 min(t0)/max(t1)。
    匹配词占比过低的行返回 None（后续并入听写块）。"""
    from difflib import SequenceMatcher

    off_words, owner = [], []
    for li, line in enumerate(official_lines):
        for w in _tokens(line):
            off_words.append(w)
            owner.append(li)
    asr_words, asr_times = [], []
    for seg in segs:
        for (t0, t1, w) in (seg["words"] or []):
            tw = _tokens(w)
            asr_words.extend(tw)
            asr_times.extend([(t0, t1)] * len(tw))
    sm = SequenceMatcher(None, off_words, asr_words, autojunk=False)
    word_t = [None] * len(off_words)
    for a, b, size in sm.get_matching_blocks():
        for k in range(size):
            word_t[a + k] = asr_times[b + k]
    out = []
    for li, line in enumerate(official_lines):
        idxs = [i for i, o in enumerate(owner) if o == li]
        if not idxs:
            out.append(None)
            continue
        ts = [word_t[i] for i in idxs if word_t[i]]
        if len(ts) >= max(2, 0.4 * len(idxs)):
            out.append([round(min(t[0] for t in ts), 2), round(max(t[1] for t in ts), 2)])
        else:
            out.append(None)
    return out


def build_units(lines, line_times, min_dur=0.6):
    """整期逐字稿 → 听写/背诵块。无时间的行并入邻块；过短块并入前块。
    返回 [{t0,t1,li:[行号],lines:[{spk,text}],text}]。"""
    units = []
    for lix, (line, t) in enumerate(zip(lines, line_times)):
        if units and t is None:
            units[-1]["lines"].append({"spk": line["spk"], "text": line["text"]})
            units[-1]["li"].append(lix)
            units[-1]["text"] += " " + line["text"]
            continue
        if not units or t is not None:
            units.append({"t0": t[0] if t else None, "t1": t[1] if t else None,
                          "li": [lix], "lines": [{"spk": line["spk"], "text": line["text"]}], "text": line["text"]})
    # 过短块(时间上/词数上)并入前块
    merged = []
    for u in units:
        words = len(_tokens(u["text"]))
        dur = (u["t1"] - u["t0"]) if (u["t0"] is not None and u["t1"] is not None) else None
        if merged and u["t0"] is not None and (words < 2 or (dur is not None and dur < min_dur)):
            merged[-1]["lines"].extend(u["lines"])
            merged[-1]["li"].extend(u["li"])
            merged[-1]["text"] += " " + u["text"]
            merged[-1]["t1"] = u["t1"]
        else:
            merged.append(u)
    # 头部无时间块并入下一块
    if len(merged) > 1 and merged[0]["t0"] is None:
        merged[1]["lines"] = merged[0]["lines"] + merged[1]["lines"]
        merged[1]["li"] = merged[0]["li"] + merged[1]["li"]
        merged[1]["text"] = merged[0]["text"] + " " + merged[1]["text"]
        merged.pop(0)
    for u in merged:
        u["text"] = clean_text(u["text"])
    return merged


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


# ---------------- DeepSeek 翻译+意群（听写/背诵用, 与词块同一配置） ----------------
def _ai_call(cfg, system, user, max_tokens=8000):
    import urllib.request

    body = json.dumps({"model": cfg["model"], "temperature": 0.3, "max_tokens": max_tokens,
                       "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}).encode()
    req = urllib.request.Request(cfg["base"] + "/chat/completions", data=body,
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["key"]})
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = json.load(r)["choices"][0]["message"]["content"]
    raw = re.sub(r"^```(json)?|```$", "", raw.strip(), flags=re.M).strip()
    return json.loads(raw)


def ai_lang(data, batch=45):
    """全篇逐句: 中文翻译 + 意群拆分(尚雯婕法「意思单位」)。
    覆盖 对话(dg) + 讲解(pb) 全部行; 意群拼回必须逐词等于原句, 否则丢弃该句意群只留翻译。"""
    cfg = ai_cfg()
    if not cfg["key"]:
        raise SystemExit("缺 TFL_AI_KEY（.env.local）")
    sysmsg = "以材料本身为标准，只依据给定句子，不引入外部知识。只输出 JSON。"
    jobs = [("dg", [x["text"] for x in data["dialogue"]]), ("pb", [x["text"] for x in data["explanation"]])]
    data.setdefault("sense", {})
    for kind, lines in jobs:
        zh_out = [None] * len(lines)
        sense_out = [None] * len(lines)
        for start in range(0, len(lines), batch):
            seg = lines[start : start + batch]
            numbered = "\n".join(f"{i}. {t}" for i, t in enumerate(seg))
            prompt = f"""对下面 {len(seg)} 个英文句子逐句做两件事：
1. zh: 翻译成自然的中文。
2. sense: 按语法结构和逻辑把句子拆成 1~4 个「意群」（意思单位）记忆模块；每个意群给中文释义；所有意群按顺序拼接必须逐词等于原句（不改词序、不漏词、不加词）。
只输出 JSON：{{"zh":["句0翻译",...],"sense":[[{{"u":"意群原文","zh":"意群中文"}},...],...]}}，两个数组长度都必须等于 {len(seg)}。

句子：
{numbered}"""
            res = _ai_call(cfg, sysmsg, prompt)
            zh = res.get("zh") or []
            sense = res.get("sense") or []
            if len(zh) != len(seg) or len(sense) != len(seg):
                print(f"    !! {kind} 批 {start} 返回长度不符 zh={len(zh)} sense={len(sense)} 期望 {len(seg)}，该批丢弃")
                continue
            for k, line in enumerate(seg):
                z = clean_text(str(zh[k]))
                if z:
                    zh_out[start + k] = z
                units = sense[k] if isinstance(sense[k], list) else []
                buf, ok = [], True
                for un in units:
                    if not isinstance(un, dict):
                        ok = False
                        break
                    u = clean_text(str(un.get("u", "")))
                    if not u or u.lower() not in line.lower():
                        ok = False
                        break
                    buf.append({"u": u, "zh": clean_text(str(un.get("zh", "")))[:60]})
                if ok and buf and _tokens(" ".join(x["u"] for x in buf)) == _tokens(line):
                    sense_out[start + k] = buf
                elif buf:
                    print(f"    !! 意群拼回不符(丢弃): {line[:40]}…")
        data.setdefault("lineZh", {})[kind] = zh_out
        data["sense"][kind] = sense_out
        got_zh = sum(1 for x in zh_out if x)
        got_s = sum(1 for x in sense_out if x)
        print(f"    {kind}: 翻译 {got_zh}/{len(lines)} · 意群 {got_s}/{len(lines)}")


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


def update_catalog(ep_data, dur_pb, level_map):
    ep4 = str(ep_data["ep"]).zfill(4)
    epn = int(ep_data["ep"])
    off = level_map.get(epn)
    if off:
        if off["name"] != ep_data["level"]:
            print(f"    !! 分级交叉校验: 官方表={off['name']} vs PDF标题={ep_data['level']} (期 {epn}, 以官方表为准)")
        level = off["name"]
        rank = off["rank"]
    else:
        level, rank = ep_data["level"], 9   # 未收录兜底排最后
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
    lesson = {"id": f"eplod-{ep4}", "title": f"#{ep4} {ep_data['title']}", "level": level, "levelRank": rank,
              "channel": ep_data.get("channel") or "", "audio": audio_urls(ep4),
              "duration_sec": dur_pb, "ep": epn}
    c["lessons"] = [l for l in c["lessons"] if l["id"] != lesson["id"]] + [lesson]
    # 官方难度穿插: 目录按 级别 rank → 期号 排序
    c["lessons"].sort(key=lambda x: (x.get("levelRank", 9), x["ep"]))
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
    times = global_align(dia, segs_dg)
    hit = sum(1 for t in times if t)
    for i, t in enumerate(times):
        data["dialogue"][i]["t0"], data["dialogue"][i]["t1"] = (t if t else [None, None])
    print(f"    对话: {hit}/{len(dia)} 句有时间戳")
    if hit < len(dia) * 0.7:
        print("    !! 对话对齐率过低，先检查再继续", file=sys.stderr)

    segs_pb = whisper_segments(pb)
    expl_lines = [x["text"] for x in expl]
    times_pb = global_align(expl_lines, segs_pb)
    for i, t in enumerate(times_pb):
        expl[i]["t0"], expl[i]["t1"] = (t if t else [None, None])
    hit_pb = sum(1 for t in times_pb if t)
    print(f"    讲解: {hit_pb}/{len(expl_lines)} 行有时间戳（段 {len(segs_pb)}）")

    # 整期听写/背诵块（pb 全长时间轴）
    data["units"] = build_units(expl, times_pb)
    timed = sum(1 for u in data["units"] if u["t0"] is not None)
    print(f"    听写块: {len(data['units'])} 块（{timed} 块可独立播放）")

    data["explanation"] = expl
    data["audio"] = audio_urls(ep)
    data["durations"] = {"dg": ffprobe_sec(dg), "pb": ffprobe_sec(pb), "rv": ffprobe_sec(rv)}

    if not do_chunks:
        # 重跑解析/对齐时保留已生成的 AI 产物(词块+翻译+意群), 不重复花钱
        prev = BUILD_EP / f"{ep}.json"
        if prev.exists():
            try:
                old = json.loads(prev.read_text(encoding="utf-8"))
                for k in ("chunks", "sentencesZh", "lineZh", "sense"):
                    if old.get(k):
                        data[k] = old[k]
            except Exception:
                pass

    if do_chunks:
        print("[4] DeepSeek 词块/翻译/意群（只补缺失项）")
        if not data.get("chunks"):
            chunks = ai_chunks(data)
            print(f"    词块 {len(chunks)} 个（护栏后）")
            update_chunk_bank(data)
        else:
            print(f"    词块已有 {len(data['chunks'])} 个, 跳过")
        if not data.get("lineZh") or not data.get("sense"):
            ai_lang(data)
        else:
            print("    翻译+意群已有, 跳过")
        update_chunk_bank(data)

    if do_apply:
        print("[5] 拷贝音频 + 落盘")
        outd = AUDIO_LIB / ep
        outd.mkdir(parents=True, exist_ok=True)
        for f, name in ((dg, "dg.mp3"), (pb, "pb.mp3"), (rv, "rv.mp3")):
            shutil.copy2(f, outd / name)   # 归一文件名, 与 /media/eplod/<ep>/dg.mp3 对齐
        BUILD_EP.mkdir(parents=True, exist_ok=True)
        (BUILD_EP / f"{ep}.json").write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        update_catalog(data, data["durations"]["pb"], load_level_map())
        print(f"    音频 → {outd}")
        print(f"    课节 → {BUILD_EP / (ep + '.json')}")

    print(f"完成 {round(time.time()-t0,1)}s")


if __name__ == "__main__":
    main()
