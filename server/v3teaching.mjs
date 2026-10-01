/** Teaching layer, separate from grading. Teacher framework is interpreted, not quoted as linguistic law. */
const base = { version: 1, provenance: '沿用张俊杰课程的含义、主线、组合和简单原则；下面的例子是本课程另写的演示。', sourceLessons: ['第12课：简单句', '第15课：复合句', '第18课：简单原则'] }
const guides = {
  relation: {
    title: '先把事情说清，再补上关系', outcome: '这次练：说清谁做了什么、哪些决定仍有条件，再换一个场景试着说明。',
    principle: '不要先找一个连接词套规则。先确认你要表达的几件事：谁做什么，哪件事解释另一件，哪句话改变了范围。长句是在一条主线上接信息，不是同时记住所有词。',
    example: ['The team kept the sketches.', 'The team postponed the animation test.', 'The team kept the sketches, but postponed the animation test until the software was ready.'],
    moves: ['先保留两件完整的事：留下草图；推迟动画测试。', '用 but 表达这两种处理的对照；重复的主体可以合并。', 'until 补充推迟到什么时候。它没有说动画永远不做。'],
    contrast: '如果只是并列两件事，可用 and；是否有条件取决于具体意思，不是看见 but 就一定有“限制”。',
    carry: '先说你的决定，再补为什么或什么条件下成立。不必为了显得高级把句子拉长。',
  },
  modifier: {
    title: '先立主线，再把信息挂到对象上', outcome: '看清修饰说明的是哪一个对象，还是已经明确对象的补充信息。',
    principle: '先读出主体和事件，再问多出来的信息是在选“哪一个”，还是给已确定的人或物补充情况。长修饰可以占很多词，但主线没有因此变成很多件事。',
    example: ['The designer shared a sketch.', 'The sketch shows the entrance.', 'The designer shared a sketch that shows the entrance.'],
    moves: ['主线仍是设计师分享草图，不要在 that 处丢掉前面的事件。', 'that shows the entrance 接到 sketch，说明这份草图的内容。', '对比 My tutor, who lives nearby, called：补充住得近，主体仍是已明确的导师。'],
    contrast: '删去信息后对象是否改变，是理解线索；逗号、指称语境和说话者已知信息也要一起看，不能只用删除法机械判所有句子。',
    carry: '介绍一个作品时先说作品做什么，再补一个必要特征；读长句时把补充信息接回它说明的对象。',
  },
  listening: {
    title: '让声音里的信息按顺序接起来', outcome: '先听出整体事件，再逐步跟上对照、原因和条件。',
    principle: '听的时候先保住正在讲的那件事。没认出一个词，可以暂时留空，继续听后面的信息。看稿是帮助你把声音和已有意思接起来，不等于已经能在无稿时听懂。',
    example: ['We tried the new lights.', 'They looked clear indoors.', 'We tried the new lights. They looked clear indoors, but the labels were hard to read outside.'],
    moves: ['第一遍抓对象和事件：试新灯。不要为每个词停下来翻译。', '再抓两种环境的结果：室内清楚，室外标签难读。', '卡住后分段看稿，再关稿重听；换一段声音才检验能不能继续跟上。'],
    contrast: '结论不一定在最后；but 前后也不一定是预期与实际。依这段话的事件和意思判断，不背位置口诀。',
    carry: '真的没听清时，用 Do you mean…? 确认一个关键点；理解交流可以包含澄清，不要求一次听清每个词。',
  },
  speaking: {
    title: '先有要说的意思，再长出句子', outcome: '用自己的话给出决定和理由，并接住对方新增的信息。',
    principle: '输出不需要先找一个很复杂的句型。先说你想做什么，再说为什么，需要时加条件。对方追问后，把新的信息接到原来的安排里；简短但清楚的表达就是有效表达。',
    example: ['We will meet online.', 'The studio is closed today.', 'We will meet online because the studio is closed. If someone cannot join, we can share notes.'],
    moves: ['第一句先给安排：线上见。', '因为场地关闭，接一个理由。需要时拆成两个短句也可以。', '如果有人不能参加，补另一安排；回应追问不必从头复述整段。'],
    contrast: '先问对方真正担心什么，再回应。不是每次都必须按“决定→原因→条件”的固定模板说。',
    carry: '把演示换成你真实项目的一件决定。说一句清楚的话，再按交流需要加信息，不用背本页例句。',
  },
}
export function teachingGuide(lesson) {
  if (!lesson) return null
  let key = null
  const id = lesson.lessonId
  if (id === 'les-relations-v1' || id?.startsWith('les-claim-limit')) key = 'relation'
  else if (id === 'les-modifier-m1' || id === 'les-disposable-v1') key = 'modifier'
  else if (id?.startsWith('les-listening-')) key = 'listening'
  else if (id?.startsWith('les-oral-')) key = 'speaking'
  return key ? { ...base, ...guides[key] } : null
}
