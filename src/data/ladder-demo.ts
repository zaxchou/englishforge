// 深度阶梯样板（单个知识点 · 6 档 · 18 题）——给用户"感受层层递进"的最小完整切片。
//
// 为什么这样做：
//   老题库（约 490 道）91% 是 ≤5 词的单句四选一、82% 落在"识别"一个维度上，
//   所以用户做完 300 道仍感觉"太简单、没层次"。这个样板把**同一个知识点**
//   （主格宾格 = 谁在做事 / 事落在谁身上）从"认"一路推到"释"：
//     1 认 识别形式↔含义 · 2 造 受控产出 · 3 辨 最小对立对比
//     4 说 无脚手架产出 · 5 迁 干扰下迁移 · 6 释 反向解释为何错
//   句长同步递进：3~4 词 → 5~6 → 8~9 → 10~11 → 长句+对话 → 理由判断。
//   档位门控见 src/learning/ladder.ts：只放行已达标的档，界面上画出阶梯。
//
// 内容纪律（沿用语料管线的既定规矩）：
//   · 每句英文锚定一句真实语料，出处写在 sourceRef（Tatoeba CC BY 2.0 FR）
//   · 干扰项 = 真实镜像句（角色对调）或对真实框架的最小违反，不凭空造句
//   · 解析走张老师的推理链：含义是什么 → 含义决定形式 → 错的形式在表达另一个含义
//   · 禁止术语教学：不说"主格规则/宾格规则"，只说"谁做事、事落在谁"
import type { Lesson, Question } from '../types'

const SRC = '深度阶梯样板 / Tatoeba CC BY 2.0 FR · tatoeba:'

/** 样板课（放在 skillOrder 最前 → 打开就是它，用户可以直接感受阶梯） */
export const ladderDemoLesson: Lesson = {
  id: 'ldd',
  no: '00',
  title: '深度阶梯样板 · 主格与宾格',
  subtitle: '同一个知识点，从"认"一路推到"释"',
  skills: [
    {
      id: 'ldd1',
      name: '主格宾格 · 六档深度阶梯',
      tagline: '认 → 造 → 辨 → 说 → 迁 → 释，一档过了才开下一档',
      icon: '🪜',
      concept: {
        title: '这一个知识点没变——变的是问你的深度',
        body: [
          '你之前做过的主格宾格题，大多是 3~5 个词的四选一：一眼看出谁做事、谁挨着。',
          '现在还是同一个知识点（谁在做事、事落在谁身上），但问法换到六层：认出来 → 拼出来 → 分辨谁做谁挨 → 不看原句直接说出来 → 放进长句和对话里照样用对 → 最后说清"错的形式到底在说什么"。',
          '句子同步长起来：从 I adore him.（3 个词）长到带从句和对话的整句（10 个词以上）。',
          '每一档答好才开下一档。**不会因为题量多就前进，只会因为你真把这一层做出来**——这就是层层递进。',
        ],
        example: '认 I adore him. → 造 She gave me several books. → 说 The doctor told her that she should take a rest.',
        exampleNote: '同一个知识点，深度换了六层；句子从 3 词长到 11 词。',
      },
    },
  ],
}


