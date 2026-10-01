# 38 号产品交付：O-K115-03 后继课程链课程种子（一次性脚本，幂等可重跑）。
# 顺序约定：B 先插入（rowid 更小）、A 后插入——lessonForObjective 按 rowid DESC 取未完成课时先出 A；
# A 完成后 done 集合跳过 A → 出 B，形成可学的连续推进。
import json

path = 'server/data/v3-lessons.json'
d = json.load(open(path, encoding='utf-8'))
existing = {(l['lessonId'], l.get('version')) for l in d['lessons']}

lessons = [
    {
        "lessonId": "les-claim-limit-c2", "version": 1,
        "title": "新情境检验：博物馆地图的结论",
        "whyNow": "你已经分得清主张、对照和限制了。换一段新材料和任务，检验你能不能在新情境里用同一套判断。",
        "teachingNote": "还是那三步：先找主张，再看 but 之后修正了什么，最后问一句“范围被收窄了吗”。修正的对象不同（地图 vs 预期），结论完全不同。",
        "strategyId": "relation_map",
        "objectiveIds": ["O-K115-03"],
        "difficultyDims": ["claim_limit_separation"],
        "activities": [
            {"activityId": "g4c_claim_limit_slots", "version": 1, "role": "practice",
             "hintStages": ["先找主张：地图到底有没有出故障？", "but 之后说的对象是“地图”还是“团队的预期”？修正的对象不同，结论完全不同。"]},
            {"activityId": "g4c_recap_write", "version": 1, "role": "transfer",
             "hintStages": ["第一句给主张：地图正常工作（没坏）。", "第二句给修正：不完整的是“对访客想要什么的假设”；可以再加一句下一步（比如去问访客）。"]},
        ],
        "nextCandidates": [],
        "sourceRefs": [{"ref": "G4", "claim": "but 连接对照与修正；修正对象决定结论（地图正常、假设不完整）"}],
        "holdoutRef": None,
        "chainNote": "38 号链第 2 节：完成 les-claim-limit-c1 后的连续推进；开发样本，专业核验未做",
    },
    {
        "lessonId": "les-claim-limit-c1", "version": 1,
        "title": "主张、对照和限制：分清再复述",
        "whyNow": "你在关系句上已经有了基础。这一课把“主张—对照—让步—限制”分清楚，再用新材料走一遍完整流程：读→答→说→写→换情境判断。",
        "teachingNote": "限制要靠句子里实际的收窄内容判断（先…再…／只在…／推迟到…），不能靠 but/although 的位置或标点猜；有的句子只是对照两个事实，如实说“没有划范围”也是对的。",
        "strategyId": "shorten_and_recap",
        "objectiveIds": ["O-K115-03"],
        "difficultyDims": ["claim_limit_separation"],
        "activities": [
            {"activityId": "g3c_principle_pick", "version": 1, "role": "practice",
             "hintStages": ["回想：对照＝预期和实际不一样；限制＝真的把范围收窄了。看选项里哪个在说“范围”，哪个只是在说“不一样”。", "“地图坏了／要暂停”都是正文没有的结论；but 之后说的是团队自己的预期不完整——这是对主张的修正，不是划范围。"]},
            {"activityId": "g3c_rehearsal_locate", "version": 1, "role": "practice",
             "hintStages": ["“kept”后面跟的是留下来的；delay／postpone 后面是往后推的。", "限制看“until…”那半句：是先做什么、再决定，还是永久放弃？"]},
            {"activityId": "g3c_paraphrase_recover", "version": 1, "role": "practice",
             "hintStages": ["先把两件事分开：留下来的（手势）和往后推的（语音），各说半句。", "限制那半句可以这样开头：“先……等……之后再……”或 “only after we test it…”——把条件说出来，别把它说成永久放弃。", "可用的词方向：保留 keep／留下；推迟 delay／postpone／缓一缓；条件：先在展厅 exhibition hall／人多的时候试过再定。用这个方向的词再试一次。"]},
            {"activityId": "g3c_write_limit", "version": 1, "role": "practice",
             "hintStages": ["原因在人数：记录里写了语音在什么场合失灵、当时发生了什么。", "结构建议：一句原因（人多／crowded），一句限制（先……再……），一句澄清（不是永久放弃）。"]},
            {"activityId": "g3c_film_transfer", "version": 1, "role": "transfer",
             "hintStages": ["第一句：小房间 vs 大厅——这是预期和实际的不同，没有收窄任何方案的范围。", "第二句：kept 的是视觉序列；postponed 的只是配音测试。范围收窄成“永久放弃”了吗？"]},
        ],
        "nextCandidates": ["les-claim-limit-c2"],
        "sourceRefs": [{"ref": "G3", "claim": "but 对照预期与实际；限制需句中实际收窄内容，位置/标点不是判据"}],
        "holdoutRef": None,
        "chainNote": "38 号链第 1 节：短讲→输入→挑战恢复→输出→迁移的完整后继链；开发样本，专业核验未做",
    },
]

added = 0
for l in lessons:
    if (l["lessonId"], l.get("version")) in existing:
        print("skip existing", l["lessonId"])
        continue
    d["lessons"].append(l)
    added += 1
json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("lessons added:", added, "total:", len(d["lessons"]))
