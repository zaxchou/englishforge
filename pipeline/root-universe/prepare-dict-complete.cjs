'use strict';
// Rebuild a complete candidate from the CURRENT immutable profile, preserving prior fixes.
// This authoring step validates structure only; independent review and publication are separate.
const fs=require('node:fs');
const assert=require('node:assert/strict');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const learning=require('../../root-universe/learning.cjs');
const {englishEtymology,languageSection}=require('./source-english.cjs');
const AUTHOR='ZCode / magpie/codex/gpt-6.1-sol / review-20261108-R6 content author';
const TARGET='learning/dict/candidates/breakdown-review-fix';
const names=['contradict','contradiction','contradictory'];
const pointer=ws.json(ws.ROOT,'learning/dict/current.json');
assert.equal(pointer.id,'dict');
assert.match(pointer.version,/^[a-f0-9]{64}$/);
const base=ws.bytes(ws.ROOT,`learning/dict/versions/${pointer.version}/entry.json`);
assert.equal(kit.sha(base),pointer.version,'BASE_ENTRY_HASH');
const original=JSON.parse(base),entry=JSON.parse(base);
assert.equal(entry.schema_version,'1.1.0');
assert(entry.roots.some(r=>r.id==='Rdigit'),'CURRENT_DIGIT_FIX_REQUIRED');
const registered=ws.json(ws.ROOT,TARGET+'/sources.json');
assert.deepEqual(registered.map(s=>s.id).sort(),['EcontraPrefix','Econtradiction','Econtradictory','EionSuffix','ElatinContradico'].sort());
for(const source of registered){
 const raw=ws.bytes(ws.ROOT,source.snapshot),page=JSON.parse(raw).query.pages[0],rev=page.revisions[0];
 assert.equal(kit.sha(raw),source.snapshot_sha256,'SOURCE_RAW_HASH');
 assert.equal(page.title,source.entry);assert.equal(rev.revid,source.revision);
 const section=languageSection(rev.slots.main.content,source.language,source.entry);
 assert(section.includes(source.excerpt),'SOURCE_LANGUAGE_BOUNDARY');
 assert.equal(kit.sha(Buffer.from(source.excerpt)),source.excerpt_sha256);
 const capture=ws.json(ws.ROOT,source.capture);
 assert.equal(capture.snapshot_sha256,source.snapshot_sha256);
 assert.equal(capture.oldid_url,source.url);
 const old=entry.sources.find(s=>s.id===source.id);
 if(old)Object.assign(old,source);else entry.sources.push(source);
}
// Expand the EXISTING raw snapshot's excerpt; do not rewrite its bytes or provenance.
const contradictSource=entry.sources.find(s=>s.id==='Econtradict');
assert(contradictSource,'CONTRADICT_SOURCE_REQUIRED');
const contradictRaw=ws.bytes(ws.ROOT,contradictSource.snapshot);
assert.equal(kit.sha(contradictRaw),contradictSource.snapshot_sha256);
const contradictRev=JSON.parse(contradictRaw).query.pages[0].revisions[0];
assert.equal(contradictRev.revid,contradictSource.revision);
contradictSource.excerpt=englishEtymology(contradictRev.slots.main.content,'contradict');
assert(contradictSource.excerpt.includes('(originally two words).'),'FULL_BORROWING_QUALIFIER_REQUIRED');
contradictSource.excerpt_sha256=kit.sha(Buffer.from(contradictSource.excerpt));
const authored={
 contradict:{
  modern_formula:'现代记忆拆解：contra-「反对；相反」+ dict「说」→ 反着说 → 反驳；与…矛盾',
  explanation:'把 contra-「反对；相反」与 dict「说」连起来，记成「反着说」：可以反驳某人的说法，也可以指事实与某种说法相矛盾。这里的拆解是作者整理的现代记忆线索。历史上，英语词借自拉丁 contrādictus「被反驳的」，它是 contrādīcō「说反对的话」的过去被动分词；英语源页注明 originally two words（原作两个词）。拉丁源页也说明早期常分写或倒置。不能把现代英语的记忆拆解当作英语本土加前缀造词的历史。',
  source_ids:['Econtradict','EcontraPrefix','ElatinContradico','Edico','Edictus'],
  example:{kind:'original',en:'The new measurements contradict the earlier report.',zh:'新的测量结果与先前的报告相矛盾。'},
  recall:{prompt:'新的数据与先前报告相矛盾。用哪个动词表示「反驳；与…矛盾」？提示：反着说。',answer:'contradict',explanation:'contra-「反对；相反」+ dict「说」是现代记忆拆解；反着说 → 反驳、与…矛盾。历史上借自拉丁分词 contrādictus。'}
 },
 contradiction:{
  modern_formula:'现代记忆拆解：contra-「反对；相反」+ dict「说」+ -ion「行为、结果或状态」→ 反驳；矛盾',
  explanation:'先用 contra- + dict 记住「反着说」，再用名词后缀 -ion 记住反驳的行为或相互矛盾的状态。-ion 的源页把这种切分称为表层分析，并标注该用法非能产；这里用于理解既有词。历史路径是中古英语 contradiccioun / contradiction ← 古法语 contradiction ← 拉丁 contrādictiō ← contrādīcō「说反对的话」。所以 contradict + -ion 是现代记忆分析，不能据此宣称这个英语名词当初是在英语里由动词加 -ion 新造出来的。',
  source_ids:['Econtradiction','EcontraPrefix','EionSuffix','ElatinContradico','Edico','Edictus'],
  example:{kind:'original',en:'There is a contradiction between the two witness accounts.',zh:'两位证人的陈述之间存在矛盾。'},
  recall:{prompt:'两份陈述相互冲突；表示「矛盾；反驳」的名词是什么？提示：词尾是 -ion。',answer:'contradiction',explanation:'contra- + dict + -ion：用「反着说」加名词尾记住矛盾或反驳；历史上经中古英语、古法语追到拉丁 contrādictiō。'}
 },
 contradictory:{
  modern_formula:'现代记忆拆解：contra-「反对；相反」+ dict「说」+ -ory「…的」→ 相互矛盾的；对立的',
  explanation:'contra- + dict 先记成「反着说」，-ory 在此构成形容词的记忆线索：两份说法不能同时成立，就是 contradictory「相互矛盾的」。英语源页明确给出等价分析 contradict + -ory。它同时注明历史上借自晚期拉丁 contradictorius，进一步来自拉丁 contrādīcō。因此，现代可分析的结构与历史借入路径应分别理解。',
  source_ids:['Econtradictory','EcontraPrefix','ElatinContradico','Edico','Edictus'],
  example:{kind:'original',en:'The two witnesses gave contradictory accounts of the same event.',zh:'两位证人对同一事件作出了相互矛盾的陈述。'},
  recall:{prompt:'两位证人对同一事件的说法相互矛盾。表示「矛盾的；对立的」的形容词是什么？提示：词尾是 -ory。',answer:'contradictory',explanation:'contra- + dict + -ory：现代记忆分析为「反着说的」；来源也给出 contradict + -ory 的等价分析，历史借自晚期拉丁语。'}
 }
};
const prefix=()=>({label:'contra-',role:'prefix',meaning:'反对；相反（现代记忆拆解）',source_ids:['EcontraPrefix']}),
 root=()=>({label:'dict',role:'root',root_id:'Rdict',meaning:'说；讲（与拉丁 dīcō / dictus 相关的词干形式）',source_ids:['Edico','Edictus']});
