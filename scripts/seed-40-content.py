# 40 号批内容种子（一次性脚本，幂等）：
# ① 短讲校订：用具体句子讲、不写普遍定义；"推迟到展厅测试"（原文）与"测后再决定"（推断）分开 → 活动升版 v2
# ② 全链活动补 revealFollowup（提交后揭晓的开放追问）→ 一并升版 v2（内容变更=升版）
# ③ 新增 O-K115-01 前沿课 les-modifier-m1（补真实推荐会落到的前沿目标，让连续路径真连续）
import json

APATH = 'server/data/v3-activities.json'
LPATH = 'server/data/v3-lessons.json'

a = json.load(open(APATH, encoding='utf-8'))
acts = {x['activityId']: x for x in a['activities']}

TEACH_V2 = "\n".join([
    "先看这份记录里的真实句子，再分清四件事（本课 30 秒短讲）：",
    "· 主张：说话人最想让你记住的那句话。排练记录里最要紧的一句是“我们保留了手势控制”。",
    "· 对照：在这份记录里，对照说的是“安静的工作室里好用”和“人多的时候失灵”——预期和实际在这两个场景下不一样。它说的是这两个场景的差异；不要把它推广成“只要是对照就是在划范围”。",
    "· 让步：像“你说得对，地图确实没坏”——说话人先接受对方这一句，再说自己的话。让步接受的是那一句，不是什么都接受，也不等于收窄范围。",
    "· 限制：这份记录里的限制写得很具体——“语音控制被推迟，直到能在展厅、有真实访客的场景下测过”。判断限制要看句子里实际收窄的内容（只在…／推迟到…）。注意：推迟到“测过为止”是原文写的；“测完之后一定会再决定／再采用”是推断，原文没有这么写——复述时别把推断说成原文。",
    "· 关键：but/although 后面不一定是限制——有的句子只是对照两个事实，没有收窄任何范围；这时如实说“这句话没有划范围／信息不足”，也是正确回答。",
    "",
    "例句：The map was working as designed, but our assumption about what visitors wanted was incomplete.",
    "逐空选择（全对才算过）。",
])

FOLLOWUPS = {
    "g3c_principle_pick": "开放追问（不能照抄）：如果有人断言“but 后面就一定是限制”，你会用这两份记录里的哪两个具体句子回应他？用你自己的话写下来（中英文都行）。写在下面框里，会保存在本机，作为下次学习的引子。",
    "g3c_rehearsal_locate": "开放追问：用 we kept … but we delayed … 这个句子架子，装上你自己生活里的一件事（不是这份记录的内容），写一句英语。",
    "g3c_paraphrase_recover": "开放追问：说一件你自己推迟过的事——推迟了什么、条件是什么、它不是什么。中英文都行。",
    "g3c_write_limit": "开放追问：把你的小写作压缩成一句英语（一句话版），仍要说清“先测再定，不是语音不行”。",
    "g3c_film_transfer": "开放追问：仿照“kept … but postponed …”的结构，给你熟悉的场景（课程／社团／项目）写一句英语。",
    "g4c_claim_limit_slots": "开放追问：如果有人读完博物馆地图段说“所以地图失败了”，你会怎么纠正他？写一两句。",
    "g4c_recap_write": "开放追问：把你的复述缩成一句英语，主张和修正都要在那一句话里。",
}

changed = []
for aid, fu in FOLLOWUPS.items():
    act = acts.get(aid)
    if not act:
        print('MISSING', aid); continue
    if act.get('revealFollowup') == fu and (aid != 'g3c_principle_pick'):
        continue
    act['version'] = 2
    act['revealFollowup'] = fu
    changed.append(aid)
if acts['g3c_principle_pick']['prompt'] != TEACH_V2:
    acts['g3c_principle_pick']['version'] = 2
    acts['g3c_principle_pick']['prompt'] = TEACH_V2
    if 'g3c_principle_pick' not in changed:
        changed.append('g3c_principle_pick')

# ---- O-K115-01 前沿课活动（限定 vs 补充；用具体句子讲判断方法，不背口诀）----
COND = ["firstExposure", "hintLevel", "transcriptShown", "playCount", "lookupUsed", "responseMode"]

def slot(sid, prompt, options, accept):
    return {"slotId": sid, "prompt": prompt, "options": options, "accept": accept, "objectiveIds": ["O-K115-01"]}

