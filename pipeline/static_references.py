"""Only source-derived references; no generated answers or audio boundary guesses."""
from __future__ import annotations
import re
import json
import hashlib
from pathlib import Path


def tokens(text):
    return re.findall(r"[a-z0-9]+(?:'[a-z0-9]+)*", str(text).lower().replace("’", "'").replace("‘", "'"))


def norm(text):
    return " ".join(tokens(text))


def sentence_fits(item, answer):
    """Can supplied chunks and fixed words assemble this exact source sentence?"""
    parts = re.split(r"_{3,}", item.get("response_slots", ""))
    bank = item.get("word_bank") or []
    if len(parts) < 2 or len(bank) < len(parts)-1:
        return False
    fixed = [tokens(x) for x in parts]
    target = tokens(answer)
    chunks = [tokens(x) for x in bank]
    if not all(chunks):
        return False
    if target[:len(fixed[0])] != fixed[0]:
        return False
    memo = set()
    def walk(slot, offset, used):
        if slot == len(parts)-1:
            return offset == len(target)
        key = slot, offset, used
        if key in memo:
            return False
        memo.add(key)
        seen = set()
        for i, chunk in enumerate(chunks):
            if used & (1 << i) or tuple(chunk) in seen:
                continue
            seen.add(tuple(chunk))
            combined = chunk + fixed[slot+1]
            if target[offset:offset+len(combined)] == combined and walk(slot+1, offset+len(combined), used | (1 << i)):
                return True
        return False
    return walk(0, len(fixed[0]), 0)


def selection_from_source(reading, text):
    """Keep original paragraphs, then expose their sentences as selection targets."""
    lines = text.splitlines()
    for module in reading.get("modules", []):
        for group in module.get("groups", []):
            for q in group.get("questions", []):
                match = re.search(r"Identify the sentence in paragraph (\d+)", q.get("stem", ""), re.I)
                if not match:
                    continue
                title = group.get("title", "")
                positions = [i for i, line in enumerate(lines) if norm(re.sub(r"^Academic Reading:\s*", "", line, flags=re.I)) == norm(title)]
                if len(positions) != 1:
                    continue
                paragraphs = []
                for line in lines[positions[0]+1:]:
                    if re.match(r"^\s*Q\d+[.:]", line):
                        break
                    if line.strip():
                        paragraphs.append(line.strip())
                index = int(match[1])-1
                if norm(" ".join(paragraphs)) != norm(group.get("passage", "")) or not 0 <= index < len(paragraphs):
                    continue
                sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z])", paragraphs[index])
                if not 2 <= len(sentences) <= 4:
                    continue
                group["passage_paragraphs"] = paragraphs
                q["options"] = dict(zip("ABCD", sentences))
                q["interaction"] = "sentence_select"
                q["selection_paragraph"] = index+1


def numbered(block):
    pairs = re.findall(r"^\s*(?:Q)?(\d+)[.:]\s*(.+?)(?=^\s*(?:Q)?\d+[.:]|\Z)", block, re.M | re.S)
    return {int(no): value.strip() for no, value in pairs}


def sentence_answers(text):
    explicit = re.findall(r"^Sentence Construction Q(\d+):\s*(.+)$", text, re.M | re.I)
    if explicit:
        return {int(n): a.strip() for n, a in explicit}
    match = re.search(r"^Sentence Construction(?: Answers)?\s*$", text, re.M | re.I)
    if not match:
        return {}
    block = re.split(r"^(?:Write an Email|Email |Write for an Academic|Academic Discussion|Speaking Answers)", text[match.end():], maxsplit=1, flags=re.M | re.I)[0]
    return numbered(block)


