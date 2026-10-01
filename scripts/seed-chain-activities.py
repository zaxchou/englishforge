# 38 号产品交付：O-K115-03 后继课程链活动种子（一次性脚本，幂等可重跑）
import json

path = 'server/data/v3-activities.json'
d = json.load(open(path, encoding='utf-8'))
existing = {a['activityId'] for a in d['activities']}

COND = ["firstExposure", "hintLevel", "transcriptShown", "playCount", "lookupUsed", "responseMode"]

def rel(id, label, anyOf, required=True, oids=('O-K115-03',)):
    return {"id": id, "label": label, "anyOf": anyOf, "required": required, "objectiveIds": list(oids)}

def mn(label, anyOf, oids=None):
    m = {"label": label, "anyOf": anyOf}
    if oids:
        m["objectiveIds"] = list(oids)
    return m

def slot(slotId, prompt, options, accept, oids=('O-K115-03',)):
    return {"slotId": slotId, "prompt": prompt, "options": options, "accept": accept, "objectiveIds": list(oids)}

acts = []

# ---- A1 精华短讲 + 原理确认（封闭槽位；主张/对照/让步/限制的区别，禁位置口诀）
acts.append({
    "activityId": "g3c_principle_pick", "version": 1, "role": "practice",
    "taskFamilyId": "claim_limit_principle_g3c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "reading"},
    "responseKind": "text",
    "servesStrategies": ["shorten_and_recap", "relation_map"],
    "prompt": "\n".join([
        "先分清四件事，再用自己的话复述（本课 30 秒短讲）：",
        "· 主张：说话人想让你记住的那件事，比如“我们保留了手势控制”。",
        "· 对照：事情和预期不一样，比如“原以为安静的房间里好用，人多就失灵了”。对照只是在说预期和实际不同，不等于给方案划范围。",
        "· 让步：先承认对方说的有道理（“你说得对，地图确实没坏”），再往下说自己的话。让步也不是认输，更不等于收窄。",
        "· 限制：真的把范围收窄的条件，比如“只在展厅先试，试完再决定”。判断限制要靠句子里实际的收窄内容（先…再…／只在…／推迟到…），不能靠 but/although 出现没出现或标点位置猜。",
        "关键：but/although 后面不一定是限制——有的句子只是对照两个事实，没有收窄任何范围；这时如实说“这句话没有划范围／信息不足”，也是正确回答。",
        "",
        "读这句：The map was working as designed, but our assumption about what visitors wanted was incomplete.",
        "逐空选择（全对才算过）。",
    ]),
    "hints": [
        "回想：对照＝预期和实际不一样；限制＝真的把范围收窄了。看选项里哪个在说“范围”，哪个只是在说“不一样”。",
        "“地图坏了／要暂停”都是正文没有的结论；but 之后说的是团队自己的预期不完整——这是对主张的修正，不是划范围。",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["对照与限制的分辨"],
        "slots": [
            slot("but_after", "but 之后说的是什么？", ["设计方案出故障了", "团队对访客想要什么的预期不完整", "要暂停地图功能"], "团队对访客想要什么的预期不完整"),
            slot("when_limit", "什么时候才能说一句话给出了“限制”？", ["只要 but/although 出现了", "句子里有实际收窄范围的内容（比如“只在…先试”）", "逗号后面的内容就是限制"], "句子里有实际收窄范围的内容（比如“只在…先试”）"),
        ],
        "mustNotNegationGuard": True,
        "unmeasuredObjectives": [],
    },
    "complexityBand": 4,
    "certification": "closed",
})

