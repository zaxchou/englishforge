import type { Question } from '../types'

/** 第 10 课题库（下）：t10s4 瞬间vs延续 / t10s5 情态=态度 / t10s6 助动词=时间 */
export const lesson10qB: Question[] = [
  // ===== t10s4 瞬间 vs 延续 =====
  { id: 'v4q1', skill: 't10s4', type: 'choice', diff: 2, prompt: '"电影已经开始半小时了。"用哪个动词合适？', options: ['has been on for half an hour（延续表达）', 'has begun for half an hour', 'began half an hour', 'is begin half an hour'], answer: 'has been on for half an hour（延续表达）', explain: 'begin 是瞬间的——"开始"那一秒撑不了半小时。换成能延续的表达。', tts: 'The film has been on for half an hour.' },
  { id: 'v4q2', skill: 't10s4', type: 'choice', diff: 2, contentVersion: 3, prompt: '影院工作人员提醒你马上入场，说 "The film is beginning." 此时最合适的理解是？', options: ['电影即将开始（那一瞬正在到来）', '电影正在开始且持续', '电影开始半小时了', '电影已经结束'], answer: '电影即将开始（那一瞬正在到来）', explain: '在"马上放映"的语境里 is beginning 自然读作"即将开始"——这是语境解读，不是语法规则禁止（begin 的进行时本身可用，如 We are beginning to understand）。', tts: 'The film is beginning.' },
  { id: 'v4q3', skill: 't10s4', type: 'choice', diff: 2, prompt: '填空："He has ___ for half an hour."（他已经吃了半小时）', options: ['eaten', 'ate', 'eat', 'eating'], answer: 'eaten', explain: '吃可以延续 → has eaten + for half an hour。', tts: 'He has eaten for half an hour.' },
  { id: 'v4q4', skill: 't10s4', type: 'sort', diff: 2, prompt: '🗂️ 分类：瞬间（一眨眼完成）还是延续（能持续）？', buckets: ['瞬间动词', '延续动词'], items: [{ w: 'begin', b: 0 }, { w: 'eat', b: 1 }, { w: 'arrive', b: 0 }, { w: 'run', b: 1 }, { w: 'go', b: 0 }, { w: 'swim', b: 1 }], answer: 'sort', explain: '开始/到达/走是一瞬间；吃/跑/游能持续——含义里藏着"时间长短"。' },
  { id: 'v4q5', skill: 't10s4', type: 'tap', diff: 3, prompt: '点出句中与含义矛盾的词："他已经来两个小时了。"', tokens: ['He', 'has', 'come', 'for', 'two', 'hours', '.'], answer: 'come', fix: 'been here', explain: 'come 是瞬间的——"来"那一秒撑不了两小时。持续要用 been（他在这儿的状态持续了两小时）。', tts: 'He has been here for two hours.' },
  { id: 'v4q6', skill: 't10s4', type: 'choice', diff: 2, prompt: '"这场雨下了三天了。"', options: ['It has rained for three days.', 'It has rained since three days.', 'It rained three days only.', 'It is raining three days.'], answer: 'It has rained for three days.', explain: '下雨可以延续 → for + 时间段。', tts: 'It has rained for three days.' },
  { id: 'v4q7', skill: 't10s4', type: 'choice', myth: true, diff: 3, prompt: '有同学说："begin 的进行时不能用，是语法禁止。"张老师会怎么解释？',
    options: ['不是禁止——是含义矛盾："开始"那一瞬间撑不起"正在持续"', '对，语法规则禁止 begin 用进行时', 'begin 特殊，要单独背', '进行时只能配延续动词，背表格'],
    answer: '不是禁止——是含义矛盾："开始"那一瞬间撑不起"正在持续"',
    explain: '语法错误的根源是含义打架——瞬间动作和"正在/半小时"对不上（begin 的进行时并非本身不能用，是这些句子里"一瞬间"和"持续"对不上）。含义懂了，规则表就不用背。' },
  { id: 'v4q8', skill: 't10s4', type: 'choice', diff: 2, autoTTS: true, prompt: '🎧 听一听："He has worked here for ten years." 说明什么？', options: ['他在这儿工作的状态持续了十年（延续）', '他十年前刚来', '他明天要来', '他只工作了十天'], answer: '他在这儿工作的状态持续了十年（延续）', explain: 'for ten years 要求延续含义——work 能延续，has worked + for 十年。原句：He has worked here for ten years.', tts: 'He has worked here for ten years.' },
  { id: 'v4q9', skill: 't10s4', type: 'speak', diff: 3, prompt: '"他吃了一个小时。"', target: 'He has eaten for an hour.', tts: 'He has eaten for an hour.', answer: 'speak', explain: '吃的动作延续了一小时——延续动词 + for。' },

  // ===== t10s5 情态动词 = 态度强度 =====
  { id: 'v5q1', skill: 't10s5', type: 'choice', diff: 1, prompt: '"May I come in?" 表达的态度是？', options: ['请求（我能进来吗）', '命令', '禁止', '陈述事实'], answer: '请求（我能进来吗）', explain: '情态动词给动词配态度——May 在这里是"试探着请求"。', tts: 'May I come in?' },
  { id: 'v5q2', skill: 't10s5', type: 'sort', diff: 2, contentVersion: 3, reviewStatus: 'quarantined', prompt: '🗂️ 课堂场景（请进门）：按态度强度从弱到强排序（点弱→强）', buckets: ['更弱', '更强'], items: [{ w: 'can', b: 0 }, { w: 'must', b: 1 }, { w: 'may', b: 0 }, { w: "mustn't", b: 1 }, { w: 'could', b: 0 }, { w: 'have to', b: 1 }], answer: 'sort', explain: '同一场景内：能/可以 < 必须 < 禁止——态度的温度计。边界：强弱是语境内的相对值，不是所有用法的全局排序；may not 也能表"不允许"，只是比 mustn\'t 缓和。' },
  { id: 'v5q3', skill: 't10s5', type: 'choice', diff: 2, prompt: '老师连着说了三次 You must come in! 想表达什么？', options: ['态度很急切：你必须马上进来', '随便你进不进', '礼貌请求', '过去的事情'], answer: '态度很急切：你必须马上进来', explain: 'must 的态度比 may 强得多——同一个"进来"，情绪完全不同。', tts: 'You must come in!' },
  { id: 'v5q4', skill: 't10s5', type: 'choice', diff: 2, contentVersion: 3, reviewStatus: 'quarantined', accuracyRef: 'British Council — Permission（may not = not permitted，也能表"不允许"）', prompt: '"你绝对禁止进来！"（态度最强档）用哪个？', options: ["You mustn't come in.", 'You may not come in.', 'You can not come in.', 'You must come in.'], answer: "You mustn't come in.", explain: "最强的禁止档 → mustn't。边界要记牢：may not 也能表达「不允许」（You may not come in = 你不许进来），只是语气缓和——所以本题限定「最强档」才唯一选 mustn't。", tts: "You mustn't come in." },
  { id: 'v5q5', skill: 't10s5', type: 'choice', diff: 2, prompt: '"我能游泳"和"我可能会游泳"——can 的态度是？', options: ['有能力（我会/能）', '被允许', '义务', '禁止'], answer: '有能力（我会/能）', explain: 'can 排在态度计的最基础档：能力/可能性。', tts: 'I can swim.' },
  { id: 'v5q6', skill: 't10s5', type: 'choice', myth: true, diff: 3, prompt: '有同学把 can/may/must 当"语法点"背用法表。张老师会怎么看？',
    options: ['它们是"说话的态度"——态度强度不同，词就不同', '对，是三个不同用法要背', '其实可以混用', 'must 用得最少，可以忽略'],
    answer: '它们是"说话的态度"——态度强度不同，词就不同',
    explain: 'May I come in? / You must come in. / You mustn\'t——同一件事，情绪层层加码。语法的壳里装的是态度。' },
  { id: 'v5q7', skill: 't10s5', type: 'choice', diff: 2, autoTTS: true, prompt: '🎧 听一听：说话人是什么态度？', options: ['催促/必须（很急）', '请求', '禁止', '无所谓'], answer: '催促/必须（很急）', explain: 'You must come in——必须，态度强烈。原句：You must come in.', tts: 'You must come in.' },
  { id: 'v5q8', skill: 't10s5', type: 'speak', diff: 3, prompt: '"我能进来吗？"（礼貌版）', target: 'May I come in?', tts: 'May I come in?', answer: 'speak', explain: 'May——比 can 更礼貌的态度档位。' },

  // ===== t10s6 助动词 = 时间的记号 =====
  { id: 'v6q1', skill: 't10s6', type: 'choice', diff: 1, prompt: '"I don\'t know." 和 "I didn\'t know." 的含义差别是？', options: ['现在不知道 / 曾经不知道（时间不同）', '没区别', '程度不同', '语气不同而已'], answer: '现在不知道 / 曾经不知道（时间不同）', explain: 'do=现在，did=过去——助动词的形，就是时间的含义。所有词必须有意义。', tts: "I don't know. I didn't know." },
  { id: 'v6q2', skill: 't10s6', type: 'choice', diff: 1, prompt: '助动词 do 在 don\'t 里翻译得出来吗？', options: ['翻译不出"意思"，但它带着时间含义', '翻译成"做"', '翻译成"不"', '它是多余的词'], answer: '翻译不出"意思"，但它带着时间含义', explain: '翻译不出"意思"，但没有词是白出现的——助动词这里带的是时间（do=现在，did=过去）。' },
  { id: 'v6q3', skill: 't10s6', type: 'choice', diff: 2, prompt: '"I ___ running now."（我正在跑）', options: ['am', 'do', 'have', 'will'], answer: 'am', explain: 'be doing 搭配：be 助动词搭"正在"的舞台。', tts: 'I am running now.' },
  { id: 'v6q4', skill: 't10s6', type: 'choice', diff: 2, prompt: '"The book ___ found by me."（这本书被我找到了）', options: ['was', 'did', 'has', 'can'], answer: 'was', explain: 'be done 搭配：be 助动词搭被动语态的舞台。', tts: 'The book was found by me.' },
  { id: 'v6q5', skill: 't10s6', type: 'choice', diff: 2, prompt: '"I ___ my homework already."（我已经完成了）', options: ['have finished', 'finished already', 'finish', 'am finish'], answer: 'have finished', explain: 'have done 搭配：have 助动词搭"已经完成"。', tts: 'I have finished my homework already.' },
  { id: 'v6q6', skill: 't10s6', type: 'tap', diff: 2, prompt: '点出句中用错的助动词："我昨天不知道。"', tokens: ['I', "don't", 'know', 'yesterday', '.'], answer: "don't", fix: "didn't", explain: 'yesterday → 过去 → didn\'t。助动词变了，时间就变了。', tts: "I didn't know yesterday." },
  { id: 'v6q7', skill: 't10s6', type: 'choice', diff: 2, prompt: '变否定句、变疑问句时，谁来帮忙？', options: ['助动词（do/does/did）', '情态动词', '系动词', '副词'], answer: '助动词（do/does/did）', explain: '助动词的两个工作：搭时态语态 + 帮着变否定疑问。I like → I don\'t like → Do you like?' },
  { id: 'v6q8', skill: 't10s6', type: 'match', diff: 2, prompt: '🔗 配对：助动词搭档', pairs: [['be + doing', '正在做'], ['have + done', '已经做'], ['be + done', '被做'], ['do / did', '变否定/疑问']], answer: 'match', explain: '助动词像脚手架——主要动词不变，换脚手架就换了时态语态句式。' },
  { id: 'v6q9', skill: 't10s6', type: 'choice', myth: true, diff: 3, contentVersion: 2, prompt: '很多老师说："助动词没有实际意义，不用管它。"张老师会怎么纠正？',
    options: ['助动词不是凑数的——do/did 一变，时间含义就变了', '对，助动词就是凑数的', '助动词只在考试里出现', '助动词可以随便删'],
    answer: '助动词不是凑数的——do/did 一变，时间含义就变了',
    explain: '证据很朴素：don\'t=现在、didn\'t=过去，形一变含义就从"现在"跳到"过去"。"所有词必须有意义"是张老师"一切取决于含义"的教学讲法——语言学上助动词属语法词，但它的时态信息并不空，读句时必须抓出来。' },
  { id: 'v6q10', skill: 't10s6', type: 'choice', diff: 3, contentVersion: 2, prompt: 'I have been doing... 一句话里叠了两层助动词框架（have + been doing）——说明？', options: ['完成进行时：have（已经）+ been doing（一直在做）', '写错了，只能有一个助动词', '两层框架意思重复，删掉一个', '这是复数'], answer: '完成进行时：have（已经）+ been doing（一直在做）', explain: '脚手架可以叠：have（已经完成的框架）+ be doing（进行框架）= 完成进行——每层框架都带着自己的含义。', tts: 'I have been doing it.' },
  { id: 'v6q11', skill: 't10s6', type: 'speak', diff: 3, prompt: '"我现在不知道。"', target: "I don't know now.", tts: "I don't know now.", answer: 'speak', explain: 'don\'t——现在时间的记号。' },
]
