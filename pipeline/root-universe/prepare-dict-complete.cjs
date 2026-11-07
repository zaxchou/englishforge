'use strict';
// Builds the extended 1.1.0 dict learning profile from the frozen classroom scope; candidate-only until independently reviewed.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const base=ws.bytes(ws.ROOT,'learning/dict/candidates/alliance/entry.json');
if(kit.sha(base)!=='db8920640e788d2c413cd83409cbf06041800478679a7257371d5e0c71385a25')throw Error('BASE_ENTRY_CHANGED: '+kit.sha(base));
const entry=JSON.parse(base);
const scopePath='build/qa/root-universe/review-20261107/dict-classroom-scope.json';
const scopeRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,scopePath));
const scope=JSON.parse(scopeRaw);
if(!Array.isArray(scope.occurrences)||scope.occurrences.length!==58)throw Error('SCOPE_OCCURRENCES '+scope.occurrences?.length);
const courseRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,'build/vocab/cfcm-words.json'));
const course=JSON.parse(courseRaw),courseIndex=new Map();
for(const b of course.batches||[])for(const w of b.words||[])courseIndex.set(String(w.w).toLowerCase(),{lesson:w.lesson,ipa:w.ipa||'',def:w.def||'',sen:w.sen||'',senZh:w.senZh||''});
// sense_id only for the three words whose fact-graph senses are already approved; all others stay learning-scoped.
const senseByWord=Object.fromEntries(entry.words.map(w=>[w.word,w.sense_id]));
const profiles=Object.fromEntries(entry.words.map(w=>[w.word,w]));
const newSources=[
 ['Edigit','digit','{{ety|en|:inh|enm:digit|tree=1|text=:la}} {{dbt|en|digitus|dedo}}.'],
 ['Eteach','teach','From {{inh|en|enm|techen}}, from {{inh|en|ang|tǣċan|t=to show, declare, demonstrate; teach, instruct, train; assign, prescribe, direct; warn; persuade}}, from {{inh|en|gmw-pro|*taikijan}}, from {{inh|en|gem-pro|*taikijaną|t=to show}}, from {{der|en|ine-pro|*deyḱ-|t=to show}}.'],
 ['Etoken','token','From {{inh|en|enm|token}}, {{m|enm|taken}}, from {{inh|en|ang|tācn|t=sign, symbol}}, from {{inh|en|gmw-pro|*taikn}}, from {{inh|en|gem-pro|*taikną|t=indicator, symbol, sign}}.'],
 ['Epredicament','predicament','From {{inh|en|enm|predicament}}, from {{der|en|fro|predicament}}, from {{der|en|la-lat|praedicāmentum|t=that which is predicated, a predicament, category}}.'],
 ['Eparadigm','paradigm','From {{inh|en|enm|paradygme}}, from {{der|en|la-lat|paradīgma}}, from {{der|en|grc|παράδειγμα||pattern}}, from {{m|grc|παραδείκνυμι||I [[show]] [beside] or [[compare]]}} + {{m|grc|-μα|pos=suffix forming nouns concerning the results of actions}}.'],
 ['Esyndicate','syndicate','from {{der|en|la-med|*syndicātus}}, from {{m|la|syndicus||representative of a [[corporation]] or [[town]]; syndic}} (from {{der|en|grc|σύνδικος||[[advocate#Noun|advocate]] for a [[defendant]]}}, from {{m|grc|σύν||[[beside]]; [[with]]}} + {{m|grc|δίκη||[[judgment]]; [[justice]]}})'],
 ['Ejudicial','judicial','{{ety|en|:bor|la:iūdiciālis|text=+|tree=1}}'],
 ['Eprejudice','prejudice','From {{inh|en|enm|prejudice}}, from {{der|en|fro|prejudice}}, derived from {{der|en|la|praeiūdicium||previous judgment or damage}}, from {{m|la|prae-||before}} + {{m|la|iūdicium||judgment}}.'],
 ['Eunconditional','unconditional','{{ety|en|:af|un-<id:negative>|conditional|text=+|tree=1}}']
];
const captures=ws.json(ws.ROOT,'learning/alliance-captures.json');
const captureFor=Object.fromEntries(captures.map(c=>[c.title,c]));
for(const [id,title,excerpt] of newSources){
 if(entry.sources.some(s=>s.id===id))continue;
 const c=captureFor[title];if(!c)throw Error('NO_CAPTURE '+title);
 const snapshot=c.path.replace('build/root-universe/','');
 const bytes=ws.bytes(ws.ROOT,snapshot),rev=JSON.parse(bytes).query.pages[0].revisions[0];
 if(!rev.slots.main.content.includes(excerpt))throw Error('EXCERPT_MISSING '+id);
 entry.sources.push({id,entry:title,snapshot,snapshot_sha256:kit.sha(bytes),revision:rev.revid,url:'https://en.wiktionary.org/w/index.php?title='+encodeURIComponent(title)+'&oldid='+rev.revid,excerpt,excerpt_sha256:kit.sha(Buffer.from(excerpt)),license:'CC-BY-SA-4.0',attribution:'English Wiktionary contributors',retrieved_at:c.retrieved_at});
}
// Relation kinds follow the reviewed evidence: three close members, four cognate bridges, the rest classroom-associated.
const relation={
 predicate:'close',indicate:'close',index:'close',
 teach:'cognate',teacher:'cognate','teacher-librarian':'cognate',teaching:'cognate',token:'cognate',betoken:'cognate',
 // digit family: Latin digitus doublet, no dic- derivation — classroom contrast group.
 paradigm:'cognate',predicament:'close',digit:'classroom',digital:'classroom',digitally:'classroom',digitize:'classroom','double-digit':'classroom',
 syndicate:'cognate',syndicated:'cognate',judicial:'close',judiciary:'close',judicious:'close',prejudice:'close',prejudiced:'close',unconditionally:'close'
};
// Per-word memory clue, explanation, original example and recall item; reviewed content, not auto-derived.
const authored={
 predicate:{meaning:'论断；谓语；v. 断言；使基于',clue:'praedicāre「公开说出」→ 论断；谓语',explanation:'来自拉丁 praedicāre「公开说出」的完成被动分词 praedicātum。语法里"谓语"就是句子中对主语所作的陈述。与 predict 的 praedīcō「预言」是不同拉丁词源身份，这里按各自来源分别记。',example:{en:'The conclusion is predicated on careful field data.',zh:'这个结论是基于细致的实地数据作出的。'},recall:{prompt:'语法里对主语作出陈述的成分叫什么？',answer:'predicate',explanation:'predicate：pre- + dic「说出」→ 对主语的陈述，即谓语。'}},
 indicate:{meaning:'表明；指示；暗示',clue:'in-「朝向」+ dic「指出」→ 指出来',explanation:'in-「朝向」+ 拉丁 dicō（此处偏"指出"义）→ 把东西指出来给人看 → 表明、指示。',example:{en:'A red sky at night often indicates fine weather.',zh:'晚上天色发红常常预示着好天气。'},recall:{prompt:'红霞出现，这常常"表明"明天是好天气——"表明"用哪个词？',answer:'indicate',explanation:'indicate：把迹象指出来 → 表明。'}},
 index:{meaning:'索引；指数；v. 编索引',clue:'指出位置的东西 → 索引',explanation:'拉丁 indicō「指出」的派生名词：把内容位置"指出来"的东西 → 书的索引；引申为统计指数。',example:{en:'Look up the term in the index at the back of the book.',zh:'在书末的索引里查这个词。'},recall:{prompt:'书末帮你"指出"页码的那份表叫什么？',answer:'index',explanation:'index：指出位置 → 索引。'}},
 paradigm:{meaning:'范例；范式',clue:'para-「在旁边」+ deik「展示」→ 摆在旁边作样板的模型',explanation:'希腊 παράδειγμα：para-「在旁边」+ deiknymi「展示」→ 摆在旁边供对照的样板 → 范例、范式。经拉丁 paradīgma 传入英语。其希腊词根 deik- 与拉丁 dic- 同出印欧 *deyḱ-「展示、指出」，是远缘同源，不是同一个拉丁词根。',example:{en:'Her research helped establish a new paradigm in linguistics.',zh:'她的研究帮助确立了语言学的一个新范式。'},recall:{prompt:'科学史上，一套被公认的研究"范式"用哪个词？',answer:'paradigm',explanation:'paradigm：摆出来展示的样板 → 范式。'}},
 predicament:{meaning:'困境；窘境',clue:'与 predicate 同出 praedicāre「宣告」→ 本义"范畴"，现代转指困境',explanation:'经古法语继承自晚期拉丁 praedicāmentum「被陈述之物、范畴」，与 predicate 同出 praedicāre。现代义"困境"是语义演变的结果，不能从 dic 直接推出。',example:{en:'Losing his passport left him in an awkward predicament.',zh:'丢了护照让他陷入尴尬的困境。'},recall:{prompt:'形容"陷入困境、进退两难"的名词是哪个 dic 族词？',answer:'predicament',explanation:'predicament：历史义为"范畴"，现代转指困境。'}},
 digit:{meaning:'数字；手指/脚趾',clue:'课堂联想：与 dic- 拼形相近，实为拉丁 digitus 的同源对词',explanation:'digit 经中古英语继承自拉丁 digitus（doublet 同源对词，本义"手指"→ 掰手指数数 → 数字）。它属于 digit- 一脉，与 dic- 词根没有派生关系；老师按拼形对照放在 dic 组，词源上不同源。',example:{en:'The number 305 has three digits.',zh:'数字 305 有三个数位。'},recall:{prompt:'"数字、数位"的英文是哪个词？',answer:'digit',explanation:'digit：拉丁 digitus（手指）→ 数数 → 数字；与 dic- 无关。'}},
 digital:{meaning:'数字的；数码的',clue:'digit「数字」+ -al「…的」',explanation:'digit「数字」+ -al 形容词后缀 → 数字的、数码的。',example:{en:'She prefers digital books to paper ones.',zh:'比起纸质书，她更喜欢电子书。'},recall:{prompt:'"数码的、数字的"用哪个形容词？',answer:'digital',explanation:'digital：digit 数字 + -al。'}},
 digitally:{meaning:'数字地；数码地',clue:'digital 的副词形式',explanation:'digital + -ly → 以数字方式地。',example:{en:'The records are now stored digitally.',zh:'这些记录现在以数字方式存储。'},recall:{prompt:'"以数字方式存储"中"数字地"怎么说？',answer:'digitally',explanation:'digitally：digital 的副词。'}},
 digitize:{meaning:'使数字化；数码化',clue:'digit「数字」+ -ize「使成为」',explanation:'digit + -ize「使成为…」→ 把东西转成数字形式。',example:{en:'The library is digitizing its old manuscripts.',zh:'图书馆正在把古老的手稿数字化。'},recall:{prompt:'"把纸质资料数字化"的动词是？',answer:'digitize',explanation:'digitize：使变成数字。'}},
 'double-digit':{meaning:'两位数的',clue:'double「双」+ digit「数位」→ 两位数',explanation:'double「双的」+ digit「数位」复合 → 两位数的，常用于增长率。',example:{en:'Inflation reached double-digit levels last year.',zh:'去年通货膨胀达到了两位数水平。'},recall:{prompt:'"两位数的增长率"用哪个复合形容词？',answer:'double-digit',explanation:'double-digit：double + digit。'}},
 teach:{meaning:'教；教授',clue:'与 dic 同出印欧 *deyḱ-「展示、指出」：指给人看 → 教会',explanation:'古英语 tǣċan「展示、示教」与拉丁 dīcō 同出原始印欧 *deyḱ-「展示、指出」。这是远缘同源：现代 teach 里既没有 dic 字形，也不是拉丁借词，是同祖异途的两个词。',example:{en:'She teaches mathematics at a local school.',zh:'她在当地一所学校教数学。'},recall:{prompt:'"教、教授"最基础的动词是？',answer:'teach',explanation:'teach：印欧"展示"→ 指给人看 → 教。'}},
 teacher:{meaning:'教师；老师',clue:'teach「教」+ -er「做…的人」',explanation:'teach + -er → 教书的人。',example:{en:'Our teacher explained the rule again.',zh:'老师把规则又解释了一遍。'},recall:{prompt:'"教师"是 teach 加什么后缀？',answer:'teacher',explanation:'teacher：teach + -er。'}},
 'teacher-librarian':{meaning:'教师图书管理员',clue:'teacher「教师」+ librarian「图书管理员」复合',explanation:'teacher 与 librarian 的复合职务：兼任教学与图书管理。',example:{en:'The teacher-librarian showed the students how to cite sources.',zh:'教师图书管理员教学生如何引用资料。'},recall:{prompt:'"教师图书管理员"怎么写？',answer:'teacher-librarian',explanation:'teacher-librarian：teacher + librarian，带连字符。'}},
 teaching:{meaning:'教学；教导；教义',clue:'teach 的动名词/名词：教的行为或内容',explanation:'teaching 既指"教学"行为，也指一套"教导、学说"。',example:{en:'Her teaching focuses on spoken fluency.',zh:'她的教学侧重口语流利度。'},recall:{prompt:'"教学方法"里的"教学"名词形式是？',answer:'teaching',explanation:'teaching：teach 的名词。'}},
 token:{meaning:'代币；象征；标志',clue:'与 teach 同祖：原义"示证之物"→ 代币、象征',explanation:'古英语 tācn「标志、凭证」同样出自 *deyḱ-「展示」：把证据"摆出来" → 标志、象征；代币是"代表价值的凭证"。',example:{en:'Please accept this small gift as a token of our gratitude.',zh:'请收下这份小礼物，聊表谢意。'},recall:{prompt:'"象征性的谢意"即 a ___ of our gratitude，空缺处是？',answer:'token',explanation:'token：出示的凭证 → 象征。'}},
 betoken:{meaning:'预示；表示；标志',clue:'be- + token「标志」→ 成为…的标志',explanation:'be- + token 构成动词 → 充当…的标志、预示。书面语。',example:{en:'The first buds betoken the coming of spring.',zh:'初生的嫩芽预示着春天将至。'},recall:{prompt:'"预示、是…的征兆"的书面动词（token 加前缀）是？',answer:'betoken',explanation:'betoken：be- + token。'}},
 syndicate:{meaning:'财团；联合企业；v. 联合供稿',clue:'希腊 syn「共同」+ dikē「判断」→ 帮办诉讼的人 → 代表团体办事 → 辛迪加',explanation:'经中世纪拉丁 syndicātus、syndicus 继承自希腊 σύνδικος「为被告辩护的人」：σύν「共同」+ δίκη「判断、公道」。δίκη 与展示义印欧词根 *deyḱ- 相关，与拉丁 dic- 是远缘同源而非同一拉丁词根。',example:{en:'A media syndicate distributes the comic to hundreds of papers.',zh:'一家媒体辛迪加向数百家报纸分发这部漫画。'},recall:{prompt:'"报业辛迪加、财团"的英文是？',answer:'syndicate',explanation:'syndicate：希腊「共同判断」→ 代理人团体。'}},
 syndicated:{meaning:'联合供稿的；辛迪加式的',clue:'syndicate 的过去分词/形容词',explanation:'syndicate 作动词"多渠道分发"的形容词形式：syndicated content 联合供稿内容。',example:{en:'Her column appears in syndicated newspapers nationwide.',zh:'她的专栏在全国联合发行的报纸上刊出。'},recall:{prompt:'"联合供稿的（形容词）"怎么写？',answer:'syndicated',explanation:'syndicated：syndicate 的形容词。'}},
 judicial:{meaning:'司法的；法庭的',clue:'judex「法官」+ -ial：法官的 → 司法的',explanation:'拉丁 iūdex（iūs「法律」+ dicere「说」= 依法说话的人 → 法官）的形容词：judicial 司法的。dic 在此处走"依法而说"一脉。',example:{en:'The case is still under judicial review.',zh:'此案仍在司法审查中。'},recall:{prompt:'"司法审查"即 ___ review，这个形容词是？',answer:'judicial',explanation:'judicial：法官的 → 司法的。'}},
 judiciary:{meaning:'司法部门；审判机关',clue:'judicial 的名词化：司法系统整体',explanation:'judiciary 指一个国家的法院系统/司法部门，与行政、立法并列。',example:{en:'An independent judiciary protects individual rights.',zh:'独立的司法机构保护个人权利。'},recall:{prompt:'立法、行政之外掌管审判的一支叫 the ___？',answer:'judiciary',explanation:'judiciary：司法部门。'}},
 judicious:{meaning:'明智的；有判断力的',clue:'judic「判断」+ -ious：善于判断的',explanation:'judicious 与 judicial 同根不同义：judicial 管法庭，judicious 管头脑——善于判断的、明智的。',example:{en:'She made a judicious choice of words.',zh:'她用词很有判断力。'},recall:{prompt:'形容"明智的、有判断力的"用哪个词（词尾 -ious）？',answer:'judicious',explanation:'judicious：明智的；judicial：司法的，别混。'}},
 prejudice:{meaning:'偏见；v. 使有偏见',clue:'prae-「预先」+ judic「判断」→ 还没了解就先下了判断',explanation:'pre-「预先」+ judic「判断」：事情还没弄清就预先"判"了 → 偏见。',example:{en:'The report is free from political prejudice.',zh:'这份报告不带政治偏见。'},recall:{prompt:'"预先判断"造成的"偏见"是哪个词？',answer:'prejudice',explanation:'prejudice：pre- 预先 + judice 判断。'}},
 prejudiced:{meaning:'有偏见的',clue:'prejudice 的形容词形式',explanation:'prejudiced：带有偏见的，常与 against/toward 搭配。',example:{en:'He admitted he was prejudiced against the idea.',zh:'他承认自己对这个想法抱有偏见。'},recall:{prompt:'"对…有偏见的"形容词是？',answer:'prejudiced',explanation:'prejudiced：prejudice 的形容词。'}},
 unconditionally:{meaning:'无条件地',clue:'un-「不」+ conditional「有条件的」+ -ly：不带条件地',explanation:'un-「不」+ condition 词族的条件义 + -ly 副词后缀：不带任何条件地。本课第22课复现 condition 词族，一起记。',example:{en:'The support was offered unconditionally.',zh:'这份支持是无条件提供的。'},recall:{prompt:'"无条件地（副词）"是 condition 词族的哪个词？',answer:'unconditionally',explanation:'unconditionally：un + conditional + ly。'}}
};
// Teach/token family members reuse the cognate source of their leader; morphology clues are author-organized.
const familySource={predicate:['Epredicate'],indicate:['Eindicate'],index:['Eindex'],paradigm:['Eparadigm'],predicament:['Epredicament'],digit:['Edigit'],digital:['Edigit'],digitally:['Edigit'],digitize:['Edigit'],'double-digit':['Edigit'],teach:['Eteach'],teacher:['Eteach'],'teacher-librarian':['Eteach'],teaching:['Eteach'],token:['Etoken'],betoken:['Etoken'],syndicate:['Esyndicate'],syndicated:['Esyndicate'],judicial:['Ejudicial','Eprejudice'],judiciary:['Ejudicial','Eprejudice'],judicious:['Ejudicial','Eprejudice'],prejudice:['Eprejudice'],prejudiced:['Eprejudice'],unconditionally:['Eunconditional']};
const S=id=>[id];
const scopes=new Map();
for(const o of scope.occurrences){const k=o.lookup_key||String(o.word||'').toLowerCase();if(!scopes.has(k))scopes.set(k,o);}
const branchOf={
 predicate:'B9',indicate:'B8',index:'B8',
 paradigm:'B8',predicament:'B9',
 digit:'B11',digital:'B11',digitally:'B11',digitize:'B11','double-digit':'B11',
 teach:'B10',teacher:'B10','teacher-librarian':'B10',teaching:'B10',
 token:'B10',betoken:'B10',
 syndicate:'B11',syndicated:'B11',judicial:'B10',judiciary:'B10',judicious:'B10',prejudice:'B10',prejudiced:'B10',
 unconditionally:'B7'
};
// Branch themes extend to cover the new members: B8 指出/展示, B10 判断与教导, B11 对照词.
const branchTitle={B8:'指出与展示 → 表明、索引与范式',B9:'郑重宣告 → 奉献、让位与困境',B10:'判断、说法与教导 → 司法、明智与教学',B11:'以力宣告与课堂对照 → 辩护、报复、辛迪加与 digit 族'};
const branchIdea={
 B8:'in-/para- + dic/deik「指出、展示」→ 指出来给人看：表明、索引、范式',
 B9:'dē-/ab- + dicō「郑重宣告」→ 献给、宣布放弃；praedicāre 的名词范畴义转出 predicament',
 B10:'iūs「法律」+ dicere「说」→ 依法而说：裁判、司法；judicious 转指头脑的判断；teach/token 同出印欧「展示」，归于教导与凭证',
 B11:'vīs「力量」+ dīcō → 以力申张；syndicate（希腊）、digit 族（拉丁 digitus）为拼形对照词，词源上与 dic- 无关'
};
const branchSource={B8:['Eindicate','Eindex','Eparadigm'],B9:['Ededicate','Eabdicate','Epredicate','Epredicament'],B10:['Eiudico','Eadjudicate','Eteach','Etoken'],B11:['Evindicate','Edigit']};
const branchDefs=[
 {id:'B8',title:branchTitle.B8,idea:branchIdea.B8,source_ids:branchSource.B8},
 {id:'B10',title:branchTitle.B10,idea:branchIdea.B10,source_ids:branchSource.B10},
 {id:'B11',title:branchTitle.B11,idea:branchIdea.B11,source_ids:branchSource.B11}
];
const allWords=[];
for(const w of entry.alliance.words){
 const name=w.word,clueFix=authored[name]?.clue;
 allWords.push({...w,clue:clueFix||w.clue});
}
for(const [name,a] of Object.entries(authored)){
 if(entry.alliance.words.some(w=>w.word===name))continue;
 const sc=scopes.get(name.toLowerCase())||{},c=courseIndex.get(name.toLowerCase());
 if(!c)throw Error('COURSE_MISSING '+name);
 allWords.push({id:'A'+name,word:name,lesson:c.lesson,branch:branchOf[name]||'B8',clue:a.clue,source_ids:familySource[name]||S('E'+name.charAt(0).toUpperCase()+name.slice(1))});
}
const words=[];
const roles={predicate:[{label:'pre-',role:'prefix',meaning:'预先；公开',source_ids:['Epre','Epredicate']},{label:'dic',role:'root',root_id:'Rdict',meaning:'郑重宣告；说出',source_ids:['Epredicate','Eiudico']}],
 indicate:[{label:'in-',role:'prefix',meaning:'朝向',source_ids:['Epre','Eindicate']},{label:'dic',role:'root',root_id:'Rdict',meaning:'指出',source_ids:['Eindicate','Eiudico']}],
 index:[{label:'dic',role:'root',root_id:'Rdict',meaning:'指出（indicō 的派生名词）',source_ids:['Eindex','Eiudico']}],
 paradigm:[{label:'para-',role:'prefix',meaning:'在旁边',source_ids:['Eparadigm']},{label:'deik',role:'root',root_id:'Rdict',meaning:'展示；指出（印欧词根，与 dic- 远缘同源）',source_ids:['Eparadigm','Eteach']}],
 teach:[{label:'teach',role:'base',meaning:'教（印欧「展示」一脉）',source_ids:['Eteach']}],
 token:[{label:'token',role:'base',meaning:'标志；凭证（印欧「展示」一脉）',source_ids:['Etoken']}],
 digit:[{label:'digit',role:'base',meaning:'本义手指；数位',source_ids:['Edigit']}],
 predicament:[{label:'pre-',role:'prefix',meaning:'预先（历史借入）',source_ids:['Epredicament']},{label:'dicament',role:'root',root_id:'Rdict',meaning:'被陈述之物（中世纪拉丁范畴义）',source_ids:['Epredicament']}]};