# ---- A2 排练段输入（封闭槽位 + 理由；mat_g3_rehearsal）
acts.append({
    "activityId": "g3c_rehearsal_locate", "version": 1, "role": "practice",
    "taskFamilyId": "rehearsal_claim_limit_g3c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "reading"},
    "responseKind": "text",
    "servesStrategies": ["shorten_and_recap"],
    "materialId": "mat_g3_contrast_texts",
    "segmentIds": ["mat_g3_rehearsal"],
    "referenceAnswer": "团队保留了手势控制；语音控制被推迟——限制是先在展厅实测、再决定，不是语音方案被永久放弃。",
    "supportingQuotes": [
        "We kept the gesture controls, but we delayed voice control until we could test it with visitors in the exhibition hall.",
    ],
    "prompt": "读右边材料框里的排练记录，逐空选择；最后在理由栏用一句话说出你的依据（自己的话）。",
    "hints": [
        "“kept”后面跟的是留下来的；delay／postpone 后面是往后推的。",
        "限制看“until…”那半句：是先做什么、再决定，还是永久放弃？",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["保留的决定", "推迟的对象", "限制的条件", "理由"],
        "slots": [
            slot("kept", "团队最终保留了哪种控制方式？", ["手势控制", "语音控制", "两种都推迟"], "手势控制"),
            slot("delayed", "被推迟的是什么？", ["语音控制", "手势控制", "整个项目"], "语音控制"),
            slot("limit", "推迟的条件（限制）是什么？", ["先在展厅实测、再决定", "语音方案永久放弃", "观众不喜欢语音"], "先在展厅实测、再决定"),
        ],
        "reason": {
            "relations": [
                rel("r_kept", "说清保留了什么", ["kept", "保留", "留下", "手势", "gesture"]),
                rel("r_delay", "说清推迟了什么", ["delay", "推迟", "postpone", "延后", "暂缓", "语音", "voice"]),
                rel("r_limit", "说清限制是“先…再…”而不是永久", ["until", "先", "展厅", "试", "exhibition", "再决定", "等"]),
            ],
            "mustNot": [mn("把限制说成永久放弃", ["永久放弃", "永久取消", "never use", "彻底不要"])],
        },
        "mustNotNegationGuard": True,
        "unmeasuredObjectives": [],
    },
    "complexityBand": 4,
    "certification": "closed",
})

# ---- A3 挑战与恢复（开放复述；三层提示给可用词族=恢复路径；mustNot 挡照抄）
acts.append({
    "activityId": "g3c_paraphrase_recover", "version": 1, "role": "practice",
    "taskFamilyId": "rehearsal_paraphrase_g3c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "reading"},
    "responseKind": "text",
    "servesStrategies": ["shorten_and_recap"],
    "materialId": "mat_g3_contrast_texts",
    "segmentIds": ["mat_g3_rehearsal"],
    "referenceAnswer": "我们留下了手势控制，语音先缓一缓——等在展厅让人多的时候试过再决定，不是语音不行。",
    "supportingQuotes": [
        "We kept the gesture controls, but we delayed voice control until we could test it with visitors in the exhibition hall.",
    ],
    "prompt": "用一句自己的话（中文或英文，别照抄原文）说清排练记录里的决定：保留了什么、推迟了什么、限制是什么。第一次没说全没关系——看提示再试，提示会给可用的说法方向。",
    "hints": [
        "先把两件事分开：留下来的（手势）和往后推的（语音），各说半句。",
        "限制那半句可以这样开头：“先……等……之后再……”或 “only after we test it…”——把条件说出来，别把它说成永久放弃。",
        "可用的词方向：保留 keep／留下；推迟 delay／postpone／缓一缓；条件：先在展厅 exhibition hall／人多的时候试过再定。用这个方向的词再试一次。",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["保留", "推迟", "限制条件"],
        "relations": [
            rel("kept", "说清保留（手势）", ["kept", "保留", "留下", "手势", "gesture"]),
            rel("delayed", "说清推迟（语音）", ["delay", "推迟", "postpone", "延后", "暂缓", "缓", "语音", "voice"]),
            rel("limit", "说清限制条件（先试再定）", ["until", "先", "展厅", "试", "exhibition", "test", "再", "等", "hall"]),
        ],
        "mustNot": [
            mn("照抄了原句（要用你自己的话）", ["we kept the gesture controls", "we delayed voice control until we could test it"]),
            mn("把限制说成永久放弃", ["永久放弃", "永久取消", "never use"]),
        ],
    },
    "complexityBand": 4,
})