new_acts = []
if 'm1_teach_pick' not in acts:
    new_acts.append({
        "activityId": "m1_teach_pick", "version": 1, "role": "practice",
        "taskFamilyId": "modifier_teach_m1",
        "objectiveIds": ["O-K115-01"],
        "skillByObjective": {"O-K115-01": "reading"},
        "responseKind": "text",
        "servesStrategies": ["short_explain", "relation_map"],
        "prompt": "\n".join([
            "读这一对句子（本课 30 秒短讲）：",
            "A. The sensor that was tested indoors works well.",
            "B. The sensor, which was tested indoors, works well.",
            "两句说的都是同一台传感器。差别在带不带逗号：A 没有逗号——that 部分**回答“哪一台”**（在几台里锁定“在室内测过的那台”）；B 有逗号——which 部分**补一句这台传感器的信息**（去掉它，句子指的还是同一台）。",
            "判断“谁在修饰谁”就问一件事：这部分去掉之后，所指对象变不变？变＝它在限定（回答“哪个”）；不变＝它在补充（多给一条信息）。",
            "逐空选择（全对才算过）。",
        ]),
        "hints": [
            "先做“去掉试试”：B 句去掉 which 部分，指的还是同一台传感器吗？",
            "A 的 that 部分在几台传感器里挑出“在室内测过的那台”——它在回答“哪一台”。",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["限定与补充的分辨"],
            "slots": [
                slot("a_role", "A 句的 that 部分（无逗号）在做什么？", ["回答“哪一台”（限定）", "补充信息（去掉后所指不变）", "说明结果"], "回答“哪一台”（限定）"),
                slot("b_role", "B 句的 which 部分（有逗号）在做什么？", ["回答“哪一台”（限定）", "补充信息（去掉后所指不变）", "表示转折"], "补充信息（去掉后所指不变）"),
            ],
            "mustNotNegationGuard": True,
            "unmeasuredObjectives": [],
        },
        "complexityBand": 2,
        "certification": "closed",
        "revealFollowup": "开放追问：找一个你熟悉的产品，分别用“带 that 的限定句”和“带逗号 which 的补充句”各写一句英语。",
    })
if 'm1_projector_locate' not in acts:
    new_acts.append({
        "activityId": "m1_projector_locate", "version": 1, "role": "practice",
        "taskFamilyId": "modifier_locate_m1",
        "objectiveIds": ["O-K115-01"],
        "skillByObjective": {"O-K115-01": "reading"},
        "responseKind": "text",
        "servesStrategies": ["short_explain"],
        "materialId": "mat_g1_relation_pairs",
        "segmentIds": ["mat_g1_projector"],
        "referenceAnswer": "A 句的 which 部分是补充（从媒体实验室借来的——去掉不影响所指）；B 句的 which 部分指“展览中坏掉”这件事，并在说明后果。",
        "supportingQuotes": [
            "A. The projector, which we borrowed from the media lab, stopped working during the exhibition.",
            "B. The projector stopped working during the exhibition, which meant that we had to change the installation.",
        ],
        "prompt": "读右边投影仪两句，逐空判断；理由栏用一句话说出你的判断过程。",
        "hints": [
            "A 的 which 部分去掉试试：指的还是那台投影仪吗？",
            "B 的 which 离得很远——问自己：坏掉的是设备，还是“在展览中停摆”这件事？",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["补充句", "指代对象", "理由"],
            "slots": [
                slot("a_which", "A 句的 which 部分（逗号）去掉后，所指的投影仪变吗？", ["不变——它在补充从哪借的", "变——它在挑哪一台"], "不变——它在补充从哪借的"),
                slot("b_which", "B 句的 which 部分指的是什么？", ["投影仪这台设备", "“在展览中停摆”这件事", "媒体实验室"], "“在展览中停摆”这件事"),
            ],
            "reason": {
                "relations": [
                    {"id": "r_method", "label": "说清判断方法（去掉试试／所指变不变）", "anyOf": ["去掉", "所指", "变", "限定", "补充"], "required": False, "objectiveIds": ["O-K115-01"]},
                ],
                "mustNot": [{"label": "把位置/标点当机械规则", "anyOf": ["有逗号就", "没逗号就", "一定是限定", "一定是补充"]}],
            },
            "mustNotNegationGuard": True,
            "unmeasuredObjectives": [],
        },
        "complexityBand": 3,
        "certification": "closed",
        "revealFollowup": "开放追问：用你自己的话解释 B 句的 which 为什么指事情不指设备——别背定义，讲你怎么判断的。",
    })
