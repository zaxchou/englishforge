// 错因标签：把"你错在哪一类"变成可显示、可累计的东西。
// 标签由出题管线写在**选项级**（question.optionTags），答错时写进作答事件（Attempt.errorTags），
// 结算页据此汇总"这一轮你反复错在哪"。这是纠错闭环的数据基础。

/** 标签 → 人话短名（显示在"你选的这条错在哪"旁边） */
export const TAG_LABEL: Record<string, string> = {
  'role-reversed': '角色反了',
  'case-form-subject': '用了"做动作的"形式',
  'case-form-possessive': '用了"谁的"形式',
  'case-form-reflexive': '用了"自己"形式',
  'pron-before-noun': '名词性物主后面跟了名词',
  'det-without-noun': '"谁的"形式单独用了',
  'verb-form-third': '用了"他/她"的形式',
  'verb-form-base': '用了"我/你/他们"的形式',
  'plural-missing': '该用复数却用了单数',
  'plural-double': '已经是复数，又加了一次复数',
  'plural-spelling': '复数的拼写规则用错',
  'agreement-be': 'am / is / are 用错了',
  'tense-form': '时间的记号用错',
  'word-class': '词性用错（修饰关系对不上）',
  'other': '别的原因',
}

/** 标签 → 一句话纠正口径：下次遇到同类位置该怎么想（走含义→形式，不用术语） */
export const TAG_FIX: Record<string, string> = {
  'role-reversed': '先把"谁发出动作、动作落到谁身上"说清楚，再选形式——反过来说就是另一句话了。',
  'case-form-subject': '发出动作的位置，只能用"做动作的"那个形式。',
  'case-form-possessive': '"谁的"形式后面必须有被拥有的东西，不能单独站着。',
  'case-form-reflexive': '"自己"形式意味着动作回到自己身上，不等于"他/她"。',
  'pron-before-noun': '名词性物主形式本身就含"某人的东西"，后面不能再跟名词。',
  'det-without-noun': '形容词性物主形式后面必须跟名词；名词被省略时换另一个形式。',
  'verb-form-third': '主语是"他/她"一个人时，动词用对应的那个形式。',
  'verb-form-base': '主语是"我/你/我们/他们"时，动词用原形那个形式。',
  'plural-missing': '含义是"多个"，形式就必须变成复数——不是加个 s 的装饰，是换一个词。',
  'plural-double': '这个词本身就是复数形式了，再加一次就等于说了两遍"多个"。',
  'plural-spelling': '复数怎么写取决于怎么念得顺（-es / 变 y / 变 f），别只记"加 s"。',
  'agreement-be': '"是"跟着主语变：我配 am，单个他/她/它配 is，其余配 are。',
  'tense-form': '先说清楚"这件事发生在什么时候"，再决定动词带哪个时间记号。',
  'word-class': '先看这个词在修饰谁：修饰名词用那种形式，修饰动作才用另一种。',
  'other': '回到那句话要表达的含义上重新想一遍。',
}

export function tagLabel(tag: string): string {
  return TAG_LABEL[tag] ?? tag
}

/** 汇总一组错因标签，按出现次数降序（次数相同按标签名稳定排序，便于测试） */
export function summarizeTags(tagLists: (string[] | undefined)[]): { tag: string; n: number }[] {
  const count = new Map<string, number>()
  for (const list of tagLists) {
    for (const t of list ?? []) count.set(t, (count.get(t) ?? 0) + 1)
  }
  return [...count.entries()]
    .map(([tag, n]) => ({ tag, n }))
    .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag))
}
