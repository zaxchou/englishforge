"""Append reviewed content repairs; originals and existing revisions are immutable."""
import json,hashlib,copy,time,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'docs/repair-2026-10-09'
raw=(ROOT.parent/'data/toefl-lab-production/records/generated-quizzes.json').read_bytes();store=json.loads(raw.decode('utf-8-sig'))['items']
patchfile=ROOT/'build/quiz-overrides.json';patch=json.loads(patchfile.read_text(encoding='utf-8'))
# Each record: lesson, id, revised task, correct rationale, four option rationales.
SPECS=[
(8,15,'Salt is evenly distributed throughout water after it dissolves. What is this homogeneous mixture called?', 'solution 在化学中表示溶液；dissolve 的对应过程名词是 dissolution，不能把 dissolve → solution 当作机械添加后缀的词形规律。',['dissolution 指溶解等过程，不是这里所问的混合物。','suspension 指有未溶解微粒悬浮的悬浮液，不是题面均匀溶解的情况。','solvent 指溶剂，如这里的水，而不是溶解后的混合物。','solution 指溶液这一均匀混合物。']),
(8,5,'哪一个名词指负责检查和治疗牙齿的专业人员？','dentist 指牙医，dent 与牙齿有关，-ist 可用于职业名称。',['scientist 是科学家。','tourist 是游客。','dentist 是牙医。','assistant 是助手。']),
(8,11,'每年同一天纪念一件重要事情发生的日子，应该用哪个名词？','anniversary 指周年纪念日，ann 与年有关。',['auditorium 是礼堂。','bakery 是面包店。','anniversary 是周年纪念日。','aluminum 是铝。']),
(8,22,'Their long-lasting ______ grew from years of helping each other. 空格需要表示“友谊”的抽象名词。','friendship 表示友谊；friend + -ship 构成这个名词。',['friend 指朋友个人。','friendshiply 不是表示友谊的标准词形。','friendship 是表示友谊的名词。','friendly 表示友好的，是形容词。']),
(8,27,'签订结束战争的协议具有重大历史意义。若要强调“具有重大历史意义的”，用哪个形容词？','historic 强调重大历史意义；historical 主要表示与历史有关。',['historical 表示与历史有关，未必重大。','historic 强调重大历史意义。','huge 表示尺寸或程度很大。','national 表示国家的。']),
(8,31,'哪一个名词表示一千年的时间跨度，而不是数字一百万？','millennium 表示千年期；million 表示一百万，两者不能混用。',['million 是数字一百万。','millennium 是千年期。','marriage 是婚姻。','measure 是测量或衡量。']),
(8,32,'They celebrated twenty years of ______. 空格需要表示婚姻关系的名词。','marriage 是婚姻；marry 是结婚这一动词。',['marriage 是婚姻这一名词。','measurable 是可衡量的这一形容词。','national 是国家的这一形容词。','marry 是动词，不能作为这里的婚姻名词。']),
(8,50,'哪一个单数名词表示受雇在他人家中做家务的人，而非服务行为或一份食物？','servant 可指受雇的家仆；普通餐厅服务员通常用 waiter/server，不能全部混为一谈。',['service 是服务行为或服务。','servile 是奴性的这一形容词。','serving 可指一份食物。','servant 可指家仆。']),
(8,53,'A water ______ forced the town to limit daily use. 选择表示供应不足的名词。','shortage 指缺乏或短缺，water shortage 表示缺水。',['marriage 是婚姻。','package 是包裹。','shade 是阴影或树荫。','shortage 是供应短缺。']),
(8,54,'The discovery was ______ because it changed how the disease was treated. 空格强调发现的重要意义，不是体积巨大。','significant 在这里表示有重要意义的、重大的。',['enormous 强调巨大规模，不是此处的重要意义。','significant 强调重要意义。','confident 表示有信心的。','different 表示不同的，不表达重要意义。']),
(8,56,'A person enrolled at a school or university is a ______. 选择表示学习者身份的名词。','student 表示学生。',['president 是总统或机构负责人。','applicant 是申请者。','student 是学生。','assistant 是助手。']),
(8,57,'The new technology could ______ the entire industry, changing its basic structure. 空格要求表示彻底改变的动词。','transform 表示使发生显著、彻底的改变。',['shade 是遮阴等意思。','visit 是参观或拜访。','transform 表示彻底改变。','ride 是骑乘。']),
(8,58,'We plan to ______ our grandparents this weekend. 空格表示前往看望某人，需要动词。','visit 表示看望或拜访；其他选项也与视觉有关，但词性和本句意思不同。',['visit 是看望这一动词。','visual 是视觉的这一形容词。','vision 是视觉或愿景这一名词。','visible 是可见的这一形容词。']),
(12,3,'Having little understanding of natural causes, they ascribed desirable and undesirable ______ to supernatural forces. 空格指发生的好事和坏事。','occurrences 是发生的事情或事件的复数。',['habitats 指栖息地；不要把课堂联想当作词源分解。','subscriptions 指订阅。','occurrences 指发生的事件。','prescriptions 指处方或规定。']),
(12,9,'Which verb means to explain the meaning of a text or idea carefully and in detail?','explicate 表示详细阐释文本或观点；不意味着写作中总比 explain 更好。',['prescribe 是开处方或规定。','subscribe 是订阅或赞同。','explicate 是详细阐释。','describe 是描述事物的特征，不是此题要求的阐释其含义。']),
(17,7,'Some people prefer studying alone; ______, others learn better in groups. 选择引出对照观点的短语。','on the other hand 可引出另一种对照情况；不应把 conversely 在所有语境中都等同于这个短语。',['on average 表示平均而言，never 不表示平均。','in other words 表示换句话说，属于重述。','in the same way 表示同样地，不表达这里的对照。','on the other hand 表示另一方面，引出对照。']),
(22,2,'本课用 sub- 与 press 的组合解释一个动词：b 在拼写中变成后面的 p。选择表示镇压或压制的对应词。','suppress 表示压制或镇压；这里测试本课构词辨认，不提前给出结果。',['impress 表示使留下印象。','depress 可表示压下或使沮丧，但不是所指定的 sub- 组合。','express 表示表达。','suppress 表示镇压或压制。']),
(32,10,'The country expanded its ______ by building more warships. 空格指海军这一军事组织，需要名词。','navy 指海军；naval 是海军的这一形容词。',['navigate 是导航或航行的动词。','naut 不是这里可独立使用的海军名词。','navy 是海军这一名词。','naval 是形容词，不能作此处组织名称。']),
(34,22,'这场灾难会对农业产生灾难性的影响。补全 The disaster will ______ agriculture. 空格需要完整、可直接接 agriculture 的短语。','have a disastrous effect on 中 effect 是名词，本句单数可数名词前需要 a，对影响对象用 on。',['have disastrous effect on 在本句缺少 a 或复数形式。','本句需要名词 effect；affect 常作动词，在心理学也可作名词，但不是这里的影响义。','have a disastrous effect on 可以完整接上 agriculture。','表示对 agriculture 的影响这里用 on，不用 in。']),
(34,23,'We would be ______ if the dam failed. 选择表示“面临灾难性后果”的完整搭配；修饰复数名词需要形容词。','confronted with catastrophic consequences 表示面临灾难性后果。confronted by 也可成立，不能仅因课堂用 with 就判 by 错。',['catastrophically 是副词，不能这样直接修饰 consequences。','这里不用 confronted to 引入所面临的后果。','consequently 是副词，不是所需的复数名词。','confronted with catastrophic consequences 词性和搭配均成立。']),
(34,24,'快速通信使世界像一个紧密联系的村落。哪一个约定俗成的短语表达“地球村”？','global village 是地球村这一常见表达。',['world village 不是本题所要求的约定俗成表达。','global city 指全球性城市，意义不同。','global village 表示地球村。','global town 不是这里的约定俗成表达。']),
(34,25,'一个系统正在绕自身轴旋转。要用 rotate 的现在分词直接修饰 system，应选择哪一项？','rotating system 中 rotating 是现在分词，可表示正在旋转的系统；不能仅凭这个短语解释为公转系统。',['rotational 是形容词，能修饰 system，但不是要求的现在分词。','rotation 是名词，可作名词修饰语，但不是现在分词。','rotating 是 rotate 的现在分词。','rotated 是过去式或过去分词，不是现在分词。']),
(38,6,'They tried to ______ the witness into remaining silent. 空格需要表示恐吓的动词，而不是该行为的名词。','intimidate 是恐吓这一动词；intimidation 是对应名词。',['amity 是和睦这一名词。','intimidate 是恐吓这一动词。','intimidation 是恐吓这一名词，不能放在 to 后作动词。','timid 是胆怯的这一形容词。']),
(38,7,'选择能表示“通过恐吓使某人做某事”的完整结构，动作须用 doing 的形式。','intimidate somebody into doing something 表示通过恐吓迫使某人做某事。',['for doing 表示因为某事，不是迫使去做的结果结构。','of doing 不是这里的结构。','into doing 引入受恐吓后做出的行为。','to do 不是本题要求的 into doing 结果结构。']),
(38,12,'本地居民在业余时间排演话剧。哪一个短语通常表示这种非职业的戏剧活动？','amateur dramatics 表示业余戏剧活动。',['amateur dramatics 是业余戏剧活动。','timid 是胆怯的，不表达非职业活动。','amiable 是和蔼的，不表达非职业活动。','amicable 是友好的，不表达非职业活动。']),
(39,9,'The paint gives off a soft light in the dark. Which adjective describes the paint itself as emitting light?','luminous 是形容词，表示发光的、明亮的。表示某领域杰出人物的名词是 luminary，不能将这两个词混用。',['luminous 可描述本身发光的涂料。','illuminating 常表示照亮其他东西的或有启发性的，不是此题所指定的自身发光描述。','glow 是名词或动词，不是这里需要的形容词。','lunar 表示月球的。']),
(39,19,'哪一个选项是化学元素“铀”的英文名称，而不是与流星或气象学有关的词？','uranium 是化学元素铀；不能把所有 -um 结尾的词都当成元素。',['meteorite 是陨石。','uranium 是铀。','meteoroid 是流星体。','meteorology 是气象学。']),
(40,11,'A chain or group of islands is called an ______. 选择表示群岛的名词。','archipelago 的现代常用义是群岛，不是首要或统领；构词联想不能代替整个词的含义。',['alpha 可指希腊字母中的第一个。','attitude 是态度。','archipelago 是群岛。','antibiotics 是抗生素。']),
(40,14,'地球最内部、位于地幔之下的部分，用哪个英文名词表示？','core 在地球结构中指地核。',['core 指地核。','mantle 是地幔。','basin 是盆地或盆，不是地核。','crust 是地壳。']),
(46,4,'A lion hunts other animals for food. In this relationship, the lion is the ______. 空格指捕食者。','predator 指捕食者；prey 指被捕食的猎物。',['herbivore 是食草动物。','predator 是捕食者。','parasite 是寄生者，关系与题面不同。','prey 是被捕食的猎物。']),
(46,6,'She was ______ the angry customer by apologizing and offering a refund. 空格表示安抚，并需与 was 构成进行时。','mollifying 是 mollify 的 -ing 形式，表示安抚或平息愤怒。',['mollifying 表示安抚，可接 the angry customer。','microbe 是微生物这一名词。','melt 不是所需的 -ing 形式，也不接人表示安抚。','mollusk 是软体动物这一名词。']),
(46,8,'两种生物一起生活，并相互依赖。哪一个形容词表示这种共生关系？','symbiotic 是共生的这一形容词。',['thermometer 是温度计。','symbiotic 表示共生的。','biology 是生物学这一名词。','biography 是传记这一名词。']),
(46,11,'A large number of bees clustered together. 选择专门以昆虫成群聚集来表达“一群”的常用短语。','a swarm of 是描写成群昆虫的常用短语；a host of 也能泛指大量，不能断言其语法错误，但不表达题面要求的专门群体名称。',['a host of 泛指大量，未特指昆虫群体。','a swarm of 常用于蜂群等成群昆虫。','a flock of 通常用于鸟群或羊群。','a herd of 通常用于牛等兽群。']),
(46,12,'The conspirators secretly devised a detailed scheme. Which phrase means to formulate a plan, often secretly?','hatch a plan 表示构思或秘密策划一个计划。',['fall prey to 表示成为受害者或受到伤害。','hatch a plan 表示策划计划。','breed 表示繁殖等，不是此处策划短语。','flock to 表示蜂拥而至。']),
(46,13,'A parasite lives on or inside another organism. What is that organism called in this relationship?','host 在寄生关系中指寄主；parasite 是寄生者。',['prey 是猎物。','predator 是捕食者。','host 是寄主。','parasite 是寄生者本身。']),
(46,14,'A mouse belongs to a group of mammals with continuously growing front teeth used for gnawing. Which noun names an animal in this group?','rodent 表示啮齿动物，如鼠类。',['herbivore 是食草动物，按食性分类而非此处动物类群。','reptile 是爬行动物，不是这种哺乳动物。','erode 是侵蚀这一动词。','rodent 是啮齿动物。']),
(14,6,'请选择表示“关于、就……而言”的短语，而不是因尊敬某人、在某人监督之下或对危险保持谨慎。','in respect of 表示关于或就某事而言；with respect to 也可表达类似意思，因此不应作为此语义题的错误选项。',['have a healthy respect for 可表示对危险等保持谨慎或敬畏。','in respect of 表示关于。','under the supervision of 表示在监督之下。','out of respect for 表示出于对某人的尊重。']),
(26,6,'The result was ______ impressive. 空格表示“极其”，不带“超过合理限度、过分”的含义。','exceedingly 表示极其、非常；excessively 强调过度，二者不能不加区别地替换。',['negligibly 表示程度小到可忽略。','drastically 表示剧烈地或大幅度地，不是此处程度副词的常用选择。','exceedingly 表示极其。','excessively 表示过分，不符合题面明确排除过度的条件。'])
]
def sig(q):return hashlib.sha256(json.dumps(q,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
revision=int(time.time()*1000);added=[];existing={(e['lessonId'],e['id'])for e in patch['entries']}
assert hashlib.sha256(raw).hexdigest()==patch['sourceSha256'],'source drift: review before proceeding'
for l,n,stem,explain,notes in SPECS:
 lid=f'ndf-01-{l:02}';qid=f'q{n}';assert(lid,qid)not in existing,'already patched; do not rerun'
 old=next(q for q in store[lid]['questions']if q['id']==qid);q=copy.deepcopy(old);q['stem']=stem;q['explain']=explain
 if(l,n)==(8,15):
  for k,t in zip('ABC',['dissolution','suspension','solvent']):q['options'][k]['t']=t
 if(l,n)==(39,9):q['options']['B']['t']='illuminated';notes[1]='illuminated 表示被照亮的，不说明自身发光。'
 if(l,n)==(14,6):q['options']['D']['t']='out of respect for'
 if(l,n)==(34,23):
  for k,t in zip('ABC',['confronted with catastrophically consequences','confronted to catastrophic consequences','confronted with catastrophic consequently']):q['options'][k]['t']=t
 for k,note in zip('ABCD',notes):q['options'][k]['note']=note
 q.update(revisionAt=revision,revision='2026-10-09.semantic-repair-38',reviewerKind='assistant-analysis',mode='retrieval',objective=explain,testedItems=[q['options'][q['answer']]['t']],mentionedItems=[])
 answer=q['options'][q['answer']]['t'];assert not re.search(r'(?<![A-Za-z])'+re.escape(answer)+r'(?![A-Za-z])',stem,re.I),(lid,qid,'answer in stem')
 e={'lessonId':lid,'id':qid,'qid':f'gen/ndf-01/{l}/quiz/{n}','beforeSha256':sig(old),'afterSha256':sig(q),'question':q};added.append(e)
patch['entries'].extend(added);patch['revisionAt']=revision
(OUT/'quiz-overrides-before-semantic.json').write_bytes(patchfile.read_bytes());patchfile.write_bytes(json.dumps(patch,ensure_ascii=False,indent=2).encode());(OUT/'quiz-overrides.json').write_bytes(patchfile.read_bytes());(OUT/'semantic-repair-38.json').write_bytes(json.dumps({'revisionAt':revision,'entries':added},ensure_ascii=False,indent=2).encode());print(json.dumps({'added':len(added),'total':len(patch['entries'])}))