if 'm1_transfer_write' not in acts:
    new_acts.append({
        "activityId": "m1_transfer_write", "version": 1, "role": "transfer",
        "taskFamilyId": "modifier_transfer_m1",
        "objectiveIds": ["O-K115-01"],
        "skillByObjective": {"O-K115-01": "reading"},
        "responseKind": "text",
        "servesStrategies": ["relation_map", "short_explain"],
        "prompt": "新句子（迁移）：Our assistant, who joined in May, already runs the Tuesday stand-up.\n\n用一两句中文或英文说明：who 部分是限定还是补充？你是怎么判断的？（讲你的判断过程，别背定义，也别照抄例句。）",
        "hints": [
            "去掉 who 部分试试：句子说的还是“那位助手”吗？",
            "限定回答“哪一位”；补充只是多给一条信息（几月来的）。这句话里说话人心里已经确定是哪位助手了吗？",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["判断方法", "结论"],
            "relations": [
                {"id": "method", "label": "讲出判断方法（去掉试试／所指变不变）", "anyOf": ["去掉", "所指", "不变", "变"], "required": True, "objectiveIds": ["O-K115-01"]},
                {"id": "verdict", "label": "给出结论（补充信息）", "anyOf": ["补充", "不变", "已经确定", "额外"], "required": True, "objectiveIds": ["O-K115-01"]},
            ],
            "mustNot": [{"label": "把标点当机械规则", "anyOf": ["有逗号就", "一定是限定", "一定是补充"]}],
        },
        "complexityBand": 4,
        "revealFollowup": "开放追问：把这句改成限定版——比如团队有多位助手、这句要锁定“五月来的那位”。写出来对比。",
    })

added = 0
for x in new_acts:
    a['activities'].append(x)
    acts[x['activityId']] = x
    added += 1
json.dump(a, open(APATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('activities: added', added, '| bumped-to-v2:', changed)

# ---- 课程：c1/c2 升版 v2（refs 版本同步）+ 新增 les-modifier-m1 ----
l = json.load(open(LPATH, encoding='utf-8'))
have = {(x['lessonId'], x.get('version')) for x in l['lessons']}
added_l = 0

if ('les-claim-limit-c2', 2) not in have:
    c2v1 = next(x for x in l['lessons'] if x['lessonId'] == 'les-claim-limit-c2' and x.get('version') == 1)
    l['lessons'].append({**c2v1, 'version': 2,
        'activities': [{**ref, 'version': 2} for ref in c2v1['activities']],
        'chainNote': '40 号：v2=活动补揭晓追问（revealFollowup）；判题合同未变'})
    added_l += 1
if ('les-claim-limit-c1', 2) not in have:
    c1v1 = next(x for x in l['lessons'] if x['lessonId'] == 'les-claim-limit-c1' and x.get('version') == 1)
    c1v2 = {**c1v1, 'version': 2,
        'activities': [{**ref, 'version': 2} for ref in c1v1['activities']],
        'nextCandidates': ['les-claim-limit-c2'],
        'chainNote': '40 号：v2=短讲校订（具体句子讲/不写普遍定义/“再决定”推断分开）+全链揭晓追问；槽位判据未变'}
    l['lessons'].append(c1v2)
    added_l += 1
if ('les-modifier-m1', 1) not in have:
    l['lessons'].append({
        "lessonId": "les-modifier-m1", "version": 1,
        "title": "谁在修饰谁：限定和补充",
        "whyNow": "你开始读更长的句子了。这一课给你一个可操作的判断方法——“去掉试试”——再用真实句子走一遍：讲→判断→迁移。",
        "teachingNote": "判断“谁在修饰谁”就问一件事：这部分去掉之后，所指对象变不变？变＝限定（回答“哪个”）；不变＝补充（多给一条信息）。不背位置口诀。",
        "strategyId": "short_explain",
        "objectiveIds": ["O-K115-01"],
        "difficultyDims": [],
        "activities": [
            {"activityId": "m1_teach_pick", "version": 1, "role": "practice",
             "hintStages": ["先做“去掉试试”：B 句去掉 which 部分，指的还是同一台传感器吗？", "A 的 that 部分在几台传感器里挑出“在室内测过的那台”——它在回答“哪一台”。"]},
            {"activityId": "m1_projector_locate", "version": 1, "role": "practice",
             "hintStages": ["A 的 which 部分去掉试试：指的还是那台投影仪吗？", "B 的 which 离得很远——问自己：坏掉的是设备，还是“在展览中停摆”这件事？"]},
            {"activityId": "m1_transfer_write", "version": 1, "role": "transfer",
             "hintStages": ["去掉 who 部分试试：句子说的还是“那位助手”吗？", "限定回答“哪一位”；补充只是多给一条信息（几月来的）。这句话里说话人心里已经确定是哪位助手了吗？"]},
        ],
        "nextCandidates": [],
        "sourceRefs": [{"ref": "G1", "claim": "限定（无逗号 that）回答“哪一台”；补充（逗号 which）去掉不改所指——以“去掉试试”为判据"}],
        "holdoutRef": None,
        "chainNote": "40 号：O-K115-01 前沿目标课——真实推荐会落到这里的缺口，先补上让连续路径真连续",
    })
    added_l += 1
json.dump(l, open(LPATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('lessons: added', added_l, '| total', len(l['lessons']))
