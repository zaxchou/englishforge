# 单课—讲义映射入库标准 v1

适用已有视频课程资料，不替代题目电子化标准和逐字稿校对规则。

1. 扫描所有子目录。source_file为课程目录下相对路径，保留原文件名，禁止绝对路径/..；已有顶层note id不变，新嵌套资料接在后面。新增/更名后复核note id，不能因排序改动静默串课。
2. 独立讲义：先核对章节号、主题及文件本身，不仅做模糊字符串命中。dedicated展示整份，不代表逐字校对完成。每课链接需指向该文件。
3. 共用PDF：核对正文标题而非TOC。章节号匹配完整N.N，不可只匹配最后.1/.2/.3，不可把Conversation #1误当作#10。记录简短证据及日期。
4. page/end_page均为PDF物理页，从1开始，端点包含。不得拿印刷页码直接使用；上下册页码独立，通过nid区分。不能让下一节页码/起始+5代替明确终点。
5. 页尾出现下个标题时可共用该边界页，范围覆盖前节尾文；这是一种页级窗口，不承诺只有本节内容。跨册用有序segments，每段含nid/page/end_page。
6. 状态：matched正文已对应；dedicated独立或明确共用整份；shared_overview只有概览需显示限制；not_located必须写reason，不能设猜测页码。不对“没有教材”和“尚未读取成功”混用状态。
7. 每条需满足catalog.lesson id存在、nid属于该课程、起止均为整数且在原PDF范围。未匹配项也进入账本，统计区分范围存在和正文已对应。
8. 两份map：web/lesson-handout-map.json运行入口、build/courses/lesson-handout-map.json扫描保留入口，必须同步。PDF文本及页图存build/courses/notes、slide_images；reader-pages.json保存原文件SHA和实际页数。
9. 先验证正文、同页两个小节、下册第一页、跨册、图片版、缺失说明、原PDF链接以及网络重试，再检查桌面/手机画面。所有测试隔离用户记录和外部AI。
10. 教材只读，不把未核查的提取文本标verified。需要变更逐字稿、补题或AI服务时遵循各自规范，本映射扫描不能代替那些工作。

示例：
```json
{"nid":"ndf-07-h1","page":51,"end_page":51,"status":"matched","segments":[{"nid":"ndf-07-h1","page":51,"end_page":51},{"nid":"ndf-07-h2","page":1,"end_page":5}],"evidence":"上下册正文5.3连续页","reviewed_at":"2026-10-12"}
```
