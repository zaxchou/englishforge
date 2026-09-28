#!/usr/bin/env python3
"""从真实语料构造题目 —— 「即时生成下一课」里不需要模型的那一半。

原则（用来消除「凭空想象」）：
  · 正确选项 **永远是真实语料原句**，带 sourceId，可追溯、可署名。
  · 干扰项优先级：① 真实语料的**镜像句**（角色互换——正是中文母语者的典型错误）
    ② 对真实句框架的**最小违反**（换错格），自动带错因标签。
  · 每道题都记录每个选项的来源（attested / attested-mirror / constructed），可审计。

输出 out/items-<objective>.json，每条都是 draft，等人工/模型润色解析文案后再生效。

用法：python scripts/build-items.py [--corpus DIR] [--limit N]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from pathlib import Path

NOISE = re.compile(r'[0-9"“”«»()\[\]{}@#*_/\\…—–]|://')
WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")
SUBJ2OBJ = {'i': 'me', 'he': 'him', 'she': 'her', 'we': 'us', 'they': 'them', 'you': 'you'}
OBJ2SUBJ = {v: k for k, v in SUBJ2OBJ.items()}
PRON_PAT = re.compile(r'^(I|He|She|We|They|You)\s+([A-Za-z]+)\s+(me|him|her|us|them|you)\b(.*)$')
FUNC = {'in', 'on', 'at', 'to', 'with', 'for', 'from', 'of'}


def norm(t: str) -> str:
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z ]+', ' ', t.lower())).strip()


def clean(text: str, max_tokens: int = 8) -> bool:
    if NOISE.search(text):
        return False
    t = WORD.findall(text)
    return 2 <= len(t) <= max_tokens and all(not w[0].isupper() for w in t[1:])


def match_case(src_word: str, repl: str) -> str:
    # 英语里 I 永远大写，哪怕在句中被换成小写形式
    if repl == 'i':
        return 'I'
    return repl.capitalize() if src_word[:1].isupper() else repl


# 代词范式：宾语形式 → 三个干扰项（主格 / 物主 / 反身，均与该宾语形式不同形）。
# her 的形容词性物主与宾格同形，所以这里用 ones 类物主 hers，避免选项撞车。
PARADIGM = {
    'me': ('I', 'my', 'myself'),
    'him': ('he', 'his', 'himself'),
    'her': ('she', 'hers', 'herself'),
    'us': ('we', 'our', 'ourselves'),
    'them': ('they', 'their', 'themselves'),
    'you': ('your', 'yourself', 'yourselves'),
}

# 不规则/助动词不做"词元↔三单"推导（is/has/does 会被误当成某词元的三单形式）
IRREGULAR = {'is', 'has', 'does', 'was', 'were', 'be', 'been', 'can', 'could',
             'will', 'would', 'should', 'must', 'may', 'might'}


def expected_third(lemma: str) -> str:
    """词元 → 第三人称单数形式。"""
    if lemma.endswith(('s', 'x', 'z', 'ch', 'sh', 'o')):
        return lemma + 'es'
    if len(lemma) > 1 and lemma.endswith('y') and lemma[-2] not in 'aeiou':
        return lemma[:-1] + 'ies'
    return lemma + 's'


def base_of_third(verb: str) -> str | None:
    """第三人称形式 → 词元；靠 expected_third(base) == verb 自校验，变形错的返回 None。

    这一步是必需的：只按词尾判断会把 "miss" 当成三单形式（它本身就以 s 结尾），
    于是 "He miss me." 这种不合法英语会被放行——实测就是这样漏进来的。
    """
    cands: list[str] = []
    if verb.endswith('ies') and len(verb) > 3:
        cands.append(verb[:-3] + 'y')
    if verb.endswith('es') and len(verb) > 2:
        cands.append(verb[:-2])
    if verb.endswith('s'):
        cands.append(verb[:-1])
    for c in cands:
        if c and expected_third(c) == verb:
            return c
    return None


def build_pairs(eng: dict[int, str]):
    """按**词元**配对，而不是按动词字符串配对。

    返回 [(sid_a, text_a, sid_b, text_b, lemma, subj, obj, True)]，A/B 互为镜像。
    旧实现要求两侧动词字符串相同，于是 "I miss him." 只能配上 "He miss me."（错误变形）；
    正确的 "He misses me." 因为动词是 misses 而永远配不上。改为按词元配对后，
    两侧的变形都由 expected_third 校验，不合法的句子根本进不来。
    """
    base_idx: dict[tuple, tuple] = {}
    third_idx: dict[tuple, tuple] = {}
    for sid, text in eng.items():
        m = PRON_PAT.match(text.strip())
        if not m or not clean(text):
            continue
        subj, verb, obj, rest = m.group(1).lower(), m.group(2).lower(), m.group(3), m.group(4)
        if subj == obj == 'you' or OBJ2SUBJ.get(obj) == subj or verb in FUNC or verb in IRREGULAR:
            continue
        key_rest = norm(rest)
        # 只有 her 与物主限定词同形（her invitation）。him/us/them/me 后面跟名词
        # 不可能构成物主，所以这条限制只对 her 生效，别把其余句子的产出也砍掉。
        if obj == 'her' and key_rest:
            continue
        if subj in ('he', 'she'):
            lemma = base_of_third(verb)
            if not lemma:
                continue                        # 变形不合规（含 He miss），直接丢弃
            third_idx[(lemma, key_rest, subj, obj)] = (sid, text.strip())
        else:
            base_idx[(verb, key_rest, subj, obj)] = (sid, text.strip())

    out = []
    for (lemma, rest, subj, obj), a in sorted(base_idx.items()):
        b = third_idx.get((lemma, rest, OBJ2SUBJ[obj], SUBJ2OBJ[subj]))
        # b 可以为 None：镜像句允许由真实句机械构造（见 main），不必在语料里存在
        out.append((a[0], a[1], b[0] if b else None, b[1] if b else None,
                    lemma, subj, obj, True))
    return out



# ---------------- 其余知识点：检索层同样覆盖 ----------------

PRON_FORMS = (r"(?:I|me|my|mine|myself|he|him|his|himself|she|her|hers|herself"
              r"|we|us|our|ours|ourselves|they|them|their|theirs|themselves"
              r"|you|your|yours|yourself|yourselves|it|its|itself)")
FRAME_MASK = re.compile(r'\b' + PRON_FORMS + r'\b', re.I)


def read_conllu_texts(folder: Path) -> list[str]:
    out = []
    for f in sorted(folder.glob('*.conllu')):
        for line in f.open(encoding='utf-8'):
            if line.startswith('# text ='):
                out.append(line[9:].strip())
    return out


def build_s3_possessive(root: Path, limit: int) -> list[dict]:
    """s3 my/mine 等物主代词：用 UD_English-Pronouns 的交替框架（CC BY-SA 4.0）。

    该树库专为代词交替而造：同一句框架下换代词，例如 `_ is _` →
    It is hers. / It is his. / It is mine. / It is theirs. / It is yours.
    整组互为选项、每句各作一次答案 —— 参考句全部真实，且是唯一一个许可干净的高质来源。
    """
    texts = read_conllu_texts(root / 'ud' / 'UD_English-Pronouns-master')
    groups: dict[str, list[str]] = defaultdict(list)
    for t in texts:
        groups[FRAME_MASK.sub('_', t.lower()).strip(' .!?')].append(t)
    items: list[dict] = []
    for frame, members in sorted(groups.items()):
        members = sorted(set(members))
        if not 3 <= len(members) <= 5:
            continue
        for ans in members:
            items.append({
                'objectiveId': 's3', 'skill': 's3', 'type': 'choice', 'kind': 'meaning',
                'prompt': '', 'promptNeedsGloss': True,
                'options': list(members), 'answer': ans, 'tts': ans, 'explain': '',
                'variantGroupId': f'poss:{frame[:40]}',
                'optionOrigin': {m: 'attested' for m in members},
                'errorTags': {},
                'sourceId': {'cluster': 'ud-en-pronouns', 'frame': frame},
                'reviewStatus': 'draft',
            })
    return items[:limit] if limit else items


BASE_PAT = re.compile(r'^(I|You|We|They)\s+([a-z]+)\s+(.*)$')
THIRD_PAT = re.compile(r'^(He|She)\s+([a-z]+s)\s+(.*)$')


def build_s4_third_person(eng: dict[int, str], limit: int) -> list[dict]:
    """s4 三单：同一动词同一宾语下 `I like apples.` ⇄ `He likes apples.` 的真实对立。"""
    base: dict[tuple, dict] = defaultdict(dict)
    third: dict[tuple, dict] = defaultdict(dict)
    for sid, text in eng.items():
        if not clean(text):
            continue
        t = text.strip()
        m = BASE_PAT.match(t)
        if m:
            base[(m.group(2), norm(m.group(3)))][m.group(1).lower()] = (sid, t)
            continue
        m = THIRD_PAT.match(t)
        if m and len(m.group(2)) > 2:
            third[(m.group(2)[:-1], norm(m.group(3)))][m.group(1).lower()] = (sid, t)

    items: list[dict] = []
    for key in sorted(set(base) & set(third)):
        verb, _rest = key
        b = sorted(base[key].items())[0][1]
        h = sorted(third[key].items())[0][1]
        if b[1] == h[1]:
            continue
        bad_third = re.sub(rf'\b{verb}s\b', verb, h[1], count=1)      # He like apples.
        bad_base = re.sub(rf'\b{verb}\b', verb + 's', b[1], count=1)  # I likes apples.
        if bad_third == h[1] or bad_base == b[1]:
            continue
        for ans, other, sid in ((h[1], b[1], h[0]), (b[1], h[1], b[0])):
            items.append({
                'objectiveId': 's4', 'skill': 's4', 'type': 'choice', 'kind': 'meaning',
                'prompt': '', 'promptNeedsGloss': True,
                'options': [ans, other, bad_third, bad_base], 'answer': ans, 'tts': ans,
                'explain': '', 'variantGroupId': f'third:{verb}:{norm(other)[:24]}',
                'optionOrigin': {ans: 'attested', other: 'attested', bad_third: 'constructed',
                                 bad_base: 'constructed'},
                'errorTags': {bad_third: ['verb-form-third'], bad_base: ['verb-form-base']},
                'sourceId': {ans: f'tatoeba:{sid}'},
                'reviewStatus': 'draft',
            })
    return items[:limit] if limit else items


# ---- s3 v2：物主代词（my book / mine），用 Tatoeba 真实句 ----
# 为什么换掉 UD_English-Pronouns：它是语言学测试句集（Hers accelerated.），
# 模型判 24/40"结构合法但不像人话"。许可干净 ≠ 可用于教学，必须换真实语料。
POSS_DET = {'my': 'mine', 'your': 'yours', 'his': 'his', 'her': 'hers',
            'our': 'ours', 'their': 'theirs'}
POSS_PRON = {v: k for k, v in POSS_DET.items()}
DET_SENT = re.compile(r'^(It|This|That|These|Those)\s+(is|are)\s+'
                      r'(my|your|his|her|our|their)\s+([A-Za-z]+)$', re.I)
PRON_SENT = re.compile(r'^(It|This|That|These|Those)\s+(is|are)\s+'
                       r'(mine|yours|his|hers|ours|theirs)$', re.I)


def build_s3_possessive_v2(eng: dict[int, str], limit: int) -> list[dict]:
    """`This is my book.` ⇄ `This is mine.` —— 同一句框架、同一人称，只差"名词在不在"。
    这正是张老师讲的：my + 名词 / mine = my + 上文说过的东西。

    限定词版必须来自 Tatoeba 真实句；代词版先找真实句，找不到就由该真实句机械改造
    （只把 "my book" 换成 "mine"），并在 optionOrigin 里如实标注 transformed。
    两个干扰项就是这组对立本身的典型错误：代词带名词（mine book）、限定词悬空（my.）。
    注意 his 被排除：它限定词与代词同形，这组对立不成立（是另一个教学点）。
    """
    det: dict[tuple, tuple] = {}
    pron: set[tuple] = set()
    for sid, text in eng.items():
        if NOISE.search(text) or not (2 <= len(WORD.findall(text)) <= 7):
            continue
        body = text.strip().rstrip('.!?').strip()
        m = DET_SENT.match(text.strip().rstrip('.!?').strip())
        if m:
            det[(m.group(1).lower(), m.group(2).lower(), m.group(3).lower())] = \
                (sid, body, m.group(4).lower())
            continue
        m = PRON_SENT.match(body)
        if m:
            pron.add((m.group(1).lower(), m.group(2).lower(), m.group(3).lower()))

    items: list[dict] = []
    for key, (sid_d, body_d, noun) in sorted(det.items()):
        person = key[2]
        if person == 'his':
            continue
        pron_word = POSS_DET[person]
        pron_key = (key[0], key[1], pron_word)
        attested = pron_key in pron
        body_p = re.sub(rf'\b{person}\s+{noun}\b', pron_word, body_d, count=1)
        if body_p == body_d:
            continue
        # 典型错误：代词带名词 / 限定词悬空
        err_pron_noun = body_p.replace(pron_word, f'{pron_word} {noun}', 1)
        err_det_alone = body_d.replace(f'{person} {noun}', person, 1)
        if len({body_d, body_p, err_pron_noun, err_det_alone}) != 4:
            continue
        p_origin = 'attested' if attested else 'transformed'
        for ans, other, a_origin, o_origin in (
                (body_d + '.', body_p + '.', 'attested', p_origin),
                (body_p + '.', body_d + '.', p_origin, 'attested')):
            items.append({
                'objectiveId': 's3', 'skill': 's3', 'type': 'choice', 'kind': 'meaning',
                'prompt': '', 'promptNeedsGloss': True,
                'options': [ans, other, err_pron_noun + '.', err_det_alone + '.'],
                'answer': ans, 'tts': ans, 'explain': '',
                'variantGroupId': f'poss:{key[0]}:{key[1]}:{person}:{noun}',
                'optionOrigin': {ans: a_origin, other: o_origin,
                                 err_pron_noun + '.': 'constructed',
                                 err_det_alone + '.': 'constructed'},
                'errorTags': {err_pron_noun + '.': ['pron-before-noun'],
                              err_det_alone + '.': ['det-without-noun']},
                'sourceId': {ans: f'tatoeba:{sid_d}'},
                'reviewStatus': 'draft',
            })
    return items[:limit] if limit else items


# ---- s2 结构化来源：UD_English-EWT（CC BY-SA 4.0）----
# 为什么要换成有标注的语料：Tatoeba 只有文本，判断不了动词是原形还是过去式、
# her 是宾格还是物主限定词（实测产出过 "She accepteds me invitation."）。
# EWT 给了 lemma / Tense / deprel，镜像句的变形因此可以被**证明**而不是猜。
NOMINATIVE = {'I', 'he', 'she', 'we', 'they', 'you', 'it'}
ACCUSATIVE = {'me', 'him', 'her', 'us', 'them', 'you', 'it'}
# 全部用小写做键：EWT 里 "I" 会被 lower() 成 "i"，映射必须一致，否则静默 KeyError。
# 大小写单独用 _cap() 处理（英语里 I 永远大写）。
SUBJ_OF_OBJ = {'me': 'i', 'him': 'he', 'her': 'she', 'us': 'we', 'them': 'they',
               'you': 'you', 'it': 'it'}
OBJ_OF_SUBJ = {v: k for k, v in SUBJ_OF_OBJ.items()}


def _cap(w: str, initial: bool = False) -> str:
    """i → I；句首词首字母大写。"""
    if w == 'i':
        return 'I'
    return w.capitalize() if initial else w


def read_conllu_sentences(folder: Path) -> list[tuple[str, str, list[dict]]]:
    """读 CoNLL-U：返回 [(sent_id, text, tokens)]，token 只留用得到的列。"""
    out: list[tuple[str, str, list[dict]]] = []
    for f in sorted(folder.glob('*.conllu')):
        sid, text, cur = '', None, []
        for line in f.open(encoding='utf-8'):
            line = line.rstrip('\n')
            if line.startswith('# sent_id ='):
                sid = line.split('=', 1)[1].strip()
                continue
            if line.startswith('# text ='):
                text, cur = line.split('=', 1)[1].strip(), []
                continue
            if not line:
                if cur and text:
                    out.append((sid, text, cur))
                text, cur = None, []
                continue
            if line.startswith('#'):
                continue
            c = line.split('\t')
            if len(c) >= 8 and '-' not in c[0] and '.' not in c[0]:
                cur.append({'id': c[0], 'form': c[1], 'lemma': c[2], 'upos': c[3],
                            'feats': c[5], 'head': c[6], 'deprel': c[7]})
        if cur and text:
            out.append((sid, text, cur))
    return out


def build_s2_from_ewt(folder: Path, limit: int) -> list[dict]:
    """主格/宾格：用带标注的真实句 + 可证明的镜像句。

    只收"主语在句首、宾语代词是最后一个词、现在时主动语态"的简短陈述句。
    这样镜像句只需替换三个位置，动词按 lemma + expected_third 变形 —— 正确性由
    词元与时态标注保证。答案始终是**真实句**；镜像句标为 constructed-provable。
    """
    items: list[dict] = []
    seen_sig: set[tuple] = set()
    for sid, text, toks in read_conllu_sentences(folder):
        body = text.strip()
        if NOISE.search(body):
            continue
        np = [t for t in toks if t['upos'] != 'PUNCT']
        if not (4 <= len(np) <= 9):
            continue
        # 非标点词按单空格拼接必须能还原原文，否则重建镜像会改坏原句
        if ' '.join(t['form'] for t in np).lower() != re.sub(r'[^A-Za-z ]', '', body).strip().lower():
            continue
        root = next((t for t in toks if t['deprel'] == 'root'), None)
        # 注意 EWT 的动词 FEATS 是 Mood/Number/Person/Tense/VerbForm，**没有 Voice=Act**。
        # 想排除被动只能查 Voice=Pass 是否存在；祈使句没有主语，也要排掉。
        if not root or root['upos'] != 'VERB' or 'VerbForm=Fin' not in root['feats'] \
                or 'Tense=Pres' not in root['feats'] or 'Mood=Ind' not in root['feats'] \
                or 'Voice=Pass' in root['feats']:
            continue
        kids = [t for t in toks if t['head'] == root['id']]
        subj = next((t for t in kids if t['deprel'] == 'nsubj' and t['upos'] == 'PRON'), None)
        obj = next((t for t in kids if t['deprel'] == 'obj' and t['upos'] == 'PRON'), None)
        if not subj or not obj:
            continue
        if subj['form'] not in NOMINATIVE or obj['form'] not in ACCUSATIVE:
            continue

        forms = [t['form'] for t in np]
        vi = [i for i, t in enumerate(np) if t['id'] == root['id']][0]
        si = [i for i, t in enumerate(np) if t['id'] == subj['id']][0]
        oi = [i for i, t in enumerate(np) if t['id'] == obj['id']][0]
        m_subj = SUBJ_OF_OBJ[obj['form'].lower()]
        m_obj = OBJ_OF_SUBJ[subj['form'].lower()]
        m_verb = expected_third(root['lemma'].lower()) if m_subj in ('he', 'she', 'it') \
            else root['lemma'].lower()
        text_a = body
        # 按 token 位置原地下标替换：上面的还原性校验保证重建不会改坏原句，
        # 所以不必强求"主语在句首、宾语在句末"（那条限制把产量压到个位数）。
        mirror_forms = list(forms)
        mirror_forms[si] = _cap(m_subj, initial=(si == 0))
        mirror_forms[vi] = m_verb
        mirror_forms[oi] = _cap(m_obj, initial=(oi == 0))
        mirror = ' '.join(mirror_forms) + '.'
        bad_forms = list(forms)
        bad_forms[si] = _cap(OBJ_OF_SUBJ[subj['form'].lower()], initial=(si == 0))
        bad_subj = ' '.join(bad_forms) + '.'
        bad_forms = list(forms)
        bad_forms[oi] = _cap(SUBJ_OF_OBJ[obj['form'].lower()], initial=(oi == 0))
        bad_obj = ' '.join(bad_forms) + '.'

        if len({text_a, mirror, bad_subj, bad_obj}) != 4:
            continue
        sig = (mirror, tuple(sorted({text_a, mirror, bad_subj, bad_obj})))
        if sig in seen_sig:
            continue                        # EWT 里有重复句，会产出完全相同的题
        seen_sig.add(sig)
        vid = f"{root['lemma'].lower()}:{subj['form'].lower()}-{obj['form'].lower()}"
        source = f'ud-en-ewt:{sid}'
        items.append({
            'objectiveId': 's2', 'skill': 's2', 'type': 'choice', 'kind': 'meaning',
            'prompt': '', 'promptNeedsGloss': True,
            'options': [text_a, mirror, bad_subj, bad_obj], 'answer': text_a,
            'tts': text_a, 'explain': '',
            'variantGroupId': vid,
            'optionOrigin': {text_a: 'attested', mirror: 'constructed-provable',
                             bad_subj: 'constructed', bad_obj: 'constructed'},
            'errorTags': {mirror: ['role-reversed'], bad_subj: ['case-form-subject'],
                          bad_obj: ['case-form-object']},
            'sourceId': {'answer': source}, 'reviewStatus': 'draft',
        })
        frame_opts = [obj['form'], *PARADIGM.get(obj['form'].lower(), ())]
        if len(set(frame_opts)) == 4:
            items.append({
                'objectiveId': 's2', 'skill': 's2', 'type': 'choice', 'kind': 'frame',
                'sentence': text_a,
                'prompt': ' '.join(forms[:oi] + ['___'] + forms[oi + 1:]) + '.',
                'options': frame_opts, 'answer': obj['form'], 'tts': text_a, 'explain': '',
                'variantGroupId': vid,
                'optionOrigin': {obj['form']: 'attested', 'frame': source},
                'errorTags': {}, 'sourceId': {'frame': source}, 'reviewStatus': 'draft',
            })
    return items[:limit] if limit else items


def write_items(path: Path, items: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'    → {path}  ({len(items)} 题)')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=str(Path(__file__).resolve().parents[2] / 'corpus'))
    ap.add_argument('--limit', type=int, default=400)
    ap.add_argument('--out', default='out/items-pronoun-case.json')
    args = ap.parse_args()
    root = Path(args.corpus)

    eng: dict[int, str] = {}
    with (root / 'tatoeba' / 'eng_sentences.tsv').open(encoding='utf-8', newline='') as f:
        for row in csv.reader(f, delimiter='\t'):
            if len(row) >= 3 and row[1] == 'eng':
                eng[int(row[0])] = row[2]
    print(f'Tatoeba 英文: {len(eng):,} 句')

    pairs = build_pairs(eng)
    print(f'代词格最小对立对: {len(pairs)}')

    # 只为候选句拉中文翻译：流式扫 links.csv，只留命中的 id
    want = {sid for p in pairs for sid in (p[0], p[2])}
    tr: dict[int, set[int]] = defaultdict(set)
    with (root / 'tatoeba' / 'links.csv').open(encoding='utf-8', newline='') as f:
        for row in csv.reader(f, delimiter='\t'):
            if len(row) < 2:
                continue
            try:
                a, b = int(row[0]), int(row[1])
            except ValueError:
                continue
            if a in want:
                tr[a].add(b)
            elif b in want:
                tr[b].add(a)
    cmn_ids = {i for ids in tr.values() for i in ids}
    zh: dict[int, str] = {}
    with (root / 'tatoeba' / 'cmn_sentences.tsv').open(encoding='utf-8', newline='') as f:
        for row in csv.reader(f, delimiter='\t'):
            if len(row) >= 3 and row[1] == 'cmn' and int(row[0]) in cmn_ids:
                zh[int(row[0])] = row[2]
    print(f'候选句中有中文翻译的: {sum(1 for s in want if any(i in zh for i in tr.get(s, ())))}')

    def zh_of(sid: int) -> str | None:
        for i in sorted(tr.get(sid, ())):
            if i in zh:
                return zh[i]
        return None

    items, with_zh = [], 0
    usable = [p for p in pairs if p[3] is not None]
    print(f'  按词元配对 {len(pairs)} 组，其中有真实镜像句（可成题）{len(usable)} 组')
    # 必须在切片之前过滤：pairs 里大量条目没有镜像句，先切片会把它筛得几乎为空
    for sid_a, text_a, sid_b, text_b, verb, subj, obj, _ok in usable[: args.limit]:
        # 用正则捕获的原始词形来做替换：按空格切分会被 "him," 这类标点带崩
        m = PRON_PAT.match(text_a)
        if not m:
            continue
        subj_w, obj_w = m.group(1), m.group(3)
        # 镜像句必须在语料里真实存在。曾试过"由真实句机械构造镜像"，产出
        # "She accepteds me invitation." 这类错句：Tatoeba 只有文本、没有词元与句法，
        # 判断不了动词是原形还是过去式、her 是宾格还是物主限定词。结构判断交给有标注
        # 的语料（EWT），这里只接受被证实存在的镜像。
        if text_b is None:
            continue
        b_origin = 'attested-mirror'
        bad_subj = text_a.replace(subj_w, match_case(subj_w, SUBJ2OBJ[subj_w.lower()]), 1)
        bad_obj = text_a.replace(obj_w, match_case(obj_w, OBJ2SUBJ[obj_w.lower()]), 1)
        # 选项必须四个互不相同：you 的宾格与主格同形，会与答案撞车，这类直接跳过
        if len({text_a, text_b, bad_subj, bad_obj}) != 4:
            continue
        vid = f'{verb}:{subj}-{obj}'
        gloss = zh_of(sid_a)

        if gloss:
            with_zh += 1
            items.append({
                'objectiveId': 's2', 'skill': 's2', 'type': 'choice', 'kind': 'meaning',
                'prompt': f'「{gloss}」',
                'options': [text_a, text_b, bad_subj, bad_obj],
                'answer': text_a,
                'tts': text_a,
                'explain': f'做动作的是 {subj_w}（主体·主格），挨动作的是 {obj_w}（对象·宾格）；含义不同，形式就得不同。',
                'variantGroupId': vid,
                'optionOrigin': {text_a: 'attested', text_b: b_origin,
                                 bad_subj: 'constructed', bad_obj: 'constructed'},
                'errorTags': {text_b: ['role-reversed'], bad_subj: ['case-form-subject'],
                              bad_obj: ['case-form-object']},
                'sourceId': {**{'answer': f'tatoeba:{sid_a}'},
                             **({'mirror': f'tatoeba:{sid_b}'} if sid_b else {})},
                'reviewStatus': 'draft',
            })

        frame_opts = [obj_w, *PARADIGM.get(obj_w.lower(), ())]
        if len(set(frame_opts)) != 4:
            continue
        items.append({
            'objectiveId': 's2', 'skill': 's2', 'type': 'choice', 'kind': 'frame',
            'sentence': text_a,
            'prompt': text_a.replace(obj_w, '___', 1),
            # 干扰项用代词范式（him/he/his/himself），不是 hims/is 这类造词
            'options': frame_opts,
            'answer': obj_w,
            'tts': text_a,
            'explain': f'这里要"挨动作的那个"，用宾格 {obj_w}。',
            'variantGroupId': vid, 'optionOrigin': {'answer': 'attested', 'frame': f'tatoeba:{sid_a}'},
            'errorTags': {}, 'sourceId': {'frame': f'tatoeba:{sid_a}'}, 'reviewStatus': 'draft',
        })

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'\n写出 s2 主格/宾格 {len(items)} 题（其中 {with_zh} 题带中文意思）→ {out}')
    print('s2 结构化来源（UD_English-EWT，镜像句由词元+时态推导，正确性可证明）：')
    write_items(Path('out/items-s2-case-ewt.json'),
                build_s2_from_ewt(root / 'ud' / 'UD_English-EWT-master', args.limit))
    print('s3 物主代词（Tatoeba 真实 my+名词 / mine 对立）：')
    write_items(Path('out/items-s3-possessive.json'), build_s3_possessive_v2(eng, args.limit))
    print('s4 三单（Tatoeba 真实对立）：')
    write_items(Path('out/items-s4-thirdperson.json'), build_s4_third_person(eng, args.limit))
    print('\n=== 样例 ===')
    for it in items[:3]:
        print(json.dumps(it, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
