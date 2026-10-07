"""Apply reviewed 83-question revisions to a COPY. Never writes production."""
import json, hashlib, copy, time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
B=ROOT/'docs/quiz-review-2026-10-07'
revision_at=int(time.time()*1000)
old=json.loads((B/'production-snapshot.json').read_text(encoding='utf-8-sig'))
new=copy.deepcopy(old); findings=json.loads((B/'confirmed-findings.json').read_text(encoding='utf-8'))
changed=set()
def locate(n,i):return next(q for q in new['items'][f'ndf-01-{n:02}']['questions'] if q['id']==f'q{i}')
def revise(n,i,stem,explain=None,choices=None):
 q=locate(n,i);q['stem']=stem
 if choices:
  assert len(choices)==4
  q['options']={k:{'t':t,'note':note} for k,(t,note) in zip('ABCD',choices)}
 if explain:q['explain']=explain
 q['revisionAt']=revision_at;q['revision']='2026-10-07.quiz-fix-83';q['mode']='retrieval';q['reviewerKind']='assistant-analysis'
 q['objective']=q['explain'];q['testedItems']=q.get('covers',[])[:1];q['mentionedItems']=[]
 changed.add((n,i));return q
S={
(1,11):'A meteor flashed across the night sky. 句中 meteor 指什么？',
(1,12):'The building has a large dome above its central hall. 句中 dome 指什么？',
(1,22):'In an office where everyone prefers routine, Maya is a rare bird: she is always eager to try something new. rare bird 在这里指什么？',
(1,23):'We should husband our limited energy resources. 句中 husband 的含义是什么？',
(1,24):'The program helps to channel students’ energy into research. 句中 channel 的含义是什么？',
(1,25):'The mosque has a large hemispherical ______ over its prayer hall.',
(1,26):'The warrior carried a short, pointed ______ as a weapon.',
(1,27):'Which adjective means living on land rather than in water?',
(2,4):'The professor agreed to ______ the offer of a research position. 空格需要表示“接受”的动词。',
(2,13):'Which profession specializes in investigating past societies through excavation and the study of material remains?',
(2,23):'A huge mass of snow suddenly slid down the mountain slope. This event is called an ______.',
(3,2):'I appreciate your help. appreciate 在这句话中的含义是什么？',
(3,7):'The unexpected announcement precipitated a crisis. precipitated 在这里最接近哪个意思？',
(3,8):'下列哪个短语表示供游客观赏游览的“景点”？',
(3,9):'The driver found a place reserved for leaving a car. 这个地点应称为哪一项？',
(6,15):'下列哪个名词表示一个人通过工作或投资获得的“收入”？',
(6,16):'下列哪个表达可以用作“内政部长”的职位名称？',
(7,10):'Which word is a verb meaning to focus attention on a particular activity?',
(7,11):'Which noun refers to the act of using goods, energy, or resources?',
(8,10):'Which noun names the process in which a solid dissolves in a liquid?',
(8,15):'consume 表示消耗。下列哪个是表示“消耗”这一过程的名词？',
(8,30):'An oak can live for hundreds of years. 句中 oak 指什么？',
(9,1):'课堂用 ceive/cept 词根家族帮助记忆 receive 与 accept。这个词根家族的核心联想义是哪一项？',
(9,2):'I did not buy the parcel; I ______ it as a gift. 空格需要表示“收到”的过去式。',
(9,4):'下列哪组分别是表示“感知”的动词、相关名词和表示“有洞察力的”的形容词？',
(9,7):'He tried to ______ the public into believing something that he knew was false.',
(9,8):'下列哪项正确区分 deceive、deception 和 deceptive 的词性与含义？',
(9,9):'The engineer conceived a plan for a new bridge. conceived 在这里表示什么？',
(9,13):'The law emancipated the enslaved people. emancipated 在这里表示什么？',
(9,14):'下列哪项正确说明 infant 和 baby 的词义关系？',
(10,1):'Which of these verbs means to give someone something for them to accept or refuse?',
(10,8):'Which word means working together, and must not be confused with corporation, meaning a company?',
(10,21):'Members receive ______ treatment: their bookings are handled before those of non-members.',
(10,24):'在 preferential 中，结尾部分属于哪一类后缀？',
(10,25):'The meeting was postponed because of the storm. This ______ was announced by email.',
(13,58):'Which adjective means steady and unlikely to change suddenly?',
(13,59):'These results ______ sharply with those of other medical tests carried out in Australia.',
(15,9):'A single theory is ______ the only explanation; several alternatives are also possible.',
(16,10):'Which verb means to find a way around an obstacle rather than deal with it directly?',
(16,15):'In a forest, branches and leaves form a dense overhead ______ that blocks sunlight.',
(16,33):'The ______ of computers changed how information was processed. 请选择表示“出现、到来”的名词。',
(16,40):'The police diverted traffic onto a side road. diverted 在这里表示什么？',
(17,8):'下列哪个短语表示“把某人的注意力从某人或某事上移开”？',
(17,10):'Which noun means a notice or message that promotes a product or service?',
(18,18):'在 contradictory 中，表示形容词的结尾是哪一项？',
(21,3):'下列哪个词可用作表示“合同”的名词，也可用作表示“收缩”的动词？',
(21,4):'下列哪组正确表达“与某公司订约”和“与某公司签一份合同”？',
(21,6):'Five minus two is three. 在这句话中，minus 是什么词性？',
(21,8):'Which verb means to remove or obtain a substance from something, as in obtaining oil from seeds?',
(23,4):'The evidence was compelling: it convinced the jury. What does compelling most nearly mean here?',
(23,6):'The guild supplied men who pulled the oars of its boats. These men are called ______.',
(23,10):'The two entrances were placed on opposite sides by design, not by accident. by design 在这里是什么意思？',
(24,4):'Your summary should be clear and ______: express the main idea in as few words as possible.',
(25,9):'The economic ______ of the 1930s caused widespread unemployment and falling output.',
(29,26):'Which noun names a social system in which women hold the principal positions of authority?',
(32,12):'A line separating two areas or territories is a ______.',
(32,14):'Which word is a formal general term for a ship or large boat?',
(33,13):'下列哪个短语表示“地中海气候”？',
(33,21):'Which verb can mean to produce flowers or to form a powdery deposit on a surface?',
(33,27):'A constructive geological process raises a broad area of the Earth’s surface. This upward movement is called ______.',
(33,29):'Which word is closest in meaning to ancestor?',
(33,40):'The outermost solid layer of the Earth, lying above the mantle, is the ______.',
(33,53):'Which adjective means relating to a large city or the surrounding urban area?',
(36,1):'课堂用 candle、candid、candor 联想 cand 词根。其核心联想义是哪一项？',
(39,17):'Which subject studies atmospheric processes, weather, and forecasting?',
(40,33):'The weather ______ predicts heavy rain tomorrow, so we should take umbrellas.',
(40,35):'Which of the following nouns is a synonym for ancestor?',
(42,3):'Alchemy was practiced long before modern chemistry. alchemy 的中文名称是什么？',
(42,4):'Which word means the political belief that government should not exist?',
(42,7):'Which noun refers to a scientist who studies plants?',
(42,13):'The sugar will ______ in water and become evenly mixed with it. Which verb fits?',
(42,36):'Which expression specifically refers to a brief period of rainfall?',
(42,37):'The sailors sought shelter from the tempest. Which noun is closest in meaning to tempest?',
(44,11):'Which mathematical term names a statement asserting that two expressions are equal?',
(44,28):'Five ______ two equals three. Which word fits the blank?',
(44,50):'The two numbers (3, 4) specifying a point’s position are its ______.',
(46,5):'The nature reserves were set up around new power stations to ______ local conservationists, who were upset about the development.',
(46,20):'Over many years, moving water can erode rock. erode 在这里是什么意思？',
(46,30):'The young forms of butterflies, such as caterpillars, are called ______ in scientific terminology.',
(48,12):'Which adjective describes a person or group that prefers to preserve traditional practices rather than make radical changes?',
(48,14):'The metropolitan area includes a large city and nearby suburbs. metropolitan 在这里表示什么？',
(48,22):'Which noun, containing the lect variant of the word family associated with choosing, names the process of choosing an official by voting?',
(48,25):'Which verb means to gather things together into a group?'
}
for (n,i),stem in S.items():revise(n,i,stem)
# Full option and explanation replacements where old answer/feedback cannot be retained.
def full(n,i,entries,explain):
 q=locate(n,i);assert len(entries)==4
 q['options']={k:{'t':t,'note':note} for k,(t,note) in zip('ABCD',entries)};q['explain']=explain;q['objective']=explain