# ---- A4 实际输出·短写作（writing 技能如实标注；反馈=练习建议）
acts.append({
    "activityId": "g3c_write_limit", "version": 1, "role": "practice",
    "taskFamilyId": "rehearsal_write_g3c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "writing"},
    "responseKind": "text",
    "servesStrategies": ["shorten_and_recap"],
    "materialId": "mat_g3_contrast_texts",
    "segmentIds": ["mat_g3_rehearsal"],
    "referenceAnswer": "语音控制当时失灵，是因为好几个观众同时说话；所以我们把它推迟到展厅实测之后再定。限制是“先测再定”，不代表语音方案不行。",
    "supportingQuotes": [
        "The voice prototype that worked well in a quiet studio failed during a crowded exhibition, where several groups were speaking at once.",
    ],
    "prompt": "小写作（2–3 句，写你自己的话，别抄原句）：向没读过记录的新队员解释这次决定——为什么推迟语音、限制是什么、它为什么不是“语音不行”。中英文都行。（这是写作练习：反馈是练习建议，不计入能力记录。）",
    "hints": [
        "原因在人数：记录里写了语音在什么场合失灵、当时发生了什么。",
        "结构建议：一句原因（人多／crowded），一句限制（先……再……），一句澄清（不是永久放弃）。",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["失灵原因", "限制条件", "澄清"],
        "relations": [
            rel("cause", "说清失灵原因（人多／吵）", ["crowded", "人多", "吵", "noise", "several groups", "同时", "许多人"]),
            rel("limit", "说清限制（先测再定）", ["until", "先", "试", "test", "再", "展厅", "exhibition", "等"]),
            rel("clarify", "澄清不是语音不行／不是永久放弃", ["不是", "不代表", "不等于", "not permanent", "没放弃", "没有放弃", "还是可以", "再定", "再决定"], required=False),
        ],
        "mustNot": [
            mn("照抄了原句", ["failed during a crowded exhibition, where several groups were speaking"]),
            mn("说成永久取消语音", ["永久取消", "永久放弃", "cancelled forever"]),
        ],
    },
    "complexityBand": 4,
})

# ---- A5 新情境迁移·放映段（换材料+换任务形状：判断句子在做什么）
acts.append({
    "activityId": "g3c_film_transfer", "version": 1, "role": "transfer",
    "taskFamilyId": "film_judge_g3c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "reading"},
    "responseKind": "text",
    "servesStrategies": ["relation_map", "shorten_and_recap"],
    "materialId": "mat_g3_contrast_texts",
    "segmentIds": ["mat_g3_film"],
    "referenceAnswer": "第一句是对照：小房间印象好、大厅难跟上——预期和实际不同。第二句的限制是只推迟配音测试，影片和视觉序列都保留。",
    "supportingQuotes": [
        "The film that impressed us in the small screening room was hard to follow in the noisy lobby.",
        "We kept the visual sequence but postponed the voice-over test.",
    ],
    "prompt": "换了一段新材料（放映与配音）。逐空判断下面的说法，最后在理由栏用一句话写出你的依据。这次的任务和前面不同：不是找信息，是判断每句话在做什么。",
    "hints": [
        "第一句：小房间 vs 大厅——这是预期和实际的不同，没有收窄任何方案的范围。",
        "第二句：kept 的是视觉序列；postponed 的只是配音测试。范围收窄成“永久放弃”了吗？",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["句1性质", "句2限制", "理由"],
        "slots": [
            slot("s1_nature", "「The film … was hard to follow in the noisy lobby.」这句话在做什么？", ["宣布影片质量下降、不再使用", "对照预期和实际（小房间好用、大厅难跟上）", "给出未来计划"], "对照预期和实际（小房间好用、大厅难跟上）"),
            slot("s2_limit", "「We kept the visual sequence but postponed the voice-over test.」的限制是什么？", ["视觉序列被放弃", "只是推迟配音测试——不是影片不行", "大厅永远不用这部影片"], "只是推迟配音测试——不是影片不行"),
        ],
        "reason": {
            "relations": [
                rel("r_contrast", "说清第 1 句只是对照", ["对照", "不同", "反而", "预期", "实际", "contrast"]),
                rel("r_notquit", "说清第 2 句的限制不是放弃", ["推迟", "postponed", "只是", "先", "不是放弃", "保留", "kept"]),
            ],
            "mustNot": [mn("把对照／推迟说成永久放弃", ["永久放弃", "弃用", "abandoned", "不再使用"])],
        },
        "mustNotNegationGuard": True,
        "unmeasuredObjectives": [],
    },
    "complexityBand": 4,
    "certification": "closed",
})

