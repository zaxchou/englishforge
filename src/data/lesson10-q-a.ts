import type { Question } from '../types'

/** 第 10 课题库（上）：t10s1 状态也是动词 / t10s2 六类系动词 / t10s3 加不加宾语 */
export const lesson10qA: Question[] = [
  // ===== t10s1 状态也是动词 =====
  { id: 'v1q1', skill: 't10s1', type: 'choice', diff: 1, prompt: '"I am happy" 里的 am 是什么动词？', options: ['联系动词（连接"我"和"开心"的状态）', '实义动词（有动作）', '情态动词', '不是动词'], answer: '联系动词（连接"我"和"开心"的状态）', explain: 'am 没有动作，它的任务是把主体和状态连起来——这就是"联系动词"名字的由来。', tts: 'I am happy.' },
  { id: 'v1q2', skill: 't10s1', type: 'choice', diff: 1, prompt: '下面哪个是实义动词（真的有动作）？', options: ['run', 'be', 'seem', 'become'], answer: 'run', explain: '跑是真动作；be/seem/become 后面接的都是状态。' },
  { id: 'v1q3', skill: 't10s1', type: 'sort', diff: 2, prompt: '🗂️ 分类：实义动词（有动作）还是系动词（接状态）？', buckets: ['实义动词', '系动词'], items: [{ w: 'eat', b: 0 }, { w: 'feel', b: 1 }, { w: 'swim', b: 0 }, { w: 'look', b: 1 }, { w: 'write', b: 0 }, { w: 'become', b: 1 }], answer: 'sort', explain: '吃喝游写是真动作；感觉/看起来/变成——后面接的都是状态。' },
  { id: 'v1q4', skill: 't10s1', type: 'tap', diff: 2, prompt: '点出句中用错的词："她听起来累了。"', tokens: ['She', 'sound', 'tired', '.'], answer: 'sound', fix: 'sounds', explain: '她=三单 → sounds；sounds 是感官系动词，tired 是它的状态。', tts: 'She sounds tired.' },
  { id: 'v1q5', skill: 't10s1', type: 'choice', diff: 2, autoTTS: true, prompt: '🎧 听一听：句子的动词是实义还是系动词？', options: ['系动词（接状态）', '实义动词（有动作）', '没有动词', '两个实义动词'], answer: '系动词（接状态）', explain: 'I feel cold——感觉冷，feel 后面接状态 → 系动词。原句：I feel cold.', tts: 'I feel cold.' },
  { id: 'v1q6', skill: 't10s1', type: 'choice', myth: true, diff: 3, prompt: '"动词就是表示动作的词"——这是教材定义。张老师会怎么破？',
    options: ['英语动词不一定有动作——状态也是动词（verb ≠ 动作）', '教材说得对，动词必须有动作', '只有跑跳吃喝才算动词', '系动词不算动词'],
    answer: '英语动词不一定有动作——状态也是动词（verb ≠ 动作）',
    explain: '"动词"这个中文翻译坑了我们——I am happy、She is a doctor 里根本没有动作，但它们就是句子的发动机。' },
  { id: 'v1q7', skill: 't10s1', type: 'choice', diff: 2, prompt: '"这本书很有趣。"（The book interesting）——中间该填什么？', options: ['is', 'does', 'has', 'can'], answer: 'is', explain: '说状态（很有趣）→ 系动词 is 连接主体和状态。', tts: 'The book is interesting.' },
  { id: 'v1q8', skill: 't10s1', type: 'speak', diff: 3, prompt: '"我很开心。"', target: 'I am happy.', tts: 'I am happy.', answer: 'speak', explain: 'am 连接"我"和"开心"——状态也是动词。' },

  // ===== t10s2 六类系动词 =====
  { id: 'v2q1', skill: 't10s2', type: 'match', diff: 2, prompt: '🔗 配对：系动词和它的家族', pairs: [['look', '感官（看起来）'], ['become', '变化（变成）'], ['keep', '保持（保持）'], ['seem', '似乎（似乎）']], answer: 'match', explain: '六大家族：be / 感官 / 变化 / 保持 / 似乎 / 结果——后面接的全是状态。' },
  { id: 'v2q2', skill: 't10s2', type: 'choice', diff: 1, prompt: '"黑板看起来很干净。"', options: ['The blackboard looks clean.', 'The blackboard looks cleanly.', 'The blackboard look clean.', 'The blackboard is look clean.'], answer: 'The blackboard looks clean.', explain: 'looks 是感官系动词，后接形容词 clean（状态）。', tts: 'The blackboard looks clean.' },
  { id: 'v2q3', skill: 't10s2', type: 'choice', diff: 2, prompt: '"这首歌听起来很美妙。"', options: ['The song sounds beautiful.', 'The sun sounds beautiful.', 'The song sound beautiful.', 'The song listens beautiful.'], answer: 'The song sounds beautiful.', explain: 'sounds 是感官系动词；song（歌）不是 sun（太阳）。', tts: 'The song sounds beautiful.' },
  { id: 'v2q4', skill: 't10s2', type: 'choice', diff: 1, prompt: '乔布斯名言：stay ___, stay ___.（保持饥饿，保持愚蠢）', options: ['hungry, foolish', 'hunger, foolish', 'hungry, fool', 'hunger, fool'], answer: 'hungry, foolish', explain: 'stay 系动词 + 形容词状态。stay hungry, stay foolish——保持就用 stay。', tts: 'Stay hungry, stay foolish.' },
  { id: 'v2q5', skill: 't10s2', type: 'choice', diff: 2, prompt: '"他疯了。"（go mad 是哪个家族）', options: ['变化（变疯）', '感官（看起来疯）', '保持（一直疯）', '结果（证明疯）'], answer: '变化（变疯）', explain: 'go 在这里是"变得"——变化家族（go mad / go bad）。', tts: 'He has gone mad.' },
  { id: 'v2q6', skill: 't10s2', type: 'tap', diff: 2, prompt: '点出句中用错的词："这首歌听起来很美妙。"', tokens: ['The', 'song', 'sound', 'beautiful', '.'], answer: 'sound', fix: 'sounds', explain: 'song=它他 → sounds（三单也是含义：谁听起来）。', tts: 'The song sounds beautiful.' },
  { id: 'v2q7', skill: 't10s2', type: 'choice', diff: 2, prompt: '"我的梦想成真了。"（come true 是哪个家族）', options: ['变化（变得真实）', '结果', '感官', '保持'], answer: '变化（变得真实）', explain: 'come true = 从不真变真 → 变化家族。', tts: 'My dream has come true.' },
  { id: 'v2q8', skill: 't10s2', type: 'sort', diff: 3, prompt: '🗂️ 分类：变化家族 vs 保持家族', buckets: ['变化', '保持'], items: [{ w: 'get', b: 0 }, { w: 'keep', b: 1 }, { w: 'turn', b: 0 }, { w: 'remain', b: 1 }, { w: 'go', b: 0 }, { w: 'stay', b: 1 }], answer: 'sort', explain: 'get/turn/go 是"变得"（变化）；keep/remain/stay 是"一直是"（保持）。' },
  { id: 'v2q9', skill: 't10s2', type: 'choice', diff: 2, autoTTS: true, prompt: '🎧 听一听：哪个是系动词在工作？', options: ['looks（感官系动词）', '看（实义动词）', 'is looking（进行时）', 'looked at（及物）'], answer: 'looks（感官系动词）', explain: 'The blackboard looks clean——looks 接状态，感官系动词。原句：The blackboard looks clean.', tts: 'The blackboard looks clean.' },
  { id: 'v2q10', skill: 't10s2', type: 'speak', diff: 3, prompt: '"黑板看起来很干净。"', target: 'The blackboard looks clean.', tts: 'The blackboard looks clean.', answer: 'speak', explain: 'looks + 形容词状态——感官系动词的标准句。' },

  // ===== t10s3 加不加宾语由含义定 =====
  { id: 'v3q1', skill: 't10s3', type: 'choice', diff: 1, prompt: '"我吃。"这句话通顺吗？', options: ['通顺——eat 可以不及物用', '不通顺，必须加宾语', '必须说 I eat it', '只能在餐厅里说'], answer: '通顺——eat 可以不及物用', explain: '句意完整，不缺对象 → 不及物用法。含义说了算，不查词典。', tts: 'I eat.' },
  { id: 'v3q2', skill: 't10s3', type: 'choice', diff: 1, prompt: '"我吃苹果。"这里 eat 是？', options: ['及物（后面跟了对象）', '不及物', '系动词', '情态动词'], answer: '及物（后面跟了对象）', explain: '含义需要"吃什么"跟在后面 → 及物。同一个词，含义决定当哪边用。', tts: 'I eat an apple.' },
  { id: 'v3q3', skill: 't10s3', type: 'choice', diff: 2, prompt: '"我唱歌。"和"我唱一首歌。"——用法对的是？', options: ['I sing. 和 I sing a song. 都对', '只有 I sing a song 对', '只有 I sing 对', '两个都不对'], answer: 'I sing. 和 I sing a song. 都对', explain: 'sing 两边都能站：说完整（我唱歌）就不及物，想加对象（一首歌）就及物——含义决定。', tts: 'I sing. I sing a song.' },
  { id: 'v3q4', skill: 't10s3', type: 'choice', diff: 2, prompt: '填空："He ___ （swim）every morning."', options: ['swims', 'swims it', 'is swim', 'swimming'], answer: 'swims', explain: 'swim 说"他每天游泳"已完整，不用硬塞对象——不及物直接用。', tts: 'He swims every morning.' },
  { id: 'v3q5', skill: 't10s3', type: 'tap', diff: 2, prompt: '点出句中多余的词："我每天游泳它。"', tokens: ['I', 'swim', 'it', 'every', 'day', '.'], answer: 'it', fix: '(删掉)', explain: 'swim 不需要对象——句意已完整，it 是多余的。加不加宾语看含义，不是见动词就加。', tts: 'I swim every day.' },
  { id: 'v3q6', skill: 't10s3', type: 'choice', myth: true, diff: 3, prompt: '"及物不及物要背词典标注，v i 一查才知道。"张老师会怎么破？',
    options: ['从含义判断——句意完整就不及物，缺对象就及物，不用查', '对，先背 v/t 标注', '词典标注才是权威', '及物不及物是固定属性，永远不变'],
    answer: '从含义判断——句意完整就不及物，缺对象就及物，不用查',
    explain: '同一个动词常两边站（I sing / I sing a song）——它不是刻在词里的标签，是含义现场决定的用法。' },
  { id: 'v3q7', skill: 't10s3', type: 'choice', diff: 3, prompt: '"他出生在 2000 年。"——born 后面跟状态，用哪个？', options: ['He was born in 2000.', 'He born in 2000.', 'He is born in 2000.', 'He has born in 2000.'], answer: 'He was born in 2000.', explain: '出生是过去的状态 → was born（系动词 be + 过去分词表状态）。', tts: 'He was born in 2000.' },
  { id: 'v3q8', skill: 't10s3', type: 'speak', diff: 3, prompt: '"我吃苹果。"', target: 'I eat an apple.', tts: 'I eat an apple.', answer: 'speak', explain: 'eat + 对象 an apple——及物用法，含义需要它。' },
]
