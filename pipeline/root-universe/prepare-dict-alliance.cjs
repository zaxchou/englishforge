'use strict';
// Adds the course-bound dict alliance to the signed base entry; regenerating bytes requires independent re-review.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const EXPECTED_BASE='4301e93a6cf086c66414aef3650eb2fa762775eee31f24d11f35bd5d1e0f0ade';
const raw=ws.bytes(ws.ROOT,'learning/dict/candidates/template/entry.json');
if(kit.sha(raw)!==EXPECTED_BASE)throw Error('BASE_ENTRY_CHANGED: '+kit.sha(raw));
const entry=JSON.parse(raw);
const captures=ws.json(ws.ROOT,'learning/alliance-captures.json');
const dicoCapture=captures.find(c=>c.title==='dico')
  ||ws.json(ws.ROOT,'packets/P0013/captures.json').find(c=>c.title==='dico');
if(!dicoCapture)throw Error('DICO_CAPTURE_MISSING');
function readCapture(c){return ws.bytes(ws.ROOT,c.path.replace('build/root-universe/',''));}
function firstEtymology(c){
  const text=JSON.parse(readCapture(c)).query.pages[0].revisions[0].slots.main.content;
  const a=text.indexOf('==English==');if(a<0)throw Error('NO_ENGLISH '+c.title);
  const e=text.indexOf('===Etymology',a);if(e<0)throw Error('NO_ETYMOLOGY '+c.title);
  const para=text.slice(e).split('\n\n').find(p=>p.startsWith('===Etymology')&&p.trim().split('\n').length>1);
  return para.trim().split('\n').slice(1).join(' ').trim();
}
const author='sess_ab049c26-65ea-48d2-a1b1-ef228119425e / main / learning-template-author';
const newSources=[
 ['Econtradict','contradict','Derived from {{bor|en|la|contrādictus|t=contradicted}}, the past participle of {{m|la|contrādīcō|t=speak against}}'],
 ['Edictate','dictate','{{bor+|en|la|dictātum|t=a thing said, something dictated|nocap=1}}'],
 ['Edictator','dictator','from {{m|la|dictō|t=dictate, prescribe}}, from {{m|la|dīcō|t=say, speak}}'],
 ['Ediction','diction','from {{suf|la|nocat=1|dīcō|t1=to say, to talk|tiō}}'],
 ['Edictionary','dictionary','{{ety|en|id=work|:inh|enm:dixionare<id:dictionary>|:afeq|diction|-ary|tree=1}}'],
 ['Edictum','dictum','From {{bor|en|la|dictum||proverb, maxim}}, from {{m|la|dictus||having been said}}, perfect passive participle of {{m|la|dico||to say}}'],
 ['Everdict','verdict','from {{m|fro|veir|t=true}} + {{m|fro|dit|t=saying}}'],
 ['Econdition','condition','from {{der|en|la|condicio}}'],
 ['Eaddict','addict','past participle of {{m|la|addīcō||deliver; devote; surrender}}, from {{m|la|ad-||to, towards, at}} + {{m|la|dīcō||say; declare}}'],
 ['Eedict','edict','borrowed from {{der|en|la|edictum}}'],
 ['Ebenediction','benediction','from {{der|en|la-ecc|benedictio|benedictio, benedictionis}}, from {{m|la|benedictus||blessed; well spoken of}}'],
 ['Emalediction','malediction','from {{der|en|la|maledictiō|t=curse}} from {{m|la|malus|t=evil}} + {{m|la|dictiō|t=speech}}'],
 ['Evalediction','valediction','from {{m|la|valedīcō||to bid farewell}} + {{m|la|-tiō}}, from {{m|la|valē||farewell, so long}} + {{m|la|dīcō||to say}}'],
 ['Einterdict','interdict','from {{der|en|la|interdīcō||prohibit, forbid}}, from {{m|la|inter-||between}} + {{m|la|dīcō||say}}'],
 ['Eindicate','indicate','{{bor+|en|la|indicātus}}, {{glossary|perfect}} {{glossary|passive}} {{glossary|participle}} of {{m|la|indicō||to point out, indicate}}'],
 ['Eindex','index','From {{der|en|la|index|t=a discoverer, informer, spy; of things, an indicator, the forefinger, a title, superscription}}, from {{m|la|indicō|t=point out, show}}'],
 ['Ededicate','dedicate','from {{der|en|la|dēdicātus}}, the {{glossary|perfect}} {{glossary|passive}} {{glossary|participle}} of {{m|la|dēdicō||to dedicate, proclaim}}'],
 ['Eabdicate','abdicate','formed from {{m|la|ab||away}} + {{m|la|dicō||proclaim, dedicate, declare}}, akin to {{m|la|dīcō||to say}}'],
 ['Epredicate','predicate','from {{der|en|la-med|praedicātum|t=thing said of a subject, predicate}}'],
 ['Ejurisdiction','jurisdiction','{{ety|en|:bor|la:iūrisdictiō|text=+|tree=1}}'],
 ['Eadjudicate','adjudicate','{{bor+|en|la|adiudico|adiūdicō, adiūdicātus}}, from {{m|la|ad}} + {{m|la|iūdicō||to judge}}'],
 ['Evindicate','vindicate','from {{m|la|vim}}, accusative singular of {{m|la|vīs||force, power}}, + {{m|la|dīcō||say; declare, state}}'],
 ['Eindict','indict','from {{der|en|la-lat|indictō|indictāre}}, frequentative of {{cog|la|indicere||to proclaim}}, from {{m|la|in-}} + {{m|la|dicō|dicere|to say}}'],
 ['Eiudico','dico','According to de Vaan, possibly a {{back-formation|la|nocap=1|-}} from compounds in {{m|la||-dicō}}, {{m|la||-āre}}, such as {{m|la|iūdicō||to judge}}']
];
const captureFor=Object.fromEntries(captures.map(c=>[c.title,c]));
const dicoPacketCapture=ws.json(ws.ROOT,'packets/P0013/captures.json').find(c=>c.title==='dico');
if(dicoPacketCapture)captureFor['dico']={...dicoPacketCapture,path:dicoPacketCapture.snapshot,retrieved_at:dicoPacketCapture.retrieved_at};
for(const [id,title,excerpt] of newSources){
  if(entry.sources.some(s=>s.id===id))continue;
  const c=captureFor[title];if(!c)throw Error('NO_CAPTURE '+title);
  const bytes=readCapture(c),rev=JSON.parse(bytes).query.pages[0].revisions[0];
  if(!rev.slots.main.content.includes(excerpt))throw Error('EXCERPT_MISSING '+id);
  entry.sources.push({id,entry:title,snapshot:c.path.replace('build/root-universe/',''),snapshot_sha256:kit.sha(bytes),revision:rev.revid,url:'https://en.wiktionary.org/w/index.php?title='+encodeURIComponent(title)+'&oldid='+rev.revid,excerpt,excerpt_sha256:kit.sha(Buffer.from(excerpt)),license:'CC-BY-SA-4.0',attribution:'English Wiktionary contributors',retrieved_at:c.retrieved_at});
}
const courseRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,'build/vocab/cfcm-words.json'));
const course=JSON.parse(courseRaw);
const courseIndex=new Map();
for(const b of course.batches||[])for(const w of b.words||[])courseIndex.set(String(w.w).toLowerCase(),{lesson:w.lesson,def:w.def||'',sen:w.sen||'',senZh:w.senZh||'',batch:b.id});
const S=id=>({source_ids:[id]});
const branchDefs=[
 {id:'B1',title:'预先说 → 预测',idea:'pre-「预先」+ dict「说」→ 预先说出将要发生的事',source_ids:['Epredict','Epraedico','Epredictable','Eunpredictable'],words:[
  ['predict','预先说出 → 预测',['Epredict','Epraedico']],
  ['prediction','predict 加 -ion「行为」→ 预测；预言',['Epredict']],
  ['predictable','predict + -able「能够被…的」→ 可预测的',['Epredictable']],
  ['predictably','predictable 的副词形式 → 可预见地',['Epredictable']],
  ['predicted','predict 的过去式/过去分词 → 被预测的',['Epredict']],
  ['predictive','predict + -ive「有…性质」→ 预测性的',['Epredict']],
  ['predictor','predict + -or「…的东西/人」→ 预测指标；预测器',['Epredict']],
  ['predictability','predictable + -ity「性质」→ 可预测性',['Epredictable']],
  ['unpredictable','un-「不」+ predictable → 不可预测的',['Eunpredictable']],
  ['unpredictability','unpredictable 的名词 → 不可预测性',['Eunpredictable']]]},
 {id:'B2',title:'相反地说 → 反驳',idea:'contra-「相反」+ dict「说」→ 说出相反的话 → 反驳',source_ids:['Econtradict'],words:[
  ['contradict','contradict「相对而说」→ 反驳；与…矛盾',['Econtradict']],
  ['contradiction','contradict + -ion → 矛盾；反驳',['Econtradict']],
  ['contradictory','contradict + -ory「…的」→ 相互矛盾的',['Econtradict']]]},
 {id:'B3',title:'一再地说 → 口述与命令',idea:'dictāre「一再地说」→ 口授让人记下 → 命令、支配',source_ids:['Edictate','Edictator'],words:[
  ['dictate','一再地说 → 口述；命令',['Edictate']],
  ['dictation','dictate + -ion → 听写；口述',['Edictate']],
  ['dictator','说一不二的人 → 独裁者',['Edictator']],
  ['dictatorial','dictator + -ial → 独裁的；专横的',['Edictator']],
  ['dictatorship','dictator + -ship「身份」→ 独裁统治',['Edictator']]]},
 {id:'B4',title:'说出的话 → 言辞与裁决',idea:'dictus「被说出的话」→ 用语、格言；verdict = 真实 + 所说 → 裁决',source_ids:['Ediction','Edictionary','Edictum','Everdict'],words:[
  ['diction','dīcō + -tion → 说话的方式 → 措辞；发音',['Ediction']],
  ['dictionary','收集 diction「词语」的书 → 词典',['Edictionary']],
  ['dictum','被说出的话 → 名言；声明',['Edictum']],
  ['verdict','ver「真实」+ dict「所说」→ 陪审团如实说出的结论 → 裁决',['Everdict']]]},
 {id:'B5',title:'祝福、诅咒与告别',idea:'bene「好」/male「坏」/vale「告别」+ dict「说」→ 说好话、说坏话、道别的话',source_ids:['Ebenediction','Emalediction','Evalediction'],words:[
  ['benediction','bene「好」+ diction「话」→ 祝福',['Ebenediction']],
  ['malediction','male「坏」+ diction「话」→ 诅咒',['Emalediction']],
  ['valediction','vale「告别」+ diction「话」→ 告别辞',['Evalediction']]]},
 {id:'B6',title:'公告与禁止',idea:'ē-「向外」+ dict「说」→ 向外宣告 = 法令；inter-「其间」+ dict → 禁令',source_ids:['Eedict','Einterdict','Eindict'],words:[
  ['edict','向外说出 → 法令；敕令',['Eedict']],
  ['interdict','在中间说话拦住 → 禁止；禁令',['Einterdict']],
  ['indict','in- + dict「宣告」→ 宣告有罪 → 控告；起诉',['Eindict']],
  ['indictment','indict + -ment → 起诉书；控告',['Eindict']]]},
 {id:'B7',title:'说定 → 归属与条件',idea:'ad-/con- + dīcō「说定」→ 判给、约定 → 痴迷、条件',source_ids:['Eaddict','Econdition'],words:[
  ['addict','ad-「朝向」+ dict「说定」→ 被判交出去的人 → 引申为上瘾者',['Eaddict']],
  ['addicted','addict 的过去分词 → 上瘾的',['Eaddict']],
  ['addiction','addict + -ion → 沉溺；瘾',['Eaddict']],
  ['addictive','addict + -ive → 使人上瘾的',['Eaddict']],
  ['condition','con-「共同」+ dition「说定」→ 共同说定的前提 → 条件',['Econdition']],
  ['conditional','condition + -al → 有条件的',['Econdition']],
  ['conditioner','调节状态的东西 → 护发素；空调',['Econdition']],
  ['conditioning','使状态稳定 → 调节；训练',['Econdition']],
  ['precondition','pre-「预先」+ condition → 先决条件',['Econdition']],
  ['unconditional','un-「不」+ conditional → 无条件的',['Econdition']],
  ['air-conditioned','air + conditioned 复合 → 装有空调的',['Econdition']],
  ['air-conditioning','air + conditioning 复合 → 空调系统',['Econdition']]]},
 {id:'B8',title:'指出 → 表明与索引',idea:'in-「朝向」+ dicō「指出」→ 指出来 → 表明、索引',source_ids:['Eindicate','Eindex'],words:[
  ['indicate','指出来 → 表明；指示',['Eindicate']],
  ['indication','indicate + -ion → 表示；迹象',['Eindicate']],
  ['indicative','indicate + -ive → 指示的；陈述的',['Eindicate']],
  ['indicator','indicate + -or → 指示器；指标',['Eindicate']],
  ['index','指出位置的东西 → 索引；指数',['Eindex']]]},
 {id:'B9',title:'郑重宣告 → 奉献与让位',idea:'dē-/ab- + dicō「郑重宣告」→ 献给、公开宣布放弃',source_ids:['Ededicate','Eabdicate','Epredicate'],words:[
  ['dedicate','de- + dicate「郑重宣告」→ 奉献给',['Ededicate']],
  ['dedicated','dedicate 的过去分词 → 专心致志的',['Ededicate']],
  ['dedication','dedicate + -ion → 奉献；献身',['Ededicate']],
  ['abdicate','ab-「离开」+ dicate「宣告」→ 宣布放弃 → 退位',['Eabdicate']],
  ['predicate','praedicāre「公开说出」→ 论断；谓语',['Epredicate']]]},
 {id:'B10',title:'依法而说 → 裁判与辖区',idea:'iūs「法律」+ dicere「说」→ 说法 → 裁判、司法管辖',source_ids:['Eadjudicate','Ejurisdiction','Eiudico'],words:[
  ['adjudicate','ad- + iūdicāre「依法裁断」→ 判决；裁定',['Eadjudicate','Eiudico']],
  ['juridical','iūs + dic 的形容词 → 司法的；法律的',['Eiudico']],
  ['jurisdiction','iūris「法律的」+ dictiō「所说」→ 司法管辖权',['Ejurisdiction','Eiudico']]]},
 {id:'B11',title:'以力宣告 → 维护与报复',idea:'vīs「力量」+ dīcō「宣告」→ 以力申张 → 辩护、复仇',source_ids:['Evindicate'],words:[
  ['vindicate','以力量宣告 → 为…辩护；证明无辜',['Evindicate']],
  ['vindication','vindicate + -ion → 辩护；昭雪',['Evindicate']],
  ['vindictive','力求报复的 → 报复心强的',['Evindicate']]]}
];
const seen=new Set(),words=[];
for(const b of branchDefs)for(const [word,clue,sourceIds] of b.words){
  if(seen.has(word))throw Error('DUP '+word);seen.add(word);
  const c=courseIndex.get(word);if(!c)throw Error('NOT_IN_COURSE '+word);
  const template=entry.words.find(w=>w.word===word);
  words.push({id:template?template.id:'A'+word,word,lesson:c.lesson,branch:b.id,clue,sense_id:template?template.sense_id:undefined,source_ids:sourceIds});
}
const excludedDefs=[
 [['abandon','abandoned','abandonment'],'来自古法语 bandon「管辖权」，与 dict 词根无关'],
 [['biomedical'],'bio「生物」+ medical 的复合词；medical 来自拉丁 medicus「医生的」'],
 [['eradicate','eradication','ineradicable'],'拉丁 ē-「向外」+ rādīx「根」→ 连根拔起；这里的 -ic- 不是 dic'],
 [['handicap','handicapped'],'hand + cap，源于旧游戏「手在帽中」抽签，与 dic 无关'],
 [['medicaid','medical','medically','medication'],'拉丁 medicus「医生」的词族'],
 [['mendicant'],'拉丁 mendīcus「乞丐」，来自 mendum「缺陷」'],
 [['methodical','methodically'],'希腊 methodos「方法」+ -ical'],
 [['periodical','periodically'],'希腊 periodos「周期」+ -ical'],
 [['radical','radicalism','radically'],'拉丁 rādīx「根」→ 激进（追到根）'],
 [['sporadically'],'希腊 sporas「散布的」+ -ical'],
 [['syndicate','syndicated'],'希腊 syndikos「帮办诉讼的人」，不是拉丁 dict']
];
const excluded=[];
for(const [list,reason] of excludedDefs)for(const word of list){
  const c=courseIndex.get(word);if(!c)throw Error('EXCLUDED_NOT_IN_COURSE '+word);
  excluded.push({word,lesson:c.lesson,reason});
}
entry.alliance={title:'dict 词根联盟',course_file:'build/vocab/cfcm-words.json',course_sha256:kit.sha(courseRaw),
  coverage_note:`本联盟收录万词课词 ${words.length} 个，分 ${branchDefs.length} 个记忆分支；另有 ${excluded.length} 个拼形相近但词源无关的词已排除并注明原因。`,
  branches:branchDefs.map(b=>({id:b.id,title:b.title,idea:b.idea,source_ids:b.source_ids,word_ids:words.filter(w=>w.branch===b.id).map(w=>w.id)})),
  words,excluded};
const out=Buffer.from(JSON.stringify(entry,null,2)+'\n');
const target='learning/dict/candidates/alliance/entry.json';
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(out);
if(changed)ws.atomic(ws.ROOT,target,out);
console.log(JSON.stringify({ok:true,target,changed,hash:kit.sha(out),alliance_words:words.length,excluded:excluded.length,branches:branchDefs.length,sources:entry.sources.length}));