def listening_refs(text):
    match = re.search(r"^Listening Transcript[^\n]*", text, re.M | re.I)
    if not match:
        return {}
    block = re.split(r"^(?:Writing Answers|Speaking Answers|Sentence Construction)", text[match.end():], maxsplit=1, flags=re.M | re.I)[0]
    heads = list(re.finditer(r"^(?:Listening )?Module\s+(\d+)[^\n]*", block, re.M | re.I))
    out = {}
    for i, h in enumerate(heads):
        title = h.group().strip()
        body = block[h.end():heads[i+1].start() if i+1<len(heads) else len(block)].strip()
        module = int(h[1])
        if re.search(r"Choose the Best Response", title, re.I):
            for no, value in numbered(body).items():
                out[(module,no)] = {"title": "原资料听力文字稿 · Module %s Q%s" % (module,no), "text": value}
        else:
            ran = re.search(r"Q(\d+)\s*[-–]\s*Q?(\d+)", title)
            if ran and body:
                for no in range(int(ran[1]),int(ran[2])+1):
                    out[(module,no)] = {"title": "原资料听力文字稿 · " + title, "text": body}
    return out


def enrich_references(rec, sources=None, source_files=None):
    """Attach trusted references and audit excluded source answers."""
    texts = list(dict.fromkeys(str(t) for t in rec.get("answer_texts", {}).values() if str(t).strip()))
    text = "\n".join(texts)
    source = "、".join(sources or []) or "本套原答案资料"
    audit = {"sentence_graded": [], "sentence_reference_only": [], "sentence_missing": [], "listening_linked": 0}
    answers = sentence_answers(text)
    image_index = Path(__file__).with_name("static-image-references.json")
    image_reference = json.loads(image_index.read_text(encoding="utf-8")).get(rec.get("set_id"), {}) if image_index.exists() else {}
    # Image transcriptions are frozen to the verified original file, not future similarly named material.
    if image_reference and not any(Path(p).is_file() and hashlib.sha256(Path(p).read_bytes()).hexdigest() == image_reference.get("source_sha256") for p in (source_files or [])):
        image_reference = {}
    image_answers = {int(k): v for k, v in image_reference.get("sentence_answers", {}).items()}
    for no, answer in image_answers.items():
        if no not in answers:
            answers[no] = answer
    for task in rec.get("subjects", {}).get("writing", {}).get("tasks", []):
        if task.get("type") != "sentence_construction":
            continue
        for item in (task.get("items") or task.get("sentences") or []):
            item.pop("reference_answer", None)
            item.pop("reference_verified", None)
            answer = answers.get(item.get("no"))
            if not answer:
                audit["sentence_missing"].append(item.get("no"))
                continue
            item["reference_answer"] = answer
            item["reference_source"] = image_reference["source"] if item.get("no") in image_answers else source
            item["reference_verified"] = sentence_fits(item, answer)
            audit["sentence_graded" if item["reference_verified"] else "sentence_reference_only"].append(item.get("no"))
    refs = listening_refs(text)
    for module in rec.get("subjects", {}).get("listening", {}).get("modules", []):
        for group in module.get("groups", []):
            for q in group.get("questions", []):
                ref = refs.get((module.get("module"),q.get("no")))
                if ref:
                    q["source_reference"] = dict(ref, source=source)
                    audit["listening_linked"] += 1
    # Restore whole-sentence keys only when they exactly match a selectable source sentence.
    for module in rec.get("subjects", {}).get("reading", {}).get("modules", []):
        for group in module.get("groups", []):
            for q in group.get("questions", []):
                if q.get("interaction") != "sentence_select":
                    continue
                amk = "module"+str(module["module"])
                # The module-labelled original key must explicitly contain this question number.
                candidates = []
                for line in text.splitlines():
                    if re.search(r"Reading Module\s+"+str(module["module"])+r"\b",line,re.I):
                        for no, value in re.findall(r"Q(\d+)\s+(.+?)(?=;\s*Q\d+|$)",line):
                            if int(no)==q["no"] and any(norm(value)==norm(v) for v in q["options"].values()):
                                candidates.append(value.strip())
                if len(set(candidates)) == 1:
                    bucket = rec.setdefault("answers",{}).setdefault("reading",{}).setdefault(amk,[])
                    bucket[:] = [a for a in bucket if a.get("q")!=q["no"]]
                    bucket.append({"q":q["no"],"a":candidates[0],"kind":"choice"})
    rec["static_reference_audit"] = audit
    return audit
