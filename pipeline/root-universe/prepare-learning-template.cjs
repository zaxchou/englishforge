'use strict';
// Authoring utility for the reviewed learning layer; never modifies signed packets or their index.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const captures=id=>ws.json(ws.ROOT,`packets/${id}/captures.json`);
const extra=ws.json(ws.ROOT,'learning/source-captures.json');
const sources=[];
function source(id,packet,title,excerpt){
  const c=packet?captures(packet).find(c=>c.title===title):extra.find(c=>c.title===title);
  if(!c)throw Error('MISSING_CAPTURE '+title);
  const snapshot=packet?c.snapshot:c.path.replace('build/root-universe/','');
  const raw=ws.bytes(ws.ROOT,snapshot),j=JSON.parse(raw),r=j.query.pages[0].revisions[0];
  if(!r.slots.main.content.includes(excerpt))throw Error('EXCERPT_MISSING '+id);
  sources.push({id,entry:title,snapshot,snapshot_sha256:kit.sha(raw),revision:r.revid,url:'https://en.wiktionary.org/w/index.php?title='+encodeURIComponent(title)+'&oldid='+r.revid,excerpt,excerpt_sha256:kit.sha(Buffer.from(excerpt)),license:'CC-BY-SA-4.0',attribution:'English Wiktionary contributors',retrieved_at:c.retrieved_at});
}
source('Epredict','P0001','predict','Early 17th century, from {{bor|en|la|praedicō||to mention beforehand}} (perfect passive participle {{m|la|praedictus}}), from {{m|la|prae-||before}} + {{m|la|dīcō||to say}}. Equivalent to Germanic {{m|en|forespeak}}, {{m|en|foretell}}, and {{m|en|foresay}}.');
source('Epraedico','P0001','praedico','{{ety|la|id=predict|title=praedīcō|:af|prae-<t:before, in front>|dīcō<t:say, tell><id:say>|text=+|tree=1}}');
source('Edico','P0013','dico','# {{senseid|la|say}} to [[say]], [[talk]], [[speak]], [[utter]], [[mention]]');
source('Eearlier','P0013','dico','From {{inh|la|itc-pro|*deikō}}, from {{inh|la|ine-pro|*déyḱeti||to show, point out}} (reformed as a thematic verb).');
source('Edictus',null,'dictus','Perfect passive participle of {{m|la|dīcō||to say}}.');
source('Epredictable','P0001','predictable','{{ety|en|:af|predict|-able|text=+|tree=1}}');
source('Eunpredictable','P0001','unpredictable','{{ety|en|:af|un-<id:negative>|predictable|text=+|tree=1}}');
source('Epre',null,'pre-','# {{senseid|en|beforehand}} Before; earlier in time; [[beforehand]].');
source('Eun',null,'un-','# {{lb|en|added to adjectives or past participles}} [[not]]');
source('Eable',null,'-able','# {{U|able}} to be [[done]]; fit to be done.');
const author='sess_ab049c26-65ea-48d2-a1b1-ef228119425e / main / learning-template-author';
const root={id:'Rdict',label:'dict- / dic-',meaning:'说；讲',origin:'拉丁语 dīcō「说、讲」',forms_note:'dic- 与 dict- 是同一拉丁词源的相关词干形式；dict- 可见于 dīcō 的完成被动分词 dictus。背词时记 dict「说」，并认识 dic- 这个相关形式。',source_ids:['Edico','Edictus','Epraedico'],earlier:[{label:'*deikō',language:'原始意大利语',meaning:'更早的重建形式',reconstructed:true},{label:'*déyḱeti',language:'原始印欧语',meaning:'展示；指出',reconstructed:true}],earlier_source_ids:['Eearlier'],earlier_note:'星号表示语言学重建形式，不是留存下来的文字。这里是当前来源支持的更早层次，不宣称已经找到了语言的绝对起点。'};
const p={label:'pre-',role:'prefix',meaning:'在前；预先',source_ids:['Epre','Epredict']};
const r={label:'dict',role:'root',root_id:'Rdict',meaning:'说；讲',source_ids:['Edico','Edictus','Epredict']};
const u={label:'un-',role:'prefix',meaning:'不；否定',source_ids:['Eun','Eunpredictable']};
const a={label:'-able',role:'suffix',meaning:'能够被……的',source_ids:['Eable','Epredictable']};
const trace=[{label:'predict',kind:'word',meaning:'预先说出 → 预测',sense_id:'P0001:s0001',source_ids:['Epredict']},{label:'praedīcō',kind:'historical',meaning:'拉丁语：预言；由 prae- + dīcō 构成',source_ids:['Epraedico']},{label:'dīcō / dictus',kind:'historical',meaning:'说；与 dict- / dic- 对应的拉丁形式',source_ids:['Edico','Edictus']},{label:'dict- / dic-',kind:'root',meaning:'学习词根：说；讲',root_id:'Rdict',source_ids:['Edico','Edictus']}];
const caveat='英语 predict 条目的拉丁形式写作 praedicō；拉丁条目把“预言”的 praedīcō 与“宣告”的 praedicō 分开。本页保留这一来源差异，按“预言”义解释；学习溯源摘要不替代原始关系图中尚未批准的借入边。';
const words=[
 {id:'Lpredict',sense_id:'P0001:s0001',word:'predict',meaning:'预测；预言',root_ids:['Rdict'],parts:[p,r],modern_formula:'predict 是这里的现代英语基词。',explanation:'记忆拆解：pre-「预先」+ dict「说」→ 预先说出将要发生的事 → 预测。这里的 dict 是词源性词干，不能单独当作一个现代英语动词使用。',trace,source_ids:['Epredict','Epraedico','Edico','Edictus'],example:{en:'We cannot predict every change.',zh:'我们无法预测每一次变化。',kind:'original'},caveat},
 {id:'Lpredictable',sense_id:'P0001:s0002',word:'predictable',meaning:'可预测的；可预料的',root_ids:['Rdict'],parts:[p,r,a],modern_formula:'predict + -able → predictable',explanation:'先形成 predict「预测」，再加 -able「能够被……的」→ 能够被预测的。predict 是基词，进一步追溯的词根仍是 dict- / dic-「说」。',trace:[{label:'predictable',kind:'word',meaning:'能够被预测的',sense_id:'P0001:s0002',source_ids:['Epredictable']},...trace],source_ids:['Epredictable','Eable','Epredict','Epraedico','Edico','Edictus'],example:{en:'The ending was predictable.',zh:'这个结局在意料之中。',kind:'original'},caveat},
 {id:'Lunpredictable',sense_id:'P0001:s0003',word:'unpredictable',meaning:'不可预测的；难以预料的',root_ids:['Rdict'],parts:[u,p,r,a],modern_formula:'un- + (predict + -able) → unpredictable',explanation:'分两层看：predict + -able → predictable「可预测的」；再加否定前缀 un- → unpredictable「不可预测的」。继续把 predict 追到 dict- / dic-「说」，就能把整个词族连起来。',trace:[{label:'unpredictable',kind:'word',meaning:'不可预测的',sense_id:'P0001:s0003',source_ids:['Eunpredictable']},{label:'predictable',kind:'word',meaning:'能够被预测的',sense_id:'P0001:s0002',source_ids:['Epredictable']},...trace],source_ids:['Eunpredictable','Eun','Epredictable','Eable','Epredict','Epraedico','Edico','Edictus'],example:{en:'The weather here is unpredictable.',zh:'这里的天气难以预料。',kind:'original'},caveat}
];
const out={schema_version:'1.0.0',id:'dict',author,roots:[root],words,sources,changes:'中文释义、记忆拆解、溯源摘要为作者整理；例句为原创学习例句。保留每个原文片段及版本，学习摘要与不可变事实包分别审查。'};
const target='learning/dict/candidates/template/entry.json',bytes=Buffer.from(JSON.stringify(out,null,2)+'\n');
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(bytes);
if(changed)ws.atomic(ws.ROOT,target,bytes);
console.log(JSON.stringify({ok:true,entry:target,hash:kit.sha(bytes),changed,words:words.length,sources:sources.length}));
