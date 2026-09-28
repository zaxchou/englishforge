#!/usr/bin/env python3
"""让模型做三件低风险活（判卷 / 翻译 / 写说明），补上检索层的两个缺口。

为什么是这三件：句子本身来自真实语料（可追溯），模型不做"想句子"这种高风险生成。
  1) 判英语合法性 —— 志愿者语料里混着不合法英语（实测有 `He miss me.`），必须挡。
  2) 写中文释义 —— Tatoeba 只有约 7% 的候选句有中文翻译；含义由英文给出，模型只做翻译。
  3) 写解析文案 —— 按张俊杰老师的判定纪律，落到"含义不同 → 形式不同"，不用术语教学。

输入  out/items-pronoun-case.json（scripts/build-items.py 产出）
输出  out/items-pronoun-case.enriched.json

用法：python scripts/enrich-items.py [--batch 8] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

from llm import LLMError, chat_json

# 张俊杰体系的判定纪律 —— 这段就是「宪法」，模型只许在它里面写文案
SYSTEM = """你是给中文母语成年人（哑巴英语、正在练「英语是直线型思维」体系）出练习的助教。

**要的是张俊杰老师的思路与逻辑，不是他的语气腔调。** 不要模仿口语化的"来同学们"式说话，
也不要写成课堂口头禅；要的是他那套推理方式，让学生读完能**自己推出**答案，而不是记住答案。

他教法的核心链条（所有解释都必须走这条链）：
  1. 先问：这句话要表达的**含义**是什么？
  2. 含义决定**形式**：一个含义对应一个形式，含义不同形式就必须不同。
  3. 所以这个形式不是"规则要求"，而是"这个含义的唯一载体"。
  4. 错的形式不是"违规"，而是**它在表达另一个含义**——说清它到底在说什么。

硬性要求：
- 禁用术语教学：不出现「三单规则」「形容词性物主代词」「宾格」「主格」这类语法名词当解释。
  要说"挨动作的那个""做动作的人""东西被省略了"，让学生从含义上理解。
- 解析（explain）必须给出上面那条链，20~60 个汉字，写清"含义 → 形式"的推导。
- 每条干扰项都要单独给一句**纠正**（optionFixes）：先说明"选它等于在说什么意思"，
  再说明为什么这里不是那个意思。这是学生下次能自己纠错的关键，不能敷衍成"这样不对"。
- 中文释义要自然，是这句话的中文意思，不要逐字直译。
- 判英语是否合法：主谓一致、冠词、单复数、标点、自然度。志愿者语料里可能有不合法英语
  （例如 He miss me. 应为 He misses me.），必须如实标出。