const roles={
 contradict:[prefix(),root()],
 contradiction:[prefix(),root(),{label:'-ion',role:'suffix',meaning:'名词后缀：行为、结果或状态（现代表层分析；非能产）',source_ids:['EionSuffix']}],
 contradictory:[prefix(),root(),{label:'-ory',role:'suffix',meaning:'此处作形容词：…的（源页给出 contradict + -ory 等价分析）',source_ids:['Econtradictory']}]
};
const historical=(label,meaning,source_ids)=>({label,kind:'historical',meaning,source_ids});
const latinVerb=()=>historical('contrādīcō','拉丁语：说反对的话；反驳。构成为 contrā- + dīcō，早期常分写或倒置。',['ElatinContradico']);
const rootStep=()=>({label:'dīcō / dictus → dic- / dict-',kind:'root',meaning:'拉丁 dīcō「说、讲」；dictus 是其过去被动分词，现代记忆取 dict「说」。',root_id:'Rdict',source_ids:['Edico','Edictus']});
const trace={
 contradict:[historical('contrādictus','英语借入的拉丁过去被动分词：被反驳的；来自 contrādīcō。英语源页注明原作两个词。',['Econtradict']),latinVerb(),rootStep()],
 contradiction:[historical('contradiccioun / contradiction','中古英语形式；现代英语继承而来。',['Econtradiction']),historical('contradiction（古法语）','中古英语的来源为古法语 contradiction。',['Econtradiction']),historical('contrādictiō','拉丁语名词；古法语词的来源，进一步来自 contrādīcō。',['Econtradiction']),latinVerb(),rootStep()],
 contradictory:[historical('contradictorius','英语借自晚期拉丁语；进一步来自拉丁 contrādīcō。',['Econtradictory']),latinVerb(),rootStep()]
};
for(const name of names){
 const w=entry.words.find(w=>w.word===name),aw=entry.alliance.words.find(w=>w.word===name);
 assert(w&&aw,'EXISTING_WORD_REQUIRED '+name);
 assert.equal(w.id,aw.id);assert.equal(w.query_id,'Ldict:'+name);
 Object.assign(w,authored[name],{relation_kind:'close',parts:roles[name],trace:[{label:name,kind:'word',meaning:w.meaning,source_ids:[name==='contradict'?'Econtradict':name==='contradiction'?'Econtradiction':'Econtradictory']},...trace[name]],caveat:'现代记忆拆解由内容作者整理；历史借入路径与逐项来源分别列出，两者不互相替代。'});
 aw.clue=w.modern_formula;aw.source_ids=[...w.source_ids];
}
entry.author=AUTHOR;
entry.authorship={previous_author:original.author===AUTHOR?original.authorship?.previous_author:original.author,author:AUTHOR,scope:names,task:'review-20261108 R6',note:'仅署名本次三词内容与原创例句；其余内容沿用当前版本，不声称全78词精核。'};
const change='review-20261108 R6：仅补 contradict / contradiction / contradictory 的现代记忆拆解、历史借入路径、逐项来源、原创例句与回忆题；其余条目沿用，未作全78词精核。';
entry.changes=original.changes.includes(change)?original.changes:original.changes+' '+change;
// Preserve all existing identities, roots (including Rdigit), and unrelated content byte-for-byte as JSON values.
assert.deepEqual(entry.roots,original.roots);
assert.deepEqual(entry.words.filter(w=>!names.includes(w.word)),original.words.filter(w=>!names.includes(w.word)));
assert.deepEqual(entry.alliance.words.filter(w=>!names.includes(w.word)),original.alliance.words.filter(w=>!names.includes(w.word)));
assert.deepEqual({...entry.alliance,words:[]},{...original.alliance,words:[]});
for(const old of original.sources.filter(s=>s.id!=='Econtradict'&&!registered.some(r=>r.id===s.id)))assert.deepEqual(entry.sources.find(s=>s.id===old.id),old);
for(const old of original.words){const w=entry.words.find(w=>w.id===old.id);assert(w);for(const k of ['id','word','query_id','sense_id'])assert.equal(w[k],old[k]);}
const raw=Buffer.from(JSON.stringify(entry,null,2)+'\n');
const index=require('../../root-universe/build.cjs').current().index;
const valid=learning.validate(entry,raw,null,index,{requireReview:false});
const target=TARGET+'/entry.json';
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(raw);
if(changed)ws.atomic(ws.ROOT,target,raw);
const result={ok:true,validation:'learning.validate',requireReview:false,independent_review:'not performed; content author only',author:AUTHOR,base_version:pointer.version,target,changed,entry_sha256:kit.sha(raw),words:entry.words.length,sources:entry.sources.length,claims:valid.claims.length,claim_ids:valid.claims,changed_words:names,preserved_other_words:true,preserved_roots:true,preserved_identities:true,new_source_ids:registered.map(s=>s.id),expanded_excerpt_source:'Econtradict'};
ws.atomic(ws.ROOT,TARGET+'/validation.json',result);
console.log(JSON.stringify(result));
