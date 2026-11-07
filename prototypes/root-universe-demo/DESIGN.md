# 词根宇宙：可操作效果演示

用户任务：查一个词，理解它和兄弟姐妹的关系，再通过一小组辨析把关系记住。2026-11-06 用户要求用 oil-ui-pro 做几个 demo，先感知最终交付效果。

范围：三种真实操作场景，共用一套产品视觉，不做三套风格。独立 prototypes/root-universe-demo/，不覆盖后台正在开发的 root-universe/；不接生产数据、不提交、不部署。查询和图谱仅覆盖内嵌小词集，练习只在本次页面内运行，不记入正式进度。真实正式词典的来源独立复核仍由原工作流完成，不冒称本演示已通过该流程。

视觉：沿用 TOEFL Lab 石墨侧栏、浅冷灰外底、白色圆角画布和墨绿主动作；单词与内容优先，来源按需打开。桌面：固定侧栏+内容画布；手机：对齐的一行品牌+本地三场景导航，保留上下均衡留白。桌面/390/320核对，不用压小字号解决拥挤。

三个场景：
1. 查词：搜索→选词→构词成分→同族词→来源。默认 unpredictable；空搜索给匹配，未知词明确未收录。来源为 Wiktionary 已读取条目的短事实，中文是译文。
2. 词族：以 predict 或 photosynthesis 为中心，显示一两层带类型的关系，点词换中心、沿路径返回，当前词说明跟随更新。现代构词与历史溯源区别显示；对历史链的简写注明中间形式。
3. 串联练习：同族词的含义/词性/句中选择三题，选答案后原位解释，主动下一题；结果仅表示本轮完成，不声称全词族掌握；重练和回看词族可用。

三者是同一方向的互补体验，不是设计候选。无现存正式词根查询流程可作点击数基线；此处是用户可试走的目标路径。练习例句为本演示原创，不取考试题库。

内容依据：
- https://en.wiktionary.org/wiki/predict （Latin praedicō，prae- 与 dīcō）
- https://en.wiktionary.org/wiki/predictable （predict + -able）
- https://en.wiktionary.org/wiki/unpredictable （un- + predictable）
- https://en.wiktionary.org/wiki/prediction （现代 predict + -ion；历史上 Latin praedictiō 借词）
- https://en.wiktionary.org/wiki/dictate （经 Latin dictō 等形式追溯到 dīcō）
- https://en.wiktionary.org/wiki/photosynthesis （photo- + synthesis）
- https://en.wiktionary.org/wiki/photo- （light；相关词列表 photograph、photophobia 等）

当前只在主agent自检范围验证，不另启子agent以遵守一次一个子agent的约束。截图、交互检查与退出码放 build/qa/root-universe-demo/。如有独立审查后续再准确记录，不能先写通过。
