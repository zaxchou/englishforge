import type { Lesson } from '../types'

/** 第 10 课「动词不只是动作」—— 6 个思维点（M1 第一课：造句的发动机） */
export const lesson10: Lesson = {
  id: 'l10',
  no: '10',
  title: '动词不只是动作',
  subtitle: 'verb 无法翻译——主要动词与辅助动词的全景图',
  skills: [
    {
      id: 't10s1',
      name: '状态也是动词',
      tagline: '实义动词 vs 系动词',
      icon: '⚙️',
      concept: {
        title: '动词不一定"动"——状态也是动词',
        body: [
          '中文的"动词"两个字把人坑了：好像动词就得有动作。英语的 verb 不是动作，是"谓语的核心"。',
          '所以动词分两大家族：实义动词（吃喝跑跳，真的在动）和联系动词（连接主体和状态：I am happy，am 没动，但它把"我"和"开心"连起来了）。',
          '简单句里好用的判断法：后面接的是"主体怎么样了"（表语）→ 系动词；后面跟的是"对象"→ 实义动词。注意边界：没有动作 ≠ 一定是系动词——I know him、I have a book 也没动作，但 know/have 后面跟的是对象，它们是实义动词。',
        ],
        example: 'I eat an apple.（实义）/ I am happy.（系动词连接状态）',
        exampleNote: '一个讲动作，一个讲状态——都是动词，含义不同。',
      },
    },
    {
      id: 't10s2',
      name: '六类系动词',
      tagline: 'be/感官/变化/保持/似乎/结果',
      icon: '🎪',
      concept: {
        title: '系动词大家族一共六类',
        body: [
          '别以为系动词只有 be：五官感受（look sound smell taste feel）、状态变化（get turn go come）、保持（keep remain stay）、似乎（seem appear）、结果证明（prove turn out）——全是系动词。',
          '张老师的记法：它们后面接的都是"状态"——看起来干净、变疯了、保持饥饿、似乎很好、结果是对的。',
          '记住那句名言：stay hungry, stay foolish——stay 就是系动词。',
        ],
        example: 'the blackboard looks clean / go mad / stay hungry / it seems good / prove right',
        exampleNote: '后面接状态，就是系动词——含义判断，不用背表。',
      },
    },
    {
      id: 't10s3',
      name: '加不加宾语由含义定',
      tagline: '及物 vs 不及物，别背概念',
      icon: '🧩',
      concept: {
        title: '及物/不及物？先别背，看含义完不完整',
        body: [
          '"我吃。"——通顺吗？通顺。"我吃苹果。"——也通顺。到底加不加东西？',
          '张老师：能直接把话说完整的，就是不及物用法；含义需要后面跟个"对象"才完整的，就是及物用法。',
          '同一个动词可以两边站：I sing.（我唱歌，完整）/ I sing a song.（加了对象，也对）——含义决定它当哪边用。',
        ],
        example: 'I eat.（不及物）/ I eat an apple.（及物）/ sing. / sing a song.',
        exampleNote: '句意完整吗？需要对象吗？——从含义上判断，不是查词典。',
      },
    },
    {
      id: 't10s4',
      name: '瞬间 vs 延续',
      tagline: 'begin 不能"半小时"，eat 可以',
      icon: '⏱️',
      concept: {
        title: '一眨眼完成的动作，撑不起"半小时"',
        body: [
          '动词还能按"能持续多久"分：begin/come/go/arrive 是一瞬间的——电影开始，就是从广告切到片头那一秒。',
          '所以"电影开始了半小时"不能用 begin——那一秒怎么撑半小时？换成能延续的：The film has been on for half an hour.',
          '吃、跑、游可以延续：I have eaten for half an hour 完全没问题。语法错误的根源常常是含义矛盾。',
        ],
        example: 'The film has begun for half an hour.（✗ 撑不住）→ has been on for half an hour.（✓）/ We are beginning to understand.（✓ begin 进行时本身可用）',
        exampleNote: '真正撑不住的是"瞬间动词 + for 时间段"这类搭配，不是"begin 不许用进行时"——语法错误的根源常常是含义矛盾。',
      },
    },
    {
      id: 't10s5',
      name: '情态动词 = 态度强度',
      tagline: '同场景内：can < may < must < mustn\'t',
      icon: '🗣️',
      concept: {
        title: '情态动词不是语法，是"说话的态度"',
        body: [
          'May I come in? —— 你迟到了站在门口，这句话的语气是"请求"；老师说 You may come in，是"允许"；You must come in，是"催促"；You mustn\'t come in，是"禁止"。',
          '同一件事，态度强度不同，用的词就不同——这就是情态动词的本质：给动词加上情感态度。',
          '同一场景内强度排队：can/could（能）< may（可以）< must（必须）< mustn\'t（禁止）——注意这是语境内的相对值；may not 也能表"不允许"，比 mustn\'t 缓和。',
        ],
        example: 'You may come in. / You must come in. / You mustn\'t come in.',
        exampleNote: '给主要动词配"情绪"——态度不同，词就不同。',
      },
    },
    {
      id: 't10s6',
      name: '助动词是时间的记号',
      tagline: 'don\'t vs didn\'t：时间含义藏在助动词里',
      icon: '🧰',
      concept: {
        title: '助动词没有"意思"？不，它表达时间',
        body: [
          'do 在 I don\'t know 和 I didn\'t know 里翻译不出东西——但它变了形，含义就变了：现在不知道 vs 曾经不知道。',
          '所有词必须有意义：助动词的意义就是时间——be doing 正在做、have done 已经做、do/did 现在/过去。',
          '助动词的两个工作：1) 帮主要动词搭时态语态（be doing / be done / have done）；2) 变否定变疑问（don\'t/didn\'t/do you）。',
        ],
        example: 'I don\'t know.（现在）/ I didn\'t know.（曾经）',
        exampleNote: '看到助动词的形，就读出时间的含义。',
      },
    },
  ],
}