# ---- B1 新情境检验·博物馆地图（换材料；主张 vs 修正）
acts.append({
    "activityId": "g4c_claim_limit_slots", "version": 1, "role": "practice",
    "taskFamilyId": "museum_claim_limit_g4c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "reading"},
    "responseKind": "text",
    "servesStrategies": ["relation_map"],
    "materialId": "mat_g4_discourse_markers",
    "segmentIds": ["mat_g4_museum_map"],
    "referenceAnswer": "主张：地图按设计正常工作。but 之后修正的是团队对访客想要什么的预期——地图没坏，是我们的假设不完整。",
    "supportingQuotes": [
        "The map was working as designed, but our assumption about what visitors wanted was incomplete.",
    ],
    "prompt": "新情境：博物馆地图段。逐空选择，最后在理由栏用一句话说出你的依据。",
    "hints": [
        "先找主张：地图到底有没有出故障？",
        "but 之后说的对象是“地图”还是“团队的预期”？修正的对象不同，结论完全不同。",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["主张", "修正对象", "理由"],
        "slots": [
            slot("claim", "团队的主张是什么？", ["地图按设计正常工作", "地图经常出故障", "访客讨厌地图"], "地图按设计正常工作"),
            slot("correction", "but 之后修正的是什么？", ["地图的设计", "团队对访客想要什么的预期", "访客的行为"], "团队对访客想要什么的预期"),
        ],
        "reason": {
            "relations": [
                rel("r_claim", "说清主张（按设计工作）", ["designed", "正常", "按设计", "没坏", "working"]),
                rel("r_fix", "说清修正的是预期／假设", ["assumption", "预期", "假设", "想法", "incomplete", "不完整"]),
            ],
            "mustNot": [mn("把修正说成地图故障", ["地图故障", "地图坏了", "map broken"])],
        },
        "mustNotNegationGuard": True,
        "unmeasuredObjectives": [],
    },
    "complexityBand": 4,
    "certification": "closed",
})

# ---- B2 复述输出（transfer·writing；换任务形状=完整复述+下一步）
acts.append({
    "activityId": "g4c_recap_write", "version": 1, "role": "transfer",
    "taskFamilyId": "museum_recap_write_g4c",
    "objectiveIds": ["O-K115-03"],
    "skillByObjective": {"O-K115-03": "writing"},
    "responseKind": "text",
    "servesStrategies": ["relation_map", "shorten_and_recap"],
    "materialId": "mat_g4_discourse_markers",
    "segmentIds": ["mat_g4_museum_map"],
    "referenceAnswer": "地图一直按设计在运行；但它只反映繁忙程度。有些访客反而走向拥挤展室，所以我们关于访客想要什么的假设是不完整的——下一步应该去问访客。",
    "supportingQuotes": [
        "The map was working as designed, but our assumption about what visitors wanted was incomplete.",
    ],
    "prompt": "用两三句你自己的话（中英文都行，别照抄原句）向新队员复述博物馆地图的结论：先说主张，再说 but 之后修正了什么；不要把修正说成地图失败。（写作练习：反馈是练习建议，不计入能力记录。）",
    "hints": [
        "第一句给主张：地图正常工作（没坏）。",
        "第二句给修正：不完整的是“对访客想要什么的假设”；可以再加一句下一步（比如去问访客）。",
    ],
    "conditionsSpec": COND,
    "evaluationContract": {
        "dimensions": ["主张", "修正", "下一步"],
        "relations": [
            rel("claim", "说清主张（地图正常）", ["designed", "正常", "没坏", "working", "按设计"]),
            rel("fix", "说清修正（假设不完整）", ["assumption", "预期", "假设", "incomplete", "不完整", "想法"]),
            rel("next", "给出下一步／建议", ["ask", "问", "why", "为什么", "下一步", "接下来", "访客"], required=False),
        ],
        "mustNot": [
            mn("照抄了原句", ["the map was working as designed, but our assumption"]),
            mn("把修正说成地图失败", ["地图失败", "map failed", "地图坏了"]),
        ],
    },
    "complexityBand": 4,
})

added = 0
for a in acts:
    if a["activityId"] in existing:
        print("skip existing", a["activityId"])
        continue
    d["activities"].append(a)
    added += 1
json.dump(d, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("activities added:", added, "total:", len(d["activities"]))
