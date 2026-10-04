#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
挖空分析 (blanks)

托福阅读填空题的每一个空都是**强约束**, 丢一个字符答案就废了:

    "Large-scale los _ _ _ of spe _ _ _ _ are of _ _ _ caused b _ ..."
     线索 los   3格      线索 spe   4格      线索 of   3格   线索 b  1格

关键认知 (实测 6-22 校对出来的): **下划线格数不等于答案词数, 而是答案的字母数。**

    los _ _ _      -> losses     1 词 / 6 字母 / 3 格
    spe _ _ _ _    -> species    1 词 / 7 字母 / 4 格
    of  _ _ _      -> often      1 词 / 5 字母 / 3 格
    b   _          -> by         1 词 / 2 字母 / 1 格
    cli _ _ _ _    -> climate    1 词 / 7 字母 / 4 格
    erup _ _ _ _ _ -> eruptions  1 词 / 9 字母 / 5 格

即每格约 2 个字母。所以"格数 == 词数"的假设会把绝大多数答案判成不匹配。
这正是为什么之前自动填词一个都填不进去。

另外, **线索字母 + 格数能反过来校验答案**: 把答案去掉线索部分后,
剩余字母数应与格数大致吻合 (每格约 2 字母), 可以用来筛掉错位。

所以这里把每个空解析成 {no, clue, blanks} 的结构化记录:
  - blanks 原样保留 (字符位提示, 是命题人给的做题线索, 不能失真)
  - clue  原样保留
  - 填词时以 **clue 能拼出答案首词** 为主判据, 格数只做宽松校验
"""

from __future__ import annotations
import re

# 一段挖空: 紧邻的字母线索 + 若干下划线
# 例: "los _ _ _ of"  -> pref="los", underscores=3
#
# 三个坑:
#  1. pref 必须**贪婪**。用 {0,12}? 惰性会只吃 0 个字符, 线索全丢,
#     无法校验答案, 也就无法自动填回。
#  2. 线索与下划线之间有空格 ("los _ _ _"), 所以 pref 后面要允许 [ \t]。
#     漏了这个空格会把 "los _ _ _" 只数成 2 个空。
#  3. pref 不能吞掉上一个单词的尾巴: "mass _ _ _" 里 pref 应为空。
#     用反向排除 (?<![A-Za-z]) 保证它只能从词首开始。
RE_BLANK = re.compile(
    r"(?P<pref>(?<![A-Za-z])[A-Za-z]{0,12})[ \t]*"
    r"(?P<us>_(?:[ \t]*_)*)"
    r"(?![A-Za-z_])")

# 无下划线的裸线索 (如 "T _ _ resulting" -> T + 2空, pref='T')
def parse_blanks(passage: str) -> list[dict]:
    """
    抽出段落里所有挖空, 按出现顺序编号 (1-based, 对应官方 Q 序号)。

    返回 [{no, clue, blanks, prefix_len}]
      clue   下划线前的字母线索 (可能为空)
      blanks 下划线格数 —— 命题人给的字符位提示, **原样保留不修正**
    """
    out: list[dict] = []
    if not passage:
        return out
    for m in RE_BLANK.finditer(passage):
        pref = m.group("pref")
        n = m.group("us").count("_")
        if n == 0:
            continue
        out.append({
            "no": len(out) + 1,
            "clue": pref,
            "blanks": n,
            "prefix_len": len(pref),
        })
    return out


# 每格约合多少个字母 (实测: 3格->6字母, 4格->7字母, 5格->9字母)
# 取区间做宽松校验, 只用于"明显错位"告警, 不作为唯一判据。
CHARS_PER_BLANK = (1.2, 3.2)


def fill_answers(passage: str, answers: list[str]) -> tuple[str, list[dict]]:
    """
    用答案回填空, 生成"答案版"原文。

    对齐判据 (**按可靠性排序**, 满足其一即填):
      1. 线索是答案首词的前缀      —— 最强信号 (los -> losses)
      2. 无线索时, 答案词数 == 1  —— 只有一个词时无从错位
    线索与答案首词对不上 (如线索 b 配答案 species) 就**不填**,
    宁可留空也不出错 —— 错填比不填危害大得多。
    """
    blanks = parse_blanks(passage)
    if not blanks:
        return passage, []

    norm = [_answer_words(a) for a in answers]
    spans = [(m.start(), m.end()) for m in RE_BLANK.finditer(passage)]
    report: list[dict] = []
    out = passage

    for idx in range(len(blanks) - 1, -1, -1):
        b = blanks[idx]
        if idx >= len(norm) or not norm[idx]:
            report.append(dict(b, answer="", filled=False, why="无对应答案"))
            continue
        words = norm[idx]
        clue = b["clue"]
        first = words[0]
        text = " ".join(words)

        ok = False
        why = ""
        if clue:
            low_c, low_f = clue.lower(), first.lower()
            if low_f.startswith(low_c):
                ok, why = True, "线索匹配"
            elif len(clue) >= 3 and low_c in low_f:
                # 线索够长时才算"内嵌"; 太短 (如 "a"/"T") 极易误命中
                # ("a" 配 "climate" 就是这么错的), 不够长就不填。
                ok, why = True, "线索内嵌"
            else:
                why = f"线索 {clue!r} 与答案 {first!r} 不符"
        else:
            if len(words) == 1:
                ok, why = True, "无线索且单词"
            else:
                why = "无线索且多词, 不敢确定"

        if ok:
            start, end = spans[idx]
            out = out[:start] + text + out[end:]
        report.append(dict(b, answer=text, filled=ok, why=why))
    report.reverse()
    return out, report


def _answer_words(a: str) -> list[str]:
    """从 "1. events" / "1 events" / "events" 里取出纯答案词。"""
    s = re.sub(r"^\s*\d+\s*[.．、:：]?\s*", "", str(a or "")).strip()
    s = re.sub(r"^\**[A-D]\**[.．、]?\s*", "", s).strip()
    if not s:
        return []
    return s.split()


def blank_stats(passage: str) -> dict:
    """给体检用: 挖空数量分布, 用来发现"数量被压掉"的回归。"""
    bs = parse_blanks(passage)
    return {
        "total": len(bs),
        "multiword": sum(1 for b in bs if b["blanks"] > 1),
        "with_clue": sum(1 for b in bs if b["clue"]),
        "max_blanks": max((b["blanks"] for b in bs), default=0),
    }