full(1,12,[('圆屋顶、穹顶','dome 指圆形拱起的屋顶。'),('天文馆','天文馆是 planetarium，不是 dome。'),('怪兽状滴水嘴','雕饰滴水嘴可称 gargoyle，不是 dome。'),('博物馆','博物馆是 museum，不是 dome。')],'dome 是圆屋顶或穹顶；本题不以拼写相似证明与 home 同源。')
full(1,22,[('流星雨','meteor shower 表示流星雨，句中讨论的是人。'),('食肉动物','carnivore 指食肉动物，与办公行为无关。'),('不同寻常的人','这里以 bird 比喻人，rare bird 表示少见、与众不同的人，无须带贬义。'),('稀有的鸟','字面鸟类义不符合句中的办公室与人物语境。')],'rare bird 在这个人物语境中指不同寻常的人，不必译成贬义的奇葩。')
full(1,25,[('dagger','匕首，不是建筑顶部的半球形结构。'),('channel','通道或频道，不是穹顶。'),('dome','圆屋顶、穹顶，符合半球形建筑描述。'),('home','家或住所，不是建筑屋顶结构的名称。')],'dome 指穹顶；句子用 hemispherical 和 over its prayer hall 限定建筑结构。')
full(1,27,[('somnolent','昏昏欲睡的，不表示陆栖。'),('terrestrial','陆地的或陆栖的，与 in water 对比。'),('carnivorous','食肉的，描述食性而非栖息环境。'),('omnivorous','杂食的，描述食性而非栖息环境。')],'这里考 terrestrial 的陆栖义；不能用它代替 extraterrestrial 表示地球外的。')
q=locate(2,4);q['options']['A']={'t':'omit','note':'omit 表遗漏，不表示接受职位。'};q['options']['B']={'t':'evaporate','note':'evaporate 表蒸发，不能表示接受 offer。'};q['options']['C']={'t':'advertise','note':'advertise 表宣传，不符合题干指定的接受义。'};q['options']['D']['note']='accept an offer 表接受提议或职位邀约。';q['explain']='accept an offer 表接受邀约。本题明确要求接受义，不排斥 advocate 在其他语境中的合法用法。'
q=locate(2,13);q['options']['A']={'t':'astrophysicist','note':'天体物理学家研究天体物理，不是以发掘物质遗存研究过去社会的职业。'};q['options']['D']['note']='archeologist（也拼 archaeologist）是考古学家，以发掘和物质遗存研究过去社会。';q['explain']='考古学以发掘和物质遗存为主要证据；不能声称人类学家不会研究陶器。'
q=locate(2,23);q['options']['C']['note']='blizzard 是强风伴随的严重雪暴，也会造成积雪；但这里明确是雪体沿山坡滑落。';q['options']['D']['note']='avalanche 是雪体等沿山坡突然下滑，符合 slid down the mountain slope。';q['explain']='雪体突然沿山坡滑落是 avalanche；不能以是否掩埋道路区分雪崩和雪暴。'
full(3,2,[('发现一个斑点','spot 可表达发现或斑点，不是这里的 appreciate。'),('使某事加速发生','precipitate 可表示促使突然发生，不是感谢。'),('提前定价','题干没有定价含义，appreciate 此处不是定价。'),('感激、感谢','appreciate your help 表感谢帮助。')],'appreciate your help 表感激帮助；不能把辅音双写推广为含义加强的普遍规则。')
full(3,7,[('消失','crisis 没有消失，而是被引发。'),('减慢','此处不是减慢速度。'),('促使突然发生','precipitate a crisis 表促使危机突然发生。'),('停止','这里描述引发危机，不是停止危机。')],'precipitate 作动词可表示使某事突然发生；本题考真实语境，不考想象中物体的运动速度。')
full(3,8,[('scenic spot','风景优美的游览地点，可表示景点。'),('precipice spot','不是景点的通用固定表达；precipice 为悬崖。'),('parking spot','停车位，功能是停放车辆。'),('star spot','不能在这里表示旅游景点，star 为恒星或明星。')],'scenic spot 指供观赏的景点；选项应按含义和搭配判断。')
full(3,9,[('precipice spot','precipice 表悬崖，不表示车位。'),('parking spot','留给车辆停放的位置。'),('star spot','不是停车位的固定说法。'),('scenic spot','景点而非留给车辆的位置。')],'parking spot 表停车位，parking 限定其功能。')
q=locate(6,15);q['explain']='income 为收入；imprisonment 为监禁，imbalance 为不平衡，immigrate 为移入。这里明确问收入，不否定多个单词中 in-/im- 的向内义。'
for k,t in zip('ABCD',['收入，符合名词定义。','监禁，不是收入。','不平衡，不是收入。','移入某国的动词，不是收入。']):q['options'][k]['note']=t
q=locate(6,16);q['options']['D']={'t':'finance minister','note':'财政部长，主管财政，不等于内政部长。'};q['explain']='minister of the interior 和 interior minister 都可表示内政部长；本题未把两个同义正确表达同时设为互斥选项。'
full(7,10,[('select','挑选，不是把注意力集中到活动。'),('consumption','消费或消耗的名词，不是集中注意的动词。'),('strength','力量的名词，不是动词。'),('concentrate','集中注意，符合 focus attention。')],'concentrate 是动词，表示集中注意；本题用定义独立识别，不用同词作比较样例。')
full(7,11,[('produce','产生或生产的动词。'),('results','结果，不是使用资源的过程。'),('select','挑选的动词。'),('consumption','消费或消耗，表示使用物品或资源的过程。')],'consumption 是消费或消耗的名词，不与题干样例重复给出答案。')
full(8,10,[('description','描述。'),('circulation','循环。'),('dissolution','溶解这一过程，可作为 dissolve 的相关名词。'),('development','发展。')],'dissolution 可表示溶解过程；solution 可表示溶液或解决方案，不能把 dissolve 的直接名词形式错误地记成 solution。')
q=locate(8,15);q['explain']='consume 的相关名词是 consumption，意为消耗或消费；本题问完整名词而不是音变片段。'
q=locate(8,30);q['explain']='oak 指橡树。题面为新造例句，不冒充原逐字稿的乱码句。'
full(9,1,[('拿、取（take）','ceive/cept 家族的课堂联想义为拿、取。'),('看、见（see）','与视觉相关的常见词根如 vis/spect；不是 ceive/cept 的核心联想。'),('说、讲（speak）','与说话相关的常见词根如 dict；不是 ceive/cept。'),('写、记（write）','与写相关的常见词根如 scrib/script；不是 ceive/cept。')],'ceive/cept 家族可联想拿、取；课堂构词联想不能替代所有词的完整词源或现代词义。')
full(9,2,[('perceived','感知到，不表示收到礼物。'),('received','receive 的过去式，收到礼物。'),('accepted','接受或同意，原题若用此项可形成竞争；此项需更换。'),('deceived','欺骗，不能在这里表示收到物品。')],'receive a parcel 表收到包裹。')
# Remove the same-meaning rival instead of pretending receive and accept are exclusive here.
locate(9,2)['options']['C']={'t':'excavated','note':'挖掘，不表示收到别人赠送的包裹。'}
q=locate(9,4);q['explain']='perceive 为动词，perception 为感知名词，perceptive 为有洞察力的形容词；这是具体词族关系，不宣称所有 -ion/-ive 永远成对。'
q=locate(9,8);q['explain']='deceive 为欺骗的动词，deception 为欺骗的名词，deceptive 为欺骗性的形容词。'
q=locate(9,9);q['options']['D']={'t':'想出、构思','note':'conceive a plan 表构思计划，符合工程师设计桥梁的语境。'};q['explain']='conceive a plan 表构思计划。conceive 的怀孕义不适用于这个 plan 语境。'
q=locate(9,13);q['explain']='emancipate 表解放、使摆脱束缚；不需要题干先给词根联想的结论。'
q=locate(9,14);q['explain']='infant 和 baby 都能指婴儿；infant 较正式。这里检验词义关系，不在题干预告该关系。'
full(10,1,[('offer','提供、提出，让对方接受或拒绝。'),('infer','推断，从证据得出结论。'),('conform','遵守、符合，不是提出给予。'),('differ','不同、有区别。')],'offer 表提供或提出；不用多个都符合 fer 词族条件的选项强行分出唯一答案。')
full(10,8,[('conscious','有意识的，不是共同合作。'),('consolidated','合并或加固的，不是合作这个名词。'),('cooperation','合作；与 corporation 公司在拼写和含义上都需区分。'),('conform','符合或遵守的动词，不是合作名词。')],'cooperation 为合作，corporation 为公司，二者不是近义词。')
full(10,24,[('名词后缀','不是 preferential 的形容词功能。'),('副词后缀','preferential 不是副词。'),('形容词后缀','preferential 是表示优先待遇的形容词。'),('动词后缀','preferential 不是动词。')],'preferential 是形容词，词尾参与构成形容词；题干不再直接给 -ial 作为答案。')
q=locate(13,58);q['explain']='stable 为稳定的，stabilize 为使稳定的动词，obstacle 为障碍，establish 为建立。';
for k,t in zip('ABCD',['稳定的，符合 steady。','障碍的名词，不是稳定的形容词。','使稳定的动词，不是形容词。','建立的动词，不是形容词。']):q['options'][k]['note']=t
q=locate(13,59);q['explain']='复数主语 These results 后用 contrast；contrast sharply with 表与另一组结果形成鲜明对比。'
q=locate(15,9);q['options']['B']={'t':'in advance','note':'提前，不表示绝非。'};q['explain']='by no means 表绝不、绝非；in no way 也有相同否定义，不能同时作为该题的错误竞争项。'
q=locate(16,33);q['explain']='advent 为重要事物的出现或到来；adventure 为冒险，不能把它简单当成 advent 加 -ure。';q['options']['B']['note']='adventure 为冒险，不是这里指定的出现、到来。'
q=locate(16,40);q['explain']='divert traffic onto a side road 表把交通转移到另一条路。'
q=locate(18,18);q['explain']='contradictory 的形容词结尾为 -ory；不能把 contradiction 直接加 -ory 当作拼写运算。';q['options']['A']['note']='-ory 是 contradictory 的形容词结尾；正确词形为 contradictory。'
full(21,4,[('contract with a company；sign a contract with a company','两种说法都可表达与公司订约；单数 contract 作为合同名词需要 a。'),('contract at a company；sign a contract at a company','at 可表达地点，不能替代这里要求的签约对象 with。'),('contract from a company；sign a contract from a company','from 表来源，不能在这里表达与公司订约。'),('contract under a company；sign a contract under a company','under 不表示这里要求的与公司作为双方订约。')],'contract with 表与某方订约，sign a contract with 表与某方签一份合同。')
full(21,6,[('名词','在本句中并非指负号或缺点的名词。'),('形容词','在 minus number 等表达可作形容词，但本句是数字之间的减去关系。'),('介词','Five minus two 中 minus 表减去指定的数量。'),('副词','这里连接数值并表达减去关系，不是副词修饰。')],'minus 在 Five minus two 中按介词用法理解；它在其他结构还可作名词或形容词。')
full(23,6,[('rowers','划船的人，即桨手，使用 oars。'),('remarks','言论，不是划船的人。'),('guilds','行会或协会，不是桨手。'),('drafts','草稿或征召，不是桨手。')],'rower 是桨手；roller 不等于桨手。本题不使用来源中混乱的 were served compulsively。')
q=locate(23,10);q['explain']='by design 与 by accident 对比，表示有意地，不是通过设计图完成。'
q=locate(24,4);q['options']['D']={'t':'subterranean','note':'地下的，不表示用少量词表达要点。'};q['explain']='concise 表简明的；as few words as possible 明确考精简表达。precise 表精确，两者可以共存，不应在无额外限定时互斥。'
full(29,26,[('hierarchy','等级结构，不专指女性掌握权威。'),('monarchy','君主制，不以女性权威为定义。'),('patriarchy','父权制，男性掌握主要权威。'),('matriarchy','母权制，女性掌握主要权威。')],'matriarchy 是母权制的名词。母系继承 matrilineal 并不必然等于母权统治；本题不把名词直接放到 society 前当形容词。')
q=locate(32,12);q['explain']='demarcation line 是分界线，不专指某一条国境线。';q['options']['D']['note']='demarcation line 表划定地区或范围边界的线。'
full(32,14,[('navy','海军，指军队组织而非一般船只。'),('marine','海洋的；作名词可指海军陆战队员，不是船的一般正式名称。'),('vessel','船或大型船只的正式一般名称，也可有容器、血管等义。'),('submarine','潜水艇是特定船只，不是 ship/large boat 的一般名称。')],'vessel 可正式泛指船；并不表示导航仪。submarine 是特定船只，不能声称它不属于舰艇。')
q=locate(33,13);q['options']['A']['note']='tropical climate 为热带气候，不是地中海气候。';q['options']['B']['note']='polar climate 为极地气候，不是地中海气候。';q['explain']='Mediterranean climate 表地中海气候；这里不以拆音联想证明完整词源。'
q=locate(33,21);q['options']['D']={'t':'evaporate','note':'蒸发，不表示开花或表面析出粉状物。'};q['explain']='effloresce 可表示开花或表面析出粉状物；flower 也可作开花的动词，不能以它只有名词义判错。'
q=locate(33,27);q['explain']='uplift 是地面抬升。火山喷发也能形成新地貌；本题以向上抬升的过程明确限定。';q['options']['B']['note']='eruption 表喷发，不是本题指定的地表广域向上抬升这个过程。'
q=locate(33,40);q['covers']=['crust'];q['testedItems']=['crust'];q['explain']='crust 指地壳，位于 mantle 地幔之上；修正后的句子不再出现 crust of the crust。'
q=locate(36,1);q['options']['A']['note']='火与燃烧不是题干词族所聚焦的白亮联想。';q['options']['B']['note']='照片涉及 photo；cand 也与光亮相关，但不是照片这个概念。';q['options']['C']['note']='声音听觉不是 candle/candid/candor 的核心联想。';q['explain']='课堂用 cand 的白、亮联想 candle/candid/candor；标明这是词族记忆联想，不从未讲某词根推断错误。'
full(39,17,[('astronomy','天文学，研究天体与宇宙。'),('astrophysics','天体物理学，研究天体物理性质。'),('meteorology','气象学，研究大气和天气。'),('astrology','占星术，不是天气研究学科。')],'meteorology 为气象学，研究大气和天气，不是天文学或占星术。')
q=locate(40,33);q['explain']='weather forecast 表天气预报；rain 是降雨，两者不等同。';q['options']['D']['note']='forecast 是预测或预报；weather forecast predicts... 是成立的句子。'
for k,t in zip('ABC',['fog 是雾，不能作预测明日天气的主体。','gale 是大风，不能作预测明日天气的主体。','frost 是霜，不能作预测明日天气的主体。']):q['options'][k]['note']=t
q=locate(42,3);q['explain']='alchemy 为炼金术；题干没有预先给出中文答案。'
q=locate(42,4);q['explain']='anarchism 表无政府主义；题目考词义，不以它自身作前缀迁移样例。'
q=locate(42,7);q['explain']='botanist 为植物学家；botany 为植物学。'
q=locate(42,13);q['explain']='dissolve 表溶解，糖溶解在水里；题干不给目标动词。'
q=locate(42,36);q['options']['D']['note']='a shower of snow 指短时降雪，本题明确要求 rainfall 降雨。';q['explain']='a shower of rain 为短时降雨；a shower of snow 也可以成立，但不满足本题明确限定的降雨义。'
q=locate(42,37);q['explain']='tempest 指猛烈的暴风雨，近义词为 storm；题干保留目标词，不预先给释义。'
q=locate(44,11);q['explain']='equation 为表示两个表达式相等的等式；定义区别于一般表达式 expression 和不等式 inequality。'
q=locate(44,28);q['options']['A']['note']='subtraction 是减法名词，不能直接填入 Five ... two。';q['options']['B']['note']='subtracted 是过去式/分词，需要不同的句法结构。';q['options']['C']['note']='subtract 是动词，应使用 subtract two from five，而不是 Five subtract two equals three。';q['options']['D']['note']='minus 在数值之间表示减去，Five minus two equals three 成立。';q['explain']='Five minus two equals three 表五减二等于三；本题明确了填空位置。'
q=locate(44,50);q['options']['C']={'t':'coordinates','note':'一对表示点位置的数值为 coordinates，复数形式。'};q['explain']='(3,4) 给出两个坐标分量，所以用复数 coordinates；不能把整对数值称为单个 a coordinate。'
full(46,5,[('breed','繁殖或培育，不是使不满者平静。'),('hatch','孵化或策划，不表示安抚不满者。'),('mollify','安抚，使不满的人平静；to 后用原形。'),('migrate','迁徙，不表示安抚。')],'to mollify local conservationists 表为了安抚当地保护主义者；不定式 to 后用 mollify，而不是 mollifying。')
q=locate(46,20);q['options']['C']={'t':'侵蚀、逐渐磨损','note':'erode rock 表使岩石逐渐受侵蚀，不要求全部咬掉。'};q['explain']='erode 表侵蚀或逐渐磨损；其拼写中没有 de-，不沿用来源里的错误拆分。'
q=locate(46,30);q['options']['C']={'t':'pupae','note':'蛹是幼虫后的阶段，不是本题所问的幼虫。'};q['options']['D']={'t':'adults','note':'成虫是后续成熟阶段，不是幼虫。'};q['explain']='caterpillars 就是蝴蝶/蛾的 larvae 幼虫；其后为 pupae 蛹，再成为成虫。不是先变幼虫再变毛毛虫。'
q=locate(48,14);q['options']={'A':{'t':'寒冷的','note':'cold/chilly 表寒冷，不是 metropolitan。'},'B':{'t':'乡村的','note':'rural 表乡村的，与大城市语境不同。'},'C':{'t':'地下的','note':'underground/subterranean 表地下的，不是 metropolitan。'},'D':{'t':'大都市及其周边地区的','note':'metropolitan 指大都市及周边城市地区的。'}};q['tags']=['metropolitan'];q['covers']=['metropolitan'];q['testedItems']=['metropolitan'];q['explain']='metropolitan 表大都市及其周边地区的；这个词不含 chill，题目不沿用转写错误。'
q=locate(48,22);q['explain']='election 为选举，包含 lect 这一与选择相关的词族变体；不把同源改写成字面含 lig。'
q=locate(48,25);q['explain']='collect 表收集、聚集，不等于整个单词表示选择。';q['options']['B']['note']='collect 是把东西收集到一起，符合 gather things together。'
# Remove unsupported source-wide claims remaining in revised feedback, not just stems.
for n,i in changed:
 q=locate(n,i)
 for k,o in q['options'].items():
  if any(x in o['note'] for x in ['本节没有','本节未','老师没有','老师未','课堂没有','课堂未','不是本节课所讲']):
   o['note']=f"{o['t']}：请依据本题明确的词义、词性与语境判断。" if k!=q['answer'] else q['explain']
 q['objective']=q['explain'];q['testedItems']=q.get('covers',[])[:1]
