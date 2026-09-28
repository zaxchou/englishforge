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