逐条处理用户给的 JSON 数组，只输出 JSON，不要任何解释文字。"""


def ask(batch: list[dict], idx: list[int]) -> dict[int, dict]:
    payload = [
        {'i': i,
         # 框架题的 answer 只是代词，释义必须基于完整句子
         'en': batch[k].get('sentence') or batch[k]['answer'],
         'options': batch[k]['options'], 'correct': batch[k]['answer'],
         'kind': batch[k].get('kind', 'meaning')}
        for k, i in enumerate(idx)
    ]
    user = ('只返回 JSON 数组，不要任何解释文字，**不要把输入对象原样回传**。\n'
            '每条形如：{"i":0,"ok":true,"problem":"","ambiguous":false,"multiError":false,"note":"","gloss":"我想念他。",'
            '"explain":"...","optionFixes":{"He miss me.":"选它等于说……"}}\n'
            '键名必须完全照写：ok / problem / distractorIssue / gloss / explain。'
            '中文释义的键名是 gloss——不要写成 zh 或 translation。\n'
            '  · ok：en 这句英语本身是否合法、是否像人话（主谓一致/冠词/单复数/标点/自然度）。'
            '像 "Hers accelerated." 这种语言学测试句虽然结构合法但不像人话，也要 ok=false。\n'
            '  · ambiguous（布尔）：**只看给定的中文意思**，是不是恰好只有一个选项成立？\n'
            '    只有一个成立 → false（正常，能出题）；两个以上都成立 → true（这题不能用）。\n'
            '    ⚠️ 一个选项是合法英语、只是含义不同或人称不同，**不算** ambiguous ——'
            '那正是本题要考的含义对比，不要误报。\n'
            '  · multiError（布尔）：是否有干扰项**本身不合语法/不地道**（与本题的对比无关）？\n'
            '    只有这种"错得不止一个原因、学生会用错误理由排除它"才算 true。'
            '单纯含义不同或人称不同，一律 false。\n'
            '  · note：如上面任一为 true，写一句说明；否则空字符串。\n'
            '  · explain：走"含义→形式"的推导链，20~60 汉字，读的人能自己推出答案。\n'
            '  · optionFixes：对象，键是**每个错误选项的原文**，值是那句纠正（先说明'
            '"选它等于在说什么意思"，再说清这里要的是哪个含义、所以该用哪个形式）。\n'
            '    所有错误选项都必须有，不能漏。\n'
            f'共 {len(payload)} 条：\n' + json.dumps(payload, ensure_ascii=False))
    raw = chat_json([{'role': 'system', 'content': SYSTEM},
                     {'role': 'user', 'content': user}],
                    max_tokens=3000, temperature=0.2)
    if isinstance(raw, dict):
        raw = raw.get('items') or raw.get('results') or [raw]
    out: dict[int, dict] = {}
    for r in raw:
        if not isinstance(r, dict) or 'i' not in r:
            continue
        try:
            i = int(r['i'])
        except (TypeError, ValueError):
            continue
        if 'gloss' not in r:                      # 兼容 zh/translation，但不静默接受缺失的 ok
            r['gloss'] = r.get('zh') or r.get('translation') or ''
        out[i] = r
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--items', default='out/items-pronoun-case.json')
    ap.add_argument('--out', default='out/items-pronoun-case.enriched.json')
    ap.add_argument('--batch', type=int, default=8)
    ap.add_argument('--limit', type=int, default=0)
    args = ap.parse_args()

    src = Path(args.items)
    items: list[dict] = json.loads(src.read_text(encoding='utf-8'))
    if args.limit:
        items = items[: args.limit]
    print(f'输入 {len(items)} 题，每批 {args.batch} 题')

    t0 = time.monotonic()
    stats = {'ok': 0, 'bad': 0, 'glossed': 0, 'failed_calls': 0, 'no_verdict': 0}
    for start in range(0, len(items), args.batch):
        chunk = items[start:start + args.batch]
        idx = list(range(start, start + len(chunk)))
        try:
            # 必须传当前批次 chunk，不能传全量 items：ask 内部按局部索引取 batch[k]，
            # 传全量会让第 2 批起把前 8 条的内容贴到后面的条目上（静默错位）。
            got = ask(chunk, idx)
        except (LLMError, ValueError) as e:
            stats['failed_calls'] += 1
            print(f'  [{start}] 调用失败: {str(e)[:120]}')
            continue
        for i in idx:
            r = got.get(i)
            # 严格：模型没给 ok 或没给释义，一律不当"通过"，也不写判定——宁可重试也别静默当合法
            if not r or 'ok' not in r or not isinstance(r.get('ok'), bool):
                stats['no_verdict'] += 1
                continue
            it = items[i]
            it['langCheck'] = {'ok': r['ok'], 'problem': (r.get('problem') or '').strip(),
                               'ambiguous': bool(r.get('ambiguous')),
                               'multiError': bool(r.get('multiError')),
                               'note': (r.get('note') or '').strip()}
            fixes = r.get('optionFixes')
            if isinstance(fixes, dict):
                # 只收真实存在于选项里的键，防止模型自造
                it['optionFixes'] = {k: str(v).strip() for k, v in fixes.items()
                                     if k in it['options'] and k != it['answer']}
            gloss = (r.get('gloss') or '').strip()
            explain = (r.get('explain') or '').strip()
            if not gloss:
                stats['no_verdict'] += 1
                continue
            it['gloss'] = gloss
            stats['glossed'] += 1
            # 有中文意思就能出「中文 → 英文形式」这类题；
            # 框架题的题干保持"I miss ___"，中文只作括号提示
            if it.get('kind') == 'meaning' or not it.get('prompt'):
                it['prompt'] = f'「{gloss}」'
            elif gloss not in it['prompt']:
                it['prompt'] = f"{it['prompt']}  （{gloss}）"
            if explain:
                it['explain'] = explain
            it['reviewStatus'] = 'machine-checked' if it['langCheck']['ok'] else 'rejected'
            stats['ok' if it['langCheck']['ok'] else 'bad'] += 1
        print(f'  [{start + len(chunk)}/{len(items)}] ok={stats["ok"]} '
              f'bad={stats["bad"]} gloss={stats["glossed"]} 无判定={stats["no_verdict"]}')

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8')
    dt = time.monotonic() - t0
    calls = (len(items) + args.batch - 1) // args.batch
    print(f'\n完成：{dt:.1f}s / {calls} 次调用（约 {dt / max(calls,1):.1f}s 一批）')
    print(f'英语合法 {stats["ok"]}，判为不合法 {stats["bad"]}，'
          f'写成中文释义 {stats["glossed"]}，失败批次 {stats["failed_calls"]}，'
          f'无判定(缺 ok/释义) {stats["no_verdict"]}')
    print(f'→ {out}')
    print('\n=== 样例（前 3 条）===')
    for it in items[:3]:
        print(json.dumps({k: it[k] for k in
                          ('prompt', 'options', 'answer', 'explain', 'gloss', 'langCheck', 'reviewStatus')
                          if k in it}, ensure_ascii=False, indent=1))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