expected={(int(f['lesson'][-2:]),int(f['id'][1:])) for f in findings}
assert changed==expected,(expected-changed,changed-expected)
# Metadata: keep old question snapshots for historical answers and invalidate cached AI feedback by signature.
manifest=[]
for f in findings:
 n=int(f['lesson'][-2:]);i=int(f['id'][1:]);before=next(q for q in old['items'][f['lesson']]['questions'] if q['id']==f['id']);after=locate(n,i)
 sig=lambda q:hashlib.sha256(json.dumps(q,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
 assert sig(before)==f['questionSha256']
 after['supersedes']=sig(before);after['reviewedAt']='2026-10-07';after['reviewStatus']='revised-assistant-reviewed'
 manifest.append({'lesson':f['lesson'],'id':f['id'],'recordId':f"gen/ndf-01/{n}/quiz/{i}",'before':before,'after':after,'beforeSha256':sig(before),'afterSha256':sig(after)})
out=ROOT/'docs/quiz-fix-2026-10-07';out.mkdir(exist_ok=True)
(out/'corrected-quizzes.json').write_text(json.dumps(new,ensure_ascii=False,indent=1),encoding='utf-8')
(out/'patch-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Revised questions:',len(manifest),'Total:',sum(len(q['questions']) for q in new['items'].values()))
