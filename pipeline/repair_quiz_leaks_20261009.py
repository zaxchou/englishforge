"""Build signed, local content overrides. Does not overwrite production quizzes or learning records."""
import json,hashlib,copy,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'docs/repair-2026-10-09';OUT.mkdir(exist_ok=True)
source=ROOT.parent/'data/toefl-lab-production/records/generated-quizzes.json';raw=source.read_bytes();store=json.loads(raw.decode('utf-8-sig'))['items']
findings=json.loads((ROOT/'docs/deep-review-2026-10-09/confirmed-quiz-leaks.json').read_text(encoding='utf-8'))
STEMS={
(1,5):'In a team where everyone follows the same routine, Maya is a ______ bird: she approaches every problem in her own unusual way. 选择能组成“与众不同的人”这一习语的词。',
(1,6):'We must ______ our limited resources so they last until new supplies arrive. 空格要求表示“节约、合理利用现有资源”的动词，不是新增、移除或转移资源。',
(3,11):'spot 可以指污点、景点或停车位；这些意思依赖不同场景，并不构成一个按顺序发生的过程。按本课的分类，这属于哪种多义关系？',
(3,12):'本课用“从高处落下 → 加速 → 落到底部形成沉淀”联系一个词的多个意思。按本课的分类，这种有过程先后关系的联系属于哪一类？',
(8,23):'The cars are assembled in a factory outside the city. 句中 factory 指什么场所？',
(8,24):'Take the elevator to the tenth floor. 句中 elevator 的意思是什么？',
(8,51):'The island depends on ______: visitors pay for hotels, meals, and guided trips. 空格指“旅游业”这一行业名词，而非某位游客或一次旅行。',
(9,13):'I would be more than happy to help. 句中 more than happy 最接近哪一种意思？',
(12,6):'I agree with that interpretation. It is the one I personally ______ to. 选择与 to 搭配、表示“赞同某一观点”的动词。',
(12,7):'To receive every issue regularly, she took out a ______ to the magazine.',
(12,10):'After examining the patient, the doctor will ______ a course of antibiotics. 空格需要表示医生作出治疗决定、开具用药处方的动词。',
(14,12):'We can only speculate about what happened until we obtain more evidence. 句中 speculate 最接近哪个意思？',
(18,22):'One witness said the door was open; another said it was closed. Their statements were contradictory. 句中 contradictory 的意思是什么？',
(18,25):'The dictionary provides audio to help learners improve their pronunciation. 句中 pronunciation 的意思是什么？',
(22,7):'教练想使队员牢牢记住安全的重要性。哪一项的结构表示“使某人铭记某件事”，并可用于这个语境？',
(40,6):'She filled a wide, shallow ______ with water to wash her hands. 选择表示这种盛水容器的名词。',
(46,9):'A ______ is an instrument used to measure temperature.'}
notes={
(1,5):['meteor 是流星，不组成这里表示人的习语。','dome 是穹顶，不组成这里表示人的习语。','rare bird 可指与众不同、不常见的人，符合后面的行为描写。','husband 是丈夫，也可作动词，但不组成这个习语。'],
(1,6):['remove 表移除，不表示合理利用现有资源。','provide 表提供，不符合“不新增供应”的条件。','channel 表引导到某个方向，不表示谨慎节用以维持更久。','husband 作动词可指谨慎、节约地利用资源，符合题面给定的意思。'],
(8,51):['tourism 指旅游业，符合游客支付住宿、餐饮和导览所构成的行业。','tourist 指游客个人，不是行业名称。','touring 指旅行或巡回活动，不是本题要求的行业名词。','tour 指一次旅行或巡回行程，不是旅游业。'],
(9,13):['none but 表“只有”，不是此句表达乐意程度的意思。','nothing but 表“仅仅是”；此句没有“仅此而已”的限制。','the chances are against 表机会不利，不表达乐意。','more than happy 在此强调非常乐意，而非数量上的比较。'],
(12,6):['describe 通常直接接描述对象，不能在此与 to 表示赞同观点。','prescribe 可指开处方、规定，不表示赞同解释。','subscribe to 可表示赞同或认可观点，符合 agree with 的语境。','circumscribe 指限制，不表示赞同观点。'],
(12,7):['prescription 指处方或规定，不是定期收取杂志的订阅。','manuscript 指手稿，不是定期购买安排。','subscription 指订阅；take out a subscription to 是这里的搭配。','description 指描述，不能表示杂志订阅。'],
(12,10):['subscribe 指订阅或赞同，不表示开具用药处方。','ascribe 指归因，通常用 ascribe something to something。','prescribe 指医生开具、指定治疗或药物，符合此处明确的治疗任务。','describe 指描述，不能表达本题明确要求的开具处方。'],
(40,6):['crust 指外壳或硬表层，不是盛水容器。','cape 可指海角或披肩，不是盛水容器。','delta 指三角洲，不是盛水容器。','basin 可指宽而较浅、可盛水的盆，符合洗手场景。']}
if (ROOT/'build/quiz-overrides.json').exists():
 raise SystemExit('One-shot historical script: refusing to overwrite existing content repairs. Append a reviewed batch instead.')
revision=int(time.time()*1000);entries=[]
def sig(q):return hashlib.sha256(json.dumps(q,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
for f in findings:
 _,course,l,_,n=f['qid'].split('/');key=(int(l),int(n));lid=course+'-'+l.zfill(2);old=next(q for q in store[lid]['questions']if q['id']=='q'+n)
 assert hashlib.sha256(json.dumps(old,ensure_ascii=False,sort_keys=True).encode()).hexdigest()==f['questionSha256'],f['qid']+' changed since review'
 q=copy.deepcopy(old);q['stem']=STEMS[key];q['revisionAt']=revision;q['revision']='2026-10-09.leak-repair-17';q['reviewerKind']='assistant-analysis';q['mode']='retrieval';q['objective']='在不提供待考结论的情况下识别 '+str(old['options'][old['answer']]['t']);q['testedItems']=[str(old['options'][old['answer']]['t'])];q['mentionedItems']=[]
 if key==(9,13):
  labels=['只有某些人乐意','仅仅是乐意而已','不太可能乐意','非常乐意'];q['options']={k:{'t':t,'note':note}for k,t,note in zip('ABCD',labels,notes[key])};q['explain']='more than happy 是强调非常乐意的表达；此处不是 more + 形容词 + than 的比较级结构。'
 elif key in notes:
  for k,note in zip('ABCD',notes[key]):q['options'][k]['note']=note
  q['explain']=q['options'][q['answer']]['note']
 elif key in [(3,11),(3,12)]:q['explain']='这题仅测试本课的多义关系分类，不把课堂联想当作英语词源证明。'+old['explain']
 entries.append({'lessonId':lid,'id':q['id'],'qid':f['qid'],'beforeSha256':sig(old),'afterSha256':sig(q),'question':q})
patch={'version':1,'revisionAt':revision,'sourceSha256':hashlib.sha256(raw).hexdigest(),'entries':entries}
(OUT/'source-quizzes.json').write_bytes(raw);(OUT/'quiz-overrides.json').write_bytes(json.dumps(patch,ensure_ascii=False,indent=2).encode())
(ROOT/'build/quiz-overrides.json').write_bytes((OUT/'quiz-overrides.json').read_bytes());print(json.dumps({'overrides':len(entries),'revisionAt':revision,'sourceSha256':patch['sourceSha256']}))
