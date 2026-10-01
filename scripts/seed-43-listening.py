# 43 号批内容种子（一次性脚本，幂等）：
# ① 两个新实用情境的受控合成听力脚本（学习小组周会汇报 / 宿舍洗衣时间表——42 号要求的新情境，
#    不再扩写传感器/排练/博物馆）；真实 wav 由 scripts/make-tts-audio.mjs 生成（本脚本只写脚本定义）
# ② 素材池登记（listen_synthetic；许可=原创脚本+合成语音，来源清楚）
# ③ 听力链 5 活动 + 口头回应链 2 活动
# ④ 两节课（les-listening-c1 → les-oral-c1）
import json

# ---------- ① TTS 脚本定义 ----------
TPATH = 'scripts/tts-scripts.json'
t = json.load(open(TPATH, encoding='utf-8'))
have_scripts = {s['scriptId'] for s in t['scripts']}

NEW_SCRIPTS = [
    {
        "scriptId": "l1_standup_reminder_v1",
        "mediaId": "aud_l1_standup_v1",
        "activityIds": ["l1a_first_listen", "l1b_transcript_study", "l1c_relisten_closed"],
        "version": 1,
        "voice": "Microsoft Zira Desktop",
        "voiceParams": {"rate": 0},
        "speakerLabel": "synthetic-A（Zira，单一英文声源——换真人间隙如实标注；与 D2/L2 不同情境）",
        "family": "standup_reminder_audio_E",
        "segments": [
            {"label": "做了什么",
             "text": "In our study group, we set up daily review reminders in October. The idea was to send a short message every evening at eight.",
             "meaningBasis": "项目内容：十月起设了每天晚上八点的复习提醒。"},
            {"label": "预期",
             "text": "We expected the daily reminders to help everyone keep up with the readings.",
             "meaningBasis": "团队预期：每天提醒能帮大家跟上阅读。"},
            {"label": "实际观察",
             "text": "In fact, after two weeks, most of us ignored the evening messages, and the reminders stopped feeling useful.",
             "meaningBasis": "实际结果：两周后大多数人忽略了晚间消息——提醒不再有用。in fact 分开预期与实际。"},
            {"label": "结论与限制",
             "text": "So here is our conclusion: reminders do help, but only before exam week, when everyone wants a schedule; on normal weeks, we will turn them off and review on our own.",
             "meaningBasis": "最终主张带限制：提醒有用——但只在考试周前（大家想要时间表时）；平时周关掉、自己安排。限制是使用条件，不是“提醒没用”。"},
        ],
    },
    {
        "scriptId": "l1d_laundry_v1",
        "mediaId": "aud_l1d_laundry_v1",
        "activityIds": ["l1d_second_context"],
        "version": 1,
        "voice": "Microsoft Zira Desktop",
        "voiceParams": {"rate": 0},
        "speakerLabel": "synthetic-A（Zira，单一英文声源——换材料换情境，“换声音”待真人录音，如实开放）",
        "family": "laundry_schedule_audio_F",
        "segments": [
            {"label": "做了什么",
             "text": "Our dorm floor shares one washing machine, so we made a sign-up sheet for laundry times.",
             "meaningBasis": "背景与做法：全层共用一台洗衣机，做了洗衣时间登记表。"},
            {"label": "何时有效",
             "text": "The sheet works well on weekdays, because everyone is in class at different hours.",
             "meaningBasis": "主张成立范围：工作日好用——大家上课时间错开。"},
            {"label": "限制",
             "text": "But on Friday evenings everyone wants to wash at the same time, so the sheet does not help then. We will keep it for weekdays only.",
             "meaningBasis": "限制说得很具体：周五晚上大家同时想洗，表帮不上忙——决定是只在工作日保留。限制是适用范围，不是“表没用”。"},
        ],
    },
]
added_s = 0
for s in NEW_SCRIPTS:
    if s['scriptId'] not in have_scripts:
        t['scripts'].append(s)
        added_s += 1