for(const aw of allWords){
 const name=aw.word,c=courseIndex.get(name.toLowerCase());if(!c)throw Error('COURSE_MISSING '+name);
 const p=profiles[name],au=authored[name];
 const isFull=p||au;
 const meaning=au?.meaning||p?.meaning||c.def;
 const trace=isFull?[{label:name,kind:'word',meaning:meaning,sense_id:p?.sense_id,source_ids:aw.source_ids},...(p?[{label:'praedīcō',kind:'historical',meaning:'拉丁语：预言',source_ids:['Epraedico']}]:[]),{label:'dict- / dic-',kind:'root',meaning:'学习词根：说；讲',root_id:'Rdict',source_ids:aw.source_ids}]:[{label:name,kind:'word',meaning:meaning,source_ids:aw.source_ids}];
 words.push({
  id:aw.id,word:name,sense_id:senseByWord[name]||null,query_id:`Ldict:${name.toLowerCase()}`,meaning,root_ids:['Rdict'],
  relation_kind:relation[name]||'classroom',lesson:c.lesson,parts:roles[name]||p?.parts||null,
  modern_formula:au?.clue||p?.modern_formula||`${name}（课堂记忆条目）`,
  explanation:au?.explanation||p?.explanation||c.def,
  trace,source_ids:aw.source_ids,
  example:au?.example?{...au.example,kind:'original'}:p?.example||null,
  caveat:au?null:'本条为课堂记忆条目：构词线索为作者整理，仅引用族首来源的已核片段；完整逐词来源待后续独立复核。',
  recall:au?.recall||{prompt:`${c.def.split('；')[0].split(',')[0]}——这个词是？`,answer:name,explanation:c.def},
  ...(p?{}:{})
 });
 if(!words.at(-1).parts)words.at(-1).parts=[{label:name,role:'base',meaning:meaning.slice(0,20),source_ids:aw.source_ids}];
}
// Classroom occurrences outside the dic group (justice family etc.) stay on the ledger; scope covers the 58 in-group lines.
entry.schema_version='1.1.0';
entry.roots[0].forms_note=entry.roots[0].forms_note+'（judicial 等司法词走 dicere「依法而说」一脉；paradigm/teach/token 与 dic- 同出印欧 *deyḱ-，属远缘同源，不是同一拉丁词根。）';
const branches=allWords.reduce((m,w)=>{(m[w.branch]=m[w.branch]||[]).push(w.id);return m;},{});
const keptBranchIds=new Set(Object.keys(branches));
const allianceBranches=entry.alliance.branches.filter(b=>keptBranchIds.has(b.id)).map(b=>({...b,title:branchTitle[b.id]||b.title,idea:branchIdea[b.id]||b.idea,source_ids:branchSource[b.id]||b.source_ids,word_ids:branches[b.id]}));
entry.words=words;
entry.changes='中文释义、记忆拆解、溯源摘要与例句为作者整理；关系类型（近支/远缘同源/课堂关联）按来源证据分层标注。课堂58次出现全部收账；课堂联想词不以拼形冒充同根。';
// syndicate/syndicated moved into B11 as reviewed cognate members; remaining exclusions stay unresolved pending per-word sources.
const excludedOut=entry.alliance.excluded
 .filter(x=>!allWords.some(w=>w.word.toLowerCase()===x.word.toLowerCase()))
 .map(x=>({...x,status:'unresolved'}));
entry.alliance={
 ...entry.alliance,
 branches:allianceBranches,
 words:allWords,
 excluded:excludedOut,
 coverage_note:`本联盟收录万词课 dic 组课堂 58 次出现对应 ${allWords.length} 个词，分 ${allianceBranches.length} 个记忆分支；另有 ${excludedOut.length} 个拼形相近词已排除（排除依据待逐词独立核查，先标 unresolved）。近支、远缘同源与课堂关联分别标明。`,
 scope:{file:scopePath,sha256:kit.sha(scopeRaw),occurrences:scope.occurrences.length}
};
const out=Buffer.from(JSON.stringify(entry,null,2)+'\n');
const target='learning/dict/candidates/complete/entry.json';
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(out);
if(changed)ws.atomic(ws.ROOT,target,out);
console.log(JSON.stringify({ok:true,target,changed,hash:kit.sha(out),words:words.length,alliance_words:allWords.length,branches:allianceBranches.length,sources:entry.sources.length,occurrences:scope.occurrences.length}));
