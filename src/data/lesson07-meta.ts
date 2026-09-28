import type { Lesson } from '../types'

/** 第 7 课「英语是直线型思维」—— 10 个思维点 + 微课卡（内容忠于张老师课稿逻辑） */
export const lesson07: Lesson = {
  id: 'l07',
  no: '07',
  title: '英语是直线型思维',
  subtitle: '一个含义对应一个形式——整套体系的根源思维',
  skills: [
    {
      id: 's1',
      name: '单复数是两个词',
      tagline: 'book 和 books 不是同一个词',
      icon: '📚',
      concept: {
        title: 'book 和 books，是两个不同的词',
        body: [
          '中文里"书"这个字，一本能说，十本也能说，写法永远不变。',
          '但老外的脑子是直线型的：一本书是 book，两本书含义变了，就必须换一个形式——books。',
          '所以 books 不是"book 加了个 s"，它就是另一个词。所有词形变化，都是为了区分含义。',
          '进阶题里还会练到 babies、knives 这些变法——别死背拼写，老外改拼写是为了"念得顺"（第 9 课展开）。',
        ],
        example: 'I have a book. → I have two books.',
        exampleNote: '一本 → 多本：含义变了，形式必须变。这就是直线型思维。',
      },
    },
    {
      id: 's1p',
      name: '复数拼写跟着发音走',
      tagline: '为什么是 boxes 不是 boxs',
      icon: '🔤',
      concept: {
        title: '来同学们，拼写变来变去，是为了"念得顺"',
        body: [
          '先分清两件事：book→books 是"含义变了"（第 1 课），而 box→boxes 的 es 是"为了发音"——舌头能顺下来。',
          's/x/ch/sh 结尾加 es、辅音+y 变 ies、f 变 ves、双写再加——全都是发音需求，不是要背的规则表。',
          '张老师的话：词形变化的根源是发音（第 9 课展开讲）。懂了"为什么变"，拼写根本不用死记。',
        ],
        example: 'box→boxes / baby→babies / knife→knives / hot→hotter',
        exampleNote: '一个道理：怎么念得顺，就怎么写。',
      },
    },
    {
      id: 's2',
      name: '主格宾格：两个人',
      tagline: '做动作的人爽，挨动作的人疼',
      icon: '🥊',
      concept: {
        title: '我打他 / 他打我——做的人和挨的人不是同一个人',
        body: [
          '"我打他"和"他打我"，中文三个字颠来倒去都一样。',
          '英语不行：打人的是动作主体（主格 I / he），挨打的是动作对象（宾格 me / him）。',
          '张老师的说法：一个是感觉爽的，一个是感觉疼的——两个不同的人，形式必须区分开。',
        ],
        example: 'I beat him. ↔ He beats me.',
        exampleNote: '谁做动作用主格，谁挨动作用宾格——一听就知道谁爽谁疼。',
      },
    },
    {
      id: 's3',
      name: 'my / mine：被省略的那个词',
      tagline: 'mine = my + 上文说过的东西',
      icon: '🎒',
      concept: {
        title: 'yours 不是"你的"，是"你的某某某"',
        body: [
          'my book 是"我的书"，mine 也是"我的书"——区别在哪？',
          'mine = my + book：那个 book 上文已经说过，被省略掉了，s 代替了它。',
          '所以 my 后面必须跟名词；名词被省略时，才轮到 mine 登场。含义不同，形式就不同。',
        ],
        example: 'This is my book. / That book is mine.',
        exampleNote: 'mine 拆开就是 my book——"我的（那个东西）"。',
      },
    },
    {
      id: 's4',
      name: '三单：含义不同',
      tagline: '我喜欢 ≠ 他喜欢',
      icon: '👍',
      concept: {
        title: 'like 和 likes 是两个词',
        body: [
          '来同学们，I like apples，他喜欢就得说 He likes apples。',
          'likes 不是 like 加了个 s——"我喜欢"和"他喜欢"是两种含义，就要用两个词。',
          'I likes apples = "我他喜欢苹果"，逻辑错乱，老外一听就皱眉。不用背"三单规则"，含义对了形式就对。',
        ],
        example: 'I like apples. / He likes apples.',
        exampleNote: '谁喜欢，决定用哪个词——含义决定一切。',
      },
    },
    {
      id: 's5',
      name: '「是」是三个词',
      tagline: '曾是 / 是 / 将是',
      icon: '⏳',
      concept: {
        title: 'was、am、will be 是三个不同的词',
        body: [
          '先看个怪事：中文的"是"昨天今天明天都不变，但英语里这是三个完全不同的词。',
          'was = 曾经是，am = 现在是，will be = 将是——时间含义不同，形式必须不同。',
          '别把它们当成"be 动词的三种变化"，那样又掉回死记硬背了。',
        ],
        example: 'I was a teacher. / I am a doctor. / I will be a star.',
        exampleNote: '想说哪个时间的事，就用对应那个词——张嘴就来。',
      },
    },
    {
      id: 's6',
      name: '一横 vs 两个词',
      tagline: 'one 是数量，first 是顺序',
      icon: '🥇',
      concept: {
        title: 'one 和 first，中文都写"一"，英语是两个词',
        body: [
          '"我有一本书"和"我是第一名"，中文都有个"一"，一横就搞定。',
          '英语不接受：数量的一是 one，顺序的一是 first——含义不同，形式必须不同。',
          'one two three 叫基数词，first second third 叫序数词，本质就是数量与顺序之分。',
        ],
        example: 'I have one book. / I am the first.',
        exampleNote: '强调数量用 one，强调名次用 first。',
      },
    },
    {
      id: 's7',
      name: '修饰谁：slow / slowly',
      tagline: '修饰动作用 -ly，修饰主体用原形',
      icon: '🐢',
      concept: {
        title: 'slow 和 slowly，一个修饰"他"，一个修饰"跑"',
        body: [
          '"他很慢"：慢修饰的是他这个人 → He is slow（形容词）。',
          '"他跑得慢"：慢修饰的是跑这个动作 → He runs slowly（副词）。',
          '中文都是"慢"字，但修饰的对象含义不同——英语必须分成两个词。',
        ],
        example: 'He is slow. / He runs slowly.',
        exampleNote: '先问自己：这个"慢"在说人，还是在说动作？',
      },
    },
    {
      id: 's8',
      name: '-er = 更，-est = 最',
      tagline: '高 / 更高 / 最高，三个含义三个形式',
      icon: '📏',
      concept: {
        title: 'tall、taller、tallest 是三个词',
        body: [
          '"我很高"是 tall，"他更高"就得换 taller，"你最高"是 the tallest。',
          '-er 就是"更"，-est 就是"最"——后缀本身带着含义。',
          '中文一个"高"字包打天下，英语要把三种含义分得清清楚楚。',
        ],
        example: 'I am tall. / He is taller. / You are the tallest.',
        exampleNote: '看到 -er 想到"更"，看到 -est 想到"最"。',
      },
    },
    {
      id: 's9',
      name: 'do 的四张脸',
      tagline: '做 / 一件事 / 去做 / 已经做',
      icon: '🎭',
      concept: {
        title: 'do、doing、to do、done，四种含义四种形式',
        body: [
          'do 是做这个动作，doing 是把动作变成"一件事"，to do 是去做（to 就是个箭头），done 是已经做了——四张脸，四种含义。',
          '我喜欢做作业：喜欢的是"做作业这件事" → like doing homework。',
          '古英语里"正在做"和"做这件事"本来长得不一样（-ende / -ung），后来被人为混成了一个 doing——所以偶尔需要辨析。',
        ],
        example: 'I do homework. / I like doing homework. / I want to do homework. / I have done it.',
        exampleNote: '含义需要哪种"做"，就用哪张脸。',
      },
    },
    {
      id: 's10',
      name: '直线型思维 · 综合',
      tagline: '把所有形式变化串成一句话',
      icon: '🧠',
      concept: {
        title: '一个含义对应一个形式',
        body: [
          '单复数、主宾格、三单、was/am/will be、one/first、slow/slowly、-er/-est、do 四张脸……全是同一件事。',
          '中文一个字能"悟"出来的含义，英语必须用不同的形式摆在你面前，一听就懂，不需要悟。',
          '以后只要看到词形变化，就问一句：它在区分什么含义？——这就是英语的根源思维。',
        ],
        example: '含义不同 → 形式必不同；形式不同 → 含义必不同。',
        exampleNote: '这句话就是整套课的第一性原理。',
      },
    },
  ],
}