json.dump(t, open(TPATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('tts scripts added:', added_s)

# ---------- ② 素材池登记 ----------
MPATH = 'server/data/v3-materials.json'
m = json.load(open(MPATH, encoding='utf-8'))
have_mats = {x['materialId'] for x in m['materials']}
new_mats = []
for sid, mid, label in [
    ('l1_standup_reminder_v1', 'aud_l1_standup_v1', '学习小组周会汇报（复习提醒的结论与限制）'),
    ('l1d_laundry_v1', 'aud_l1d_laundry_v1', '宿舍洗衣时间表说明（适用范围与限制）'),
]:
    if mid in have_mats:
        continue
    new_mats.append({
        "materialId": mid,
        "materialVersion": 1,
        "kind": "listen_synthetic",
        "status": "audited",
        "objectiveIds": ["O-K184-01", "O-K184-02"],
        "sourceRef": "T",
        "note": f"受控原创听力脚本（合成语音 synthetic）：{label}。正文=音频本身，转写首听不下发（21 §6.2）；脚本逐段意义依据见 audio-manifest。许可=本项目原创+Windows SAPI 合成，来源清楚（42 号：先用已持有且许可清楚的材料）。",
        "review": {"humanReviewed": False, "reviewer": None, "selfRevised": True, "notes": "synthetic_exact 转写按构造成立；设备播放与自然度试听留真人（23 号）。单一合成声源，“换声音”缺口如实开放。"},
        "segments": [],
    })
m['materials'].extend(new_mats)
m['materialsVersion'] = (m.get('materialsVersion') or 2) + 1
json.dump(m, open(MPATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('materials added:', len(new_mats), '| materialsVersion', m['materialsVersion'])

# ---------- ③ 活动 ----------
APATH = 'server/data/v3-activities.json'
a = json.load(open(APATH, encoding='utf-8'))
acts = {x['activityId']: x for x in a['activities']}
COND = ["firstExposure", "hintLevel", "transcriptShown", "playCount", "lookupUsed", "responseMode"]
new_acts = []

def rel(id, label, anyOf, required=True, oids=None):
    return {"id": id, "label": label, "anyOf": anyOf, "required": required, "objectiveIds": oids or ["O-K184-01", "O-K184-02"]}

if 'l1a_first_listen' not in acts:
    new_acts.append({
        "activityId": "l1a_first_listen", "version": 1, "role": "practice",
        "taskFamilyId": "standup_reminder_audio_E",
        "objectiveIds": ["O-K184-01", "O-K184-02"],
        "skillByObjective": {"O-K184-01": "listening", "O-K184-02": "listening"},
        "responseKind": "text", "simulatesAudio": True, "audioRef": "aud_l1_standup_v1",
        "servesStrategies": ["sound_segmentation"],
        "prompt": "（受控练习音频：合成语音 synthetic，非真人；单一英文声源，“换声音”待真人录音。首听不显示脚本；点播放，可重复播放。听力记录受限——封顶「已练」，自然讲者版本到位后才升级。）\n\n点播放听一遍学习小组周会的汇报（新情境：复习提醒），然后回答：团队最后的决定是什么？「每天提醒」被说成没用了吗？限制的条件是什么？",
        "hints": [
            "先抓最后的结论句（So here is our conclusion…）。",
            "注意 but 只在……之后的部分：那是使用条件，不是“提醒没用”。",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["最终决定", "限制条件", "不是全盘否定"],
            "relations": [
                rel("decision", "平时关掉、只留考试周提醒", ["turn them off", "关掉", "关闭", "只在考试周", "exam week", "考试周", "考前"]),
                rel("limit", "限制＝只在考试周前有用/需要", ["exam week", "考试周", "考前", "before exam"]),
                rel("not_useless", "没有把提醒说成彻底没用（提醒 do help）", ["有帮助", "有用", "help", "do help", "不是没用", "并非没用"], required=False),
            ],
            "mustNot": [{"label": "把限制说成“提醒被永久取消”", "anyOf": ["永久取消", "彻底没用", "never use reminders", "completely useless"]}],
        },
        "revealFollowup": "开放追问：换一个你生活里的提醒（闹钟/待办/喝水提醒），用一句英语说出它的适用条件（as long as … / only when …）。",
    })
if 'l1b_transcript_study' not in acts:
    new_acts.append({
        "activityId": "l1b_transcript_study", "version": 1, "role": "practice",
        "taskFamilyId": "standup_reminder_audio_E",
        "objectiveIds": ["O-K184-01", "O-K184-02"],
        "skillByObjective": {"O-K184-01": "reading", "O-K184-02": "reading"},
        "responseKind": "text", "simulatesAudio": True, "audioRef": "aud_l1_standup_v1",
        "transcriptShownByDefault": True,
        "servesStrategies": ["sound_segmentation"],
        "prompt": "（合成音频 + 校对稿：本轮已展示校对稿，表现记入「文字理解」，不升级听力。音频为 synthetic 受控练习音频。）\n\n校对稿：In our study group, we set up daily review reminders in October. The idea was to send a short message every evening at eight. We expected the daily reminders to help everyone keep up with the readings. In fact, after two weeks, most of us ignored the evening messages, and the reminders stopped feeling useful. So here is our conclusion: reminders do help, but only before exam week, when everyone wants a schedule; on normal weeks, we will turn them off and review on our own.\n\n请定位：1) 哪一句说了限制（只在什么时候有用）？2) In fact 分开的是哪两件事？3) 用英文给小组写一句更短的建议（贴在群里那种）。",
        "hints": [
            "限制在最后一句的 but only before exam week。",
            "In fact 前是预期（每天提醒有用），后是实际（两周后大家忽略）。",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["限制句定位", "预期与实际", "短建议"],
            "relations": [
                rel("limit_sentence", "定位限制句（只在考试周）", ["exam week", "考试周", "but only"]),
                rel("expect_vs_fact", "说出 In fact 分开预期与实际", ["in fact", "预期", "实际", "两周", "ignored", "忽略"]),
                rel("short_advice", "给出英文短建议句", ["we should", "we will", "suggest", "建议", "only before", "考试周"], required=False, oids=["O-K184-02"]),
            ],
            "mustNot": [{"label": "把限制句说成最后结论的反面", "anyOf": ["提醒永远开", "keep daily reminders forever"]}],
        },
        "revealFollowup": "开放追问：把你写的英文短建议再缩短一半——删掉哪些词意思还在？",
    })
if 'l1c_relisten_closed' not in acts:
    new_acts.append({
        "activityId": "l1c_relisten_closed", "version": 1, "role": "practice",
        "taskFamilyId": "standup_reminder_audio_E",
        "objectiveIds": ["O-K184-01", "O-K184-02"],
        "skillByObjective": {"O-K184-01": "listening", "O-K184-02": "listening"},
        "responseKind": "text", "simulatesAudio": True, "audioRef": "aud_l1_standup_v1",
        "servesStrategies": ["sound_segmentation"],
        "prompt": "（受控练习音频 synthetic；这一轮**关闭稿**重新听——校对稿已经收起。点播放，可重复播放。）\n\n再听一遍同一段汇报，回答两个新问题：1) 讲者用什么词把「预期」和「实际」分开？2) 团队对平时周的处理是「关掉提醒」还是「缩短提醒时间」？",
        "hints": [
            "第 1 问听转折词：In fact 之后说的才是实际。",
            "第 2 问听结论句里的 turn them off。",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["转折词", "平时周的处理"],
            "relations": [
                rel("pivot", "听出 in fact 分开预期/实际", ["in fact", "其实", "实际上", "但是", "but"]),
                rel("turn_off", "平时周＝关掉提醒", ["turn them off", "关掉", "关闭", "off"]),
            ],
            "mustNot": [{"label": "把“关掉”听成“缩短”", "anyOf": ["缩短提醒时间", "shorten the reminders"]}],
        },
        "revealFollowup": "开放追问：用 In fact 造一句你自己的话——前半句是你原本以为的，后半句是实际发生的。",
    })
if 'l1d_second_context' not in acts:
    new_acts.append({
        "activityId": "l1d_second_context", "version": 1, "role": "transfer",
        "taskFamilyId": "laundry_schedule_audio_F",
        "objectiveIds": ["O-K184-01", "O-K184-02"],
        "skillByObjective": {"O-K184-01": "listening", "O-K184-02": "listening"},
        "responseKind": "text", "simulatesAudio": True, "audioRef": "aud_l1d_laundry_v1",
        "servesStrategies": ["sound_segmentation"],
        "prompt": "（受控练习音频 synthetic；换材料换情境——从课堂汇报换到宿舍生活。首听不显示脚本；点播放，可重复播放。）\n\n听一遍关于宿舍洗衣时间表的说明，回答：这个表在什么时候好用？什么时候帮不上忙？最后的决定是什么？",
        "hints": [
            "先抓 works well on weekdays。",
            "But 之后是限制：周五晚上；最后听 keep it for weekdays only。",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["何时有效", "何时无效", "决定"],
            "relations": [
                rel("weekdays_ok", "工作日好用（大家上课时间错开）", ["weekday", "工作日", "平日", "错开"]),
                rel("friday_bad", "周五晚上帮不上忙（大家同时想洗）", ["friday", "周五", "星期五", "同一时间", "same time"]),
                rel("keep_decision", "决定＝只在工作日保留", ["keep", "保留", "weekdays only", "只在工作日", "只在"], required=False),
            ],
            "mustNot": [{"label": "把范围限制说成“表完全没用”", "anyOf": ["完全没用", "completely useless", "没有任何用"]}],
        },
        "revealFollowup": "开放追问：你们宿舍/班级还有一个「只在某些时候好用」的约定吗？用一句英语说它什么时候成立、什么时候不成立。",
    })
if 'l1e_oral_respond' not in acts:
    new_acts.append({
        "activityId": "l1e_oral_respond", "version": 1, "role": "practice",
        "taskFamilyId": "standup_respond_oral_E",
        "objectiveIds": ["O-K184-01"],
        "skillByObjective": {"O-K184-01": "speaking"},
        "responseKind": "text", "oralEvidenceDeferred": True,
        "servesStrategies": ["sound_segmentation", "oral_retrieval"],
        "prompt": "（口头回应：页内录音。机器词表反馈只作练习参考，**口语掌握待人审复核**；转写词错≠你的错。这是听力链的收口——听完之后用自己的话回应。）\n\n如果你是小组一员，你会接受「只在考试周开提醒」吗？脱稿说一两句英语：先给立场（我接受/我不完全接受），再给一个限制条件（只要…／除非…）。",
        "hints": [
            "先说立场，再说条件：I agree … as long as … ／ I'm not sure … unless …",
            "条件要具体：哪一周、哪类课、忙到什么程度。",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["立场", "限制条件"],
            "relations": [
                {"id": "stance", "label": "给出立场（接受/不完全接受）", "anyOf": ["agree", "接受", "i think", "not sure", "不接受", "部分", "depends", "看情况"], "required": True, "objectiveIds": ["O-K184-01"]},
                {"id": "condition", "label": "给出限制条件（as long as / unless / 只要 / 除非）", "anyOf": ["as long as", "unless", "只要", "除非", "如果", "if"], "required": False, "objectiveIds": ["O-K184-01"]},
            ],
            "mustNot": [],
        },
        "revealFollowup": "开放追问：把你刚才的口头回应写下来，看看和你说的是不是同一件事——少了哪个词意思会变？",
    })
if 'o1a_schedule_decision' not in acts:
    new_acts.append({
        "activityId": "o1a_schedule_decision", "version": 1, "role": "practice",
        "taskFamilyId": "schedule_oral_G",
        "objectiveIds": ["O-K190-01"],
        "skillByObjective": {"O-K190-01": "speaking"},
        "responseKind": "text", "oralEvidenceDeferred": True,
        "servesStrategies": ["oral_retrieval"],
        "prompt": "（口头回应：页内录音；机器词表反馈只作练习参考，口语掌握待人审。新情境：你们小组的项目站会要从周三晚改到周六上午。）\n\n脱稿录音，把这件事讲清楚：决定是什么、为什么改、保留什么条件（比如有人来不了怎么办）。不用背句子——把三件事说清楚就行。",
        "hints": [
            "三件事各一句：决定（改到周六上午）→ 原因（…）→ 条件（来不了的人…）。",
            "可用语块：We're moving … to … because … If someone can't come, we will …",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["决定", "原因", "条件"],
            "relations": [
                {"id": "decision", "label": "说清决定（改到周六上午）", "anyOf": ["saturday", "周六", "星期六", "move", "改到", "换到"], "required": True, "objectiveIds": ["O-K190-01"]},
                {"id": "reason", "label": "说出原因（冲突/来不及/因为…）", "anyOf": ["because", "因为", "conflict", "冲突", "can't", "来不及", "没时间"], "required": False, "objectiveIds": ["O-K190-01"]},
                {"id": "condition", "label": "保留条件（来不了的人怎么办）", "anyOf": ["if someone", "record", "录音", "回看", "another time", "其他时间", "补", "来不了"], "required": False, "objectiveIds": ["O-K190-01"]},
            ],
            "mustNot": [],
        },
        "revealFollowup": "开放追问：把你的录音内容用三句英语写下来——写的时候发现哪句最难说清？那就是下次要先练的。",
    })
if 'o1b_followup_reply' not in acts:
    new_acts.append({
        "activityId": "o1b_followup_reply", "version": 1, "role": "transfer",
        "taskFamilyId": "schedule_oral_G",
        "objectiveIds": ["O-K190-01", "O-K194-01"],
        "skillByObjective": {"O-K190-01": "speaking", "O-K194-01": "speaking"},
        "responseKind": "text", "oralEvidenceDeferred": True, "unlockAfter": "o1a_schedule_decision",
        "servesStrategies": ["oral_retrieval"],
        "prompt": "（口头回应：页内录音；即时追问——听/看完追问后直接回应，不要打草稿。机器反馈只作练习参考。）\n\n队友追问：「小周周六要加班，来不了，那怎么办？」——录音回应：给出安排，并说明这不是取消小周的参与。",
        "hints": [
            "先接住问题（OK / Good point），再给安排：He can … ／ We will record …",
            "最后补一句这不是取消：He's still in — he just …",
        ],
        "conditionsSpec": COND,
        "evaluationContract": {
            "dimensions": ["给出安排", "不取消参与"],
            "relations": [
                {"id": "arrangement", "label": "给出具体安排（录音/异步/另约时间）", "anyOf": ["record", "录音", "回看", "another time", "另", "补", "async", "notes", "笔记"], "required": True, "objectiveIds": ["O-K194-01"]},
                {"id": "still_in", "label": "说明不是取消他的参与", "anyOf": ["still", "仍然", "还是", "not cancel", "没有取消", "still in", "照样"], "required": False, "objectiveIds": ["O-K194-01"]},
            ],
            "mustNot": [],
        },
        "revealFollowup": "开放追问：把「先接住问题→给安排→说明不是取消」这个三步式用在另一个追问上（比如“作业延期了怎么办”）。",
    })

added_a = 0
for x in new_acts:
    if x['activityId'] in acts:
        continue
    a['activities'].append(x)
    added_a += 1
json.dump(a, open(APATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('activities added:', added_a)

# ---------- ④ 课程 ----------
LPATH = 'server/data/v3-lessons.json'
l = json.load(open(LPATH, encoding='utf-8'))
have = {(x['lessonId'], x.get('version')) for x in l['lessons']}
new_lessons = []
if ('les-listening-c1', 1) not in have:
    new_lessons.append({
        "lessonId": "les-listening-c1", "version": 1,
        "title": "听出主张和限制：从一段汇报开始",
        "whyNow": "听力目标的主课来了：无稿首听抓结论 → 校对稿解释 → 关稿重听 → 换情境再试 → 口头回应。音频是合成语音（synthetic，受控练习）——听力记录受限封顶「已练」，自然讲者版本到位后才升级，这里如实标注。",
        "teachingNote": "听长段先抓最后一句结论（So here is our conclusion…）；转折词（but / in fact）前后各是预期和实际；限制是“什么时候成立”，不是“没用”。",
        "strategyId": "sound_segmentation",
        "objectiveIds": ["O-K184-01", "O-K184-02"],
        "difficultyDims": [],
        "activities": [
            {"activityId": "l1a_first_listen", "version": 1, "role": "practice",
             "hintStages": ["先抓最后的结论句（So here is our conclusion…）。", "注意 but 只在……之后的部分：那是使用条件，不是“提醒没用”。"]},
            {"activityId": "l1b_transcript_study", "version": 1, "role": "practice",
             "hintStages": ["限制在最后一句的 but only before exam week。", "In fact 前是预期（每天提醒有用），后是实际（两周后大家忽略）。"]},
            {"activityId": "l1c_relisten_closed", "version": 1, "role": "practice",
             "hintStages": ["第 1 问听转折词：In fact 之后说的才是实际。", "第 2 问听结论句里的 turn them off。"]},
            {"activityId": "l1d_second_context", "version": 1, "role": "transfer",
             "hintStages": ["先抓 works well on weekdays。", "But 之后是限制：周五晚上；最后听 keep it for weekdays only。"]},
            {"activityId": "l1e_oral_respond", "version": 1, "role": "practice",
             "hintStages": ["先说立场，再说条件：I agree … as long as … ／ I'm not sure … unless …", "条件要具体：哪一周、哪类课、忙到什么程度。"]},
        ],
        "nextCandidates": ["les-oral-c1"],
        "sourceRefs": [{"ref": "T", "claim": "受控原创脚本：主张带使用条件（考试周/工作日）；限制≠没用——听力理解以结论+限制复述为准"}],
        "holdoutRef": None,
        "chainNote": "43 号听力链：无稿首听→校对稿→关稿重听→换材料→口头回应；合成音频如实标注，听力证据受限封顶 trained",
    })
if ('les-oral-c1', 1) not in have:
    new_lessons.append({
        "lessonId": "les-oral-c1", "version": 1,
        "title": "回应追问：把决定说清楚",
        "whyNow": "听力链的收口是开口。这一课练实际表达：把一个小组决定脱稿讲清，再接住队友的即时追问。",
        "teachingNote": "讲清一件事的三步：决定 → 原因 → 保留条件。接追问的三步：先接住（OK/Good point）→ 给安排 → 说明这不是取消。",
        "strategyId": "oral_retrieval",
        "objectiveIds": ["O-K190-01", "O-K194-01"],
        "difficultyDims": [],
        "activities": [
            {"activityId": "o1a_schedule_decision", "version": 1, "role": "practice",
             "hintStages": ["三件事各一句：决定（改到周六上午）→ 原因（…）→ 条件（来不了的人…）。", "可用语块：We're moving … to … because … If someone can't come, we will …"]},
            {"activityId": "o1b_followup_reply", "version": 1, "role": "transfer", "unlockAfter": "o1a_schedule_decision",
             "hintStages": ["先接住问题（OK / Good point），再给安排：He can … ／ We will record …", "最后补一句这不是取消：He's still in — he just …"]},
        ],
        "nextCandidates": [],
        "sourceRefs": [{"ref": "T", "claim": "受控原创情境（项目站会改时间）：脱稿讲清决定/原因/条件 + 即时追问回应"}],
        "holdoutRef": None,
        "chainNote": "43 号口头回应链：实际表达+即时追问；口语证据 defer（机器反馈练习级，掌握待人审）",
    })
l['lessons'].extend(new_lessons)
json.dump(l, open(LPATH, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('lessons added:', len(new_lessons), '| total', len(l['lessons']))