export const ladderDemoQuestions: Question[] = [
  // ================= 第 1 档 · 认（识别形式 ↔ 含义，3~4 词） =================
  {
    id: 'ld1q1', skill: 'ldd1', type: 'choice', level: 1, diff: 1, mode: 'recognition',
    prompt: '「我很崇拜他。」 I adore ___.',
    options: ['him', 'he', 'his', 'himself'],
    answer: 'him',
    tts: 'I adore him.',
    explain: '先问含义：这句谁在做事，事又落到谁身上。"我"是发出崇拜的那个，"他"是承接这件事的位置——位置定形式，所以是 him。he 只站"做事的"那一格。',
    optionFeedback: {
      he: '选它等于把"崇拜"的发出者换成他——可这句里发出崇拜的是我，他只是被崇拜的那一个。',
      his: '选它等于说"他的（某样东西）"，后面必须再跟一件属于他的东西，这句里没有那样东西。',
      himself: '选它等于说"他崇拜他自己"，动作绕回自己身上——可这句里看着他的是我。',
    },
    optionTags: { he: ['case-form-subject'], his: ['case-form-possessive'], himself: ['case-form-reflexive'] },
    sourceRef: SRC + '8475763', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld1q2', skill: 'ldd1', type: 'choice', level: 1, diff: 1, mode: 'recognition',
    prompt: '「她生我的气。」 She is mad at ___.',
    options: ['me', 'I', 'mine', 'myself'],
    answer: 'me',
    tts: 'She is mad at me.',
    explain: '"生气"这件事从她那边发出，接到的是我——at 后头那个位置要的是"挨着"的形式：me。I 是站"做事位置"用的，这句那个位置已经归她了。',
    optionFeedback: {
      I: '选它等于说"我才是生气的那个人"，可生气的是她；这个位置该站"挨气"的我。',
      mine: '选它等于说"我生气的对象是我的（东西）"，mine 后面不跟人，它代替的是已经说过的名词。',
      myself: '选它等于说"她生自己的气"，动作绕回她自己——可这句气是往我这边来的。',
    },
    optionTags: { I: ['case-form-subject'], mine: ['case-form-possessive'], myself: ['case-form-reflexive'] },
    sourceRef: SRC + '6130', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld1q3', skill: 'ldd1', type: 'choice', level: 1, diff: 1, mode: 'recognition',
    prompt: '「我今早给他打过电话。」 I called him this morning.',
    options: ['him', 'he', 'his', 'himself'],
    answer: 'him',
    tts: 'I called him this morning.',
    explain: '打电话的是我，接到这通电话的是他 → him。he 是给"发出动作的那位"留的位置，而这句发出动作的已经是我。',
    optionFeedback: {
      he: '选它等于把打电话的人换成他——那中文就成了"他今早打给我"，方向反了。',
      his: '选它等于说"我打了他的（某样东西）"，call 后面要接人，不是接他的东西。',
      himself: '选它等于说"他给自己打了个电话"，动作绕回自己身上。',
    },
    optionTags: { he: ['role-reversed'], his: ['case-form-possessive'], himself: ['case-form-reflexive'] },
    sourceRef: SRC + '240105', contentVersion: 1, reviewStatus: 'draft',
  },

  // ================= 第 2 档 · 造（受控产出：词块拼句，5~6 词） =================
  {
    id: 'ld2q1', skill: 'ldd1', type: 'tiles', level: 2, diff: 1, mode: 'construction',
    prompt: '拼出：「我叫他来的。」',
    order: ['I', 'told', 'him', 'to', 'come', '.'],
    tokens: ['I', 'told', 'him', 'he', 'to', 'come', '.'],
    tts: 'I told him to come.',
    explain: '词块里 he、him 都给你了。"叫"这个动作是我发出的，被叫到的是他——站到 to come 前面的必须是 him；he 一旦被放进去，它占的就成了"发出叫的人"那个位置。',
    sourceRef: SRC + '260501', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld2q2', skill: 'ldd1', type: 'tiles', level: 2, diff: 1, mode: 'construction',
    prompt: '拼出：「她给了我好几本书。」',
    order: ['She', 'gave', 'me', 'several', 'books', '.'],
    tokens: ['She', 'gave', 'me', 'I', 'her', 'several', 'books', '.'],
    tts: 'She gave me several books.',
    explain: '这批词块能拼出两个都通顺的句子：She gave me… 和 I gave her…。选哪一个不是语法问题，是**中文那句话的方向**——书是从她手里出去的，落到我这里。方向一换，形式就跟着换。',
    sourceRef: SRC + '261026', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld2q3', skill: 'ldd1', type: 'tiles', level: 2, diff: 1, mode: 'construction',
    prompt: '拼出：「我给她看了我的房间。」',
    order: ['I', 'showed', 'her', 'my', 'room', '.'],
    tokens: ['I', 'showed', 'her', 'me', 'she', 'my', 'room', '.'],
    tts: 'I showed her my room.',
    explain: '同样是两条路都拼得通：I showed her my room，或 She showed me her room。中文只有一句，所以你得照中文那条走——"我"站前，"她"站在被展示的位置。',
    sourceRef: SRC + '261189', contentVersion: 1, reviewStatus: 'draft',
  },

  // ================= 第 3 档 · 辨（最小对立对比：词序一换意思翻，8~9 词） =================
  {
    id: 'ld3q1', skill: 'ldd1', type: 'choice', level: 3, diff: 2, mode: 'comprehension',
    prompt: '「他给我讲述了他的一生。」哪句英文说的是这个意思？',
    options: [
      'He told me the story of his life.',
      'I told him the story of my life.',
      'He told my the story of his life.',
    ],
    answer: 'He told me the story of his life.',
    tts: 'He told me the story of his life.',
    explain: '两个英文句子里 he 和 me、his 和 my 完全对称，差别只在谁站第一格——站第一格的那位是在"讲"的。中文这句讲的人是他、听的是我，所以是 He told me。换位不是"换种说法"，是换了个人在讲故事。',
    optionFeedback: {
      'I told him the story of my life.': '选它等于说"我给他讲了我自己的人生"——词一个没少，说话的人和听的人整个对调了。这是这道题最像的一颗雷。',
      'He told my the story of his life.': '选它等于说"他讲了我（的某样东西）的那件事"，my 必须贴着名词，不能站到 tell 后面去接人。',
    },
    optionTags: {
      'I told him the story of my life.': ['role-reversed'],
      'He told my the story of his life.': ['case-form-possessive'],
    },
    sourceRef: SRC + '2063', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld3q2', skill: 'ldd1', type: 'choice', level: 3, diff: 2, mode: 'comprehension',
    prompt: '「我请他们再寄给我一张票。」哪句英文说的是这个意思？',
    options: [
      'I told them to send me another ticket.',
      'They told me to send them another ticket.',
      'I told they to send me another ticket.',
    ],
    answer: 'I told them to send me another ticket.',
    tts: 'I told them to send me another ticket.',
    explain: '这句里两拨人各出现两次：请人的是我、被请的是他们；后半句里寄票的是他们、收票的又是我。四处位置、四处形式，全跟着"谁做事、事落到谁"走。对调之后句法照样成立，可它说成了一件相反的事。',
    optionFeedback: {
      'They told me to send them another ticket.': '选它等于说"他们请我再寄给他们一张票"——方向整个掉头，谁求谁、谁寄谁收全反了。',
      'I told they to send me another ticket.': '选它等于把"他们"放在接动作的位置，可那个位置要的是被请的那一个、承接的形式。',
    },
    optionTags: {
      'They told me to send them another ticket.': ['role-reversed'],
      'I told they to send me another ticket.': ['case-form-subject'],
    },
    sourceRef: SRC + '1313', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld3q3', skill: 'ldd1', type: 'choice', level: 3, diff: 2, mode: 'comprehension',
    prompt: '「I\'ll call them tomorrow when I come back.」——这句的中文意思是什么？',
    options: [
      '我明天回来的时候会跟他们联络。',
      '他们明天回来的时候会跟我联络。',
      '我们明天回来的时候会跟他们联络。',
      '他们明天会联络我，然后我就回来。',
    ],
    answer: '我明天回来的时候会跟他们联络。',
    tts: 'I\'ll call them tomorrow when I come back.',
    explain: '反过来看同一套逻辑：I 站在两处动作的第一格 → 打电话的、回来的都是我；them 跟在动词后 → 接电话的是他们。中文靠"谁+动词+谁"的次序读方向，英文靠词站的位置，两边是同一根轴。',
    optionFeedback: {
      '他们明天回来的时候会跟我联络。': '选它等于把 I 和 them 的位置读反了——打的人成了他们，回的人也成了他们。',
      '我们明天回来的时候会跟他们联络。': '选它凭空把"我"扩成了"我们"，英文里 I 就是一个人。',
      '他们明天会联络我，然后我就回来。': '选它把 when 的因果读成先后——原句里"回来"是条件，不是结果。',
    },
    sourceRef: SRC + '1309', contentVersion: 1, reviewStatus: 'draft',
  },

  // ================= 第 4 档 · 说（无脚手架产出：对着中文直接说，10~11 词） =================
  {
    id: 'ld4q1', skill: 'ldd1', type: 'speak', level: 4, diff: 2, mode: 'oral',
    prompt: '说出：「我会告诉她开会的时候说些什么。」（先别看原句）',
    target: 'I will tell her what to say at the meeting.',
    tts: 'I will tell her what to say at the meeting.',
    answer: 'speak',
    explain: '没有词块、没有选项——先想"我"要告诉谁：告诉她 → tell her；再把后面那件事接上。方向在这一步就得定对，别等选词时才想。',
    sourceRef: SRC + '22454', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld4q2', skill: 'ldd1', type: 'speak', level: 4, diff: 2, mode: 'oral',
    prompt: '说出：「医生告诉她要静养。」（先别看原句）',
    target: 'The doctor told her that she should take a rest.',
    tts: 'The doctor told her that she should take a rest.',
    answer: 'speak',
    explain: '同一个人在这句里站了两次位置：被"告诉"的是她 → her；后面自己去休息的又是她，这次她站在"做事"的那格 → she。同一个人、两个形式，因为两个位置。',
    sourceRef: SRC + '27919', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld4q3', skill: 'ldd1', type: 'speak', level: 4, diff: 3, mode: 'oral',
    prompt: '说出：「我希望我能和她多谈一会儿。」（先别看原句）',
    target: 'I wish I had more time to talk with her.',
    tts: 'I wish I had more time to talk with her.',
    answer: 'speak',
    explain: '一句里三个人称词：两个 I 都在"想、有"的位置，talk with her 里谈话由我发出、"和她"是接到的那一个 → her。位置不同，形式就不同。',
    sourceRef: SRC + '30374', contentVersion: 1, reviewStatus: 'draft',
  },

  // ================= 第 5 档 · 迁（干扰下迁移：长句 / 对话，10~11 词） =================
  {
    id: 'ld5q1', skill: 'ldd1', type: 'choice', level: 5, diff: 3, mode: 'recognition',
    prompt: '「我不明白你为什么对他这么苛刻。」 I can\'t understand why you are so critical of ___.',
    options: ['him', 'he', 'his', 'himself'],
    answer: 'him',
    tts: 'I can\'t understand why you are so critical of him.',
    explain: '这句套了两层：主句是我不明白，从句才是你对他苛刻。苛刻这个评价由你发出、落到他身上 → of him。he 在从句里会变成"做事的"，可那件事是你做的。',
    optionFeedback: {
      he: '选它等于让"苛刻"这件事由他来做——可从句里做事的是你，他是被评价的那一个。',
      his: '选它等于说"你对他的（态度/表现）苛刻"，his 得贴着一样东西，这里说的是他这个人。',
      himself: '选它等于说"你对自己苛刻"，动作绕回你自己身上。',
    },
    optionTags: { he: ['case-form-subject'], his: ['case-form-possessive'], himself: ['case-form-reflexive'] },
    sourceRef: SRC + '36479', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld5q2', skill: 'ldd1', type: 'choice', level: 5, diff: 3, mode: 'recognition',
    prompt: '「如果我知道他的地址，就能写信给他。」 If I knew his address, I could write to ___.',
    options: ['him', 'he', 'his', 'himself'],
    answer: 'him',
    tts: 'If I knew his address, I could write to him.',
    explain: '这一句里"他的"出现了两次，形式却不同：his address 是"他的地址"（贴着名词），write to him 是"写给他"（承接动作）。**同一个人、同一件事的两面，位置不同，形式就不同**——不是记两个词。',
    optionFeedback: {
      he: '选它和前面的 his address 混成一类——可 his 负责修饰名词，he 站的是"做事的"位置，写信这件事是我做的。',
      his: '选它等于说"我就能写信给他的（东西）"，to 后面接的是收到信的人。',
      himself: '选它等于说"我就能写信给自己"，我明明是要写给他。',
    },
    optionTags: { he: ['case-form-subject'], his: ['case-form-possessive'], himself: ['case-form-reflexive'] },
    sourceRef: SRC + '30659', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld5q3', skill: 'ldd1', type: 'choice', level: 5, diff: 3, mode: 'recognition',
    prompt: '对话里：「我找不到汤姆。」「给他打电话试试吧。」 I can\'t find Tom. "Try ringing ___."',
    options: ['him', 'he', 'his', 'it'],
    answer: 'him',
    tts: 'I can\'t find Tom. "Try ringing him."',
    explain: '对话里 him 回指 Tom，而 Tom 站在 ring 的后头——挨动作的那个。说 he 等于让汤姆自己拨给自己；说 it 就把人当成了物。回指也一样要认位置。',
    optionFeedback: {
      he: '选它等于让汤姆去打这通电话——可动手试的是听话的我。',
      his: '选它等于说"打给他的（某样东西）"，ring 后面接的是那个人本身。',
      it: '选它把 Tom 当成了东西——对话里说的是个人。',
    },
    optionTags: { he: ['case-form-subject'], his: ['case-form-possessive'], it: ['word-class'] },
    sourceRef: SRC + '4644997', contentVersion: 1, reviewStatus: 'draft',
  },

  // ================= 第 6 档 · 释（反向解释为何错：错的形式在说什么） =================
  {
    id: 'ld6q1', skill: 'ldd1', type: 'choice', level: 6, diff: 3, mode: 'comprehension',
    prompt: '把 "I lent him a CD." 说成 "He lent me a CD."，意思会怎样？',
    options: [
      '正好相反：从"我借给他"变成"他借给我"',
      '两句话说的是同一件事，只是换了个说法',
      '第二句是病句，不能这么说',
      '意思差不多，都是"我们互相借了张CD"',
    ],
    answer: '正好相反：从"我借给他"变成"他借给我"',
    tts: 'I lent him a CD.',
    explain: 'lend 是有方向的动作，方向写在位置上：第一格是谁把东西递出去，动词后头是谁接住。位置一换，CD 的去向整个掉头——**词一个没换，意思变成了一件相反的事**。这就是"形式即含义"。',
    sourceRef: SRC + '260265', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld6q2', skill: 'ldd1', type: 'choice', level: 6, diff: 3, mode: 'comprehension',
    prompt: '下面哪句把「她给了我几本书。」说反了？',
    options: [
      'I gave her several books.',
      'She gave me several books.',
      'She gave I several books.',
      'Several books she gave me.',
    ],
    answer: 'I gave her several books.',
    tts: 'She gave me several books.',
    explain: '第三句不是"说反了"，是形式站错了位置、根本不成立；第四句把次序倒过来说，方向仍是她给我。真正把意思说反的只有第一句——它语法完全正确，方向却掉了头。**错得最危险的从来不是病句，是通顺的反话。**',
    optionFeedback: {
      'She gave me several books.': '这是原句，方向正确：书从她手里出去，落到我这里。',
      'She gave I several books.': '选它等于把"我"放到了接动作的位置——这句形式不对，说不出口，但不会骗人。',
      'Several books she gave me.': '选它只是把次序倒过来强调，方向没变，还是她给我。',
    },
    optionTags: {
      'She gave me several books.': ['role-reversed'],
      'She gave I several books.': ['case-form-subject'],
      'Several books she gave me.': ['other'],
    },
    sourceRef: SRC + '261026', contentVersion: 1, reviewStatus: 'draft',
  },
  {
    id: 'ld6q3', skill: 'ldd1', type: 'choice', level: 6, diff: 3, mode: 'comprehension',
    prompt: '"Look at me when I talk to you!"——同一个"我"，为什么一处是 me、一处是 I？',
    options: [
      '这句里的"我"站了两个位置：前半句是被看的那一个，后半句是开口说话的那一个',
      'me 用在祈使句，I 用在陈述句，跟位置没关系',
      'me 是"我"，I 是强调一点的"我"',
      '两个词意思不同，me 是被别人看的人，I 是看别人的人',
    ],
    answer: '这句里的"我"站了两个位置：前半句是被看的那一个，后半句是开口说话的那一个',
    tts: 'Look at me when I talk to you!',
    explain: '同一个"我"、同一句喊话，形式换了两次，只因为前半句的我是**被看的**（挨 at），后半句的我是**开口说的**。位置一变，形式就变——不是这个词有两种写法，是它在两件事里扮了两个角色。整条主线到这儿就闭环了。',
    optionFeedback: {
      'me 用在祈使句，I 用在陈述句，跟位置没关系.': '选它等于说形式是靠句型定的——可后半句是普通陈述，那个"我"照样换了形式。',
      'me 是"我"，I 是强调一点的"我".': '选它把两者当成语气差别——它们的区别是"在这件事里站在哪"，不是谁更重。',
      '两个词意思不同，me 是被别人看的人，I 是看别人的人.': '选它把临时的位置当成了固定身份——同一个人下一秒换到做事的位置，形式就跟着换。',
    },
    optionTags: {
      'me 用在祈使句，I 用在陈述句，跟位置没关系.': ['other'],
      'me 是"我"，I 是强调一点的"我".': ['other'],
      '两个词意思不同，me 是被别人看的人，I 是看别人的人.': ['case-form-subject'],
    },
    sourceRef: SRC + '1698', contentVersion: 1, reviewStatus: 'draft',
  },
]
