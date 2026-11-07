'use strict';
// Source-bound learning profiles complement, but never mutate, the immutable fact index.
const fs=require('node:fs');
const ws=require('./workspace.cjs');
const kit=require('../pipeline/root-universe/validate-kit.cjs');
const key=s=>String(s||'').normalize('NFKC').trim().toLowerCase();
function assert(value,code){if(!value)throw Error(code);}
function queryId(entry,w){return w.sense_id||`L${entry.id}:${w.word.toLowerCase()}`;}
function validate(entry,raw,review,index,{requireReview=true,readSnapshot=rel=>ws.bytes(ws.ROOT,rel)}={}) {
  assert(['1.0.0','1.1.0'].includes(entry.schema_version)&&/^[a-z][a-z0-9-]*$/.test(entry.id),'LEARNING_SCHEMA');
  const extended=entry.schema_version==='1.1.0';
  assert(typeof entry.author==='string'&&entry.author.trim(),'LEARNING_AUTHOR');
  assert(Array.isArray(entry.sources)&&entry.sources.length&&Array.isArray(entry.roots)&&entry.roots.length&&Array.isArray(entry.words)&&entry.words.length,'LEARNING_EMPTY');
  const sources=new Map(),roots=new Map(),words=new Map(),claims=[],identities=new Map();
  const nodes=new Map(index.nodes.map(n=>[n.id,n])),wordIds=new Set(),spellings=new Set();
  const claim=(id,kind,identity)=>{
    assert(typeof id==='string'&&id.trim()===id&&id,'LEARNING_CLAIM_ID');
    const value=kind+':'+identity;
    assert(!identities.has(id)||identities.get(id)===value,'LEARNING_ID_COLLISION');
    identities.set(id,value);claims.push(id);
  };
  const bindSense=(id,word)=>{if(!id)return;const sense=nodes.get(id),head=nodes.get(sense?.headword_id);
    assert(sense?.type==='senses'&&head?.language==='en'&&key(head.display)===key(word),'LEARNING_WORD_BINDING');};
  for(const s of entry.sources){
    assert(!sources.has(s.id)&&s.excerpt&&s.license==='CC-BY-SA-4.0'&&s.attribution,'LEARNING_SOURCE');
    const bytes=readSnapshot(s.snapshot),rev=JSON.parse(bytes).query?.pages?.[0]?.revisions?.[0];
    assert(kit.sha(bytes)===s.snapshot_sha256&&rev?.revid===s.revision,'LEARNING_SOURCE_HASH');
    assert(rev.slots.main.content.includes(s.excerpt)&&kit.sha(Buffer.from(s.excerpt))===s.excerpt_sha256,'LEARNING_EXCERPT');
    const url=new URL(s.url);assert(url.origin==='https://en.wiktionary.org'&&url.pathname==='/w/index.php'&&url.searchParams.get('title')===s.entry&&url.searchParams.get('oldid')===String(s.revision),'LEARNING_SOURCE_URL');
    sources.set(s.id,s);claim(s.id,'source',s.id);
  }
  const refs=ids=>assert(Array.isArray(ids)&&ids.length&&new Set(ids).size===ids.length&&ids.every(id=>sources.has(id)),'LEARNING_EVIDENCE_MISSING');
  for(const r of entry.roots){
    assert(r.id&&r.label&&r.meaning&&!roots.has(r.id),'LEARNING_ROOT');refs(r.source_ids);
    if(r.earlier?.length)refs(r.earlier_source_ids);
    roots.set(r.id,r);claim(r.id,'root',r.id);
  }
  const courseRaw=entry.alliance||extended?fs.readFileSync(kit.safeFile(ws.PROJECT,'build/vocab/cfcm-words.json')):null;
  const courseWords=new Map();
  if(courseRaw)for(const b of JSON.parse(courseRaw).batches||[])for(const w of b.words||[])courseWords.set(key(w.w),{lesson:w.lesson,ipa:w.ipa||'',def:w.def||'',sen:w.sen||'',senZh:w.senZh||''});
  for(const w of entry.words){
    const id=queryId(entry,w);
    assert(w.id&&!wordIds.has(w.id)&&!words.has(id)&&w.word&&!spellings.has(key(w.word)),'LEARNING_WORD_ID');
    assert(w.sense_id||extended&&courseWords.has(key(w.word))&&/^[a-z][a-z-]*$/.test(w.word),'LEARNING_WORD_ID');
    bindSense(w.sense_id,w.word);wordIds.add(w.id);spellings.add(key(w.word));
    const relation=w.relation_kind||'close';assert(['close','cognate','classroom','unresolved'].includes(relation),'LEARNING_RELATION_KIND');
    assert(Array.isArray(w.root_ids)&&w.root_ids.every(id=>roots.has(id)),'LEARNING_ROOT_MISSING');
    assert(!['close','cognate'].includes(relation)||w.root_ids.length,'LEARNING_ROOT_MISSING');
    assert(w.parts?.length&&w.trace?.length&&w.modern_formula&&w.explanation&&w.meaning,'LEARNING_WORD');refs(w.source_ids);
    for(const p of w.parts){assert(['root','prefix','suffix','base'].includes(p.role)&&p.label&&p.meaning,'LEARNING_PART');if(p.root_id)assert(roots.has(p.root_id)&&w.root_ids.includes(p.root_id),'LEARNING_PART_ROOT');refs(p.source_ids);}
    for(const step of w.trace){assert(step.label&&step.meaning&&['word','historical','root'].includes(step.kind),'LEARNING_TRACE');refs(step.source_ids);if(step.sense_id)bindSense(step.sense_id,step.label);if(step.root_id)assert(roots.has(step.root_id)&&w.root_ids.includes(step.root_id),'LEARNING_TRACE_ROOT');}
    if(['close','cognate'].includes(relation))assert(w.trace.at(-1).root_id&&w.root_ids.includes(w.trace.at(-1).root_id),'LEARNING_INCOMPLETE_TRACE');
    if(w.example&&!extended)assert(w.example.kind==='original'&&w.example.en&&w.example.zh,'LEARNING_EXAMPLE');
    if(extended){
      if(w.example)assert(['original','course'].includes(w.example.kind)&&w.example.en&&w.example.zh,'LEARNING_EXAMPLE');
      if(w.recall){assert(w.recall.prompt&&w.recall.answer&&w.recall.explanation,'LEARNING_RECALL');
        assert(key(w.recall.answer)===key(w.word),'LEARNING_RECALL_ANSWER');
        assert(!new RegExp('\\b'+w.word+'\\b','i').test(w.recall.prompt),'LEARNING_RECALL_LEAK');}
    }
    words.set(id,{...w,query_id:extended?id:null,relation_kind:extended?relation:'close'});claim(w.id,'word',key(w.word)+':'+(w.sense_id||''));
  }
  let alliance=null;
  if(entry.alliance){
    const a=entry.alliance;
    assert(a.title&&Array.isArray(a.branches)&&a.branches.length&&Array.isArray(a.words)&&a.words.length,'ALLIANCE_SCHEMA');
    assert(a.course_file==='build/vocab/cfcm-words.json'&&kit.sha(courseRaw)===a.course_sha256,'ALLIANCE_COURSE_HASH');
    const branchIds=new Set(a.branches.map(b=>b.id));assert(branchIds.size===a.branches.length,'ALLIANCE_BRANCH_DUP');
    const allianceIds=new Set(),allianceWords=new Map();
    for(const w of a.words){
      assert(w.id&&!allianceIds.has(w.id)&&w.word&&w.clue&&branchIds.has(w.branch),'ALLIANCE_WORD');
      const c=courseWords.get(key(w.word));assert(c&&c.lesson===w.lesson,'ALLIANCE_COURSE_MISSING '+w.word);
      assert(!allianceWords.has(key(w.word)),'ALLIANCE_DUPLICATE_WORD');
      allianceIds.add(w.id);allianceWords.set(key(w.word),w);bindSense(w.sense_id,w.word);
      refs(w.source_ids);claim(w.id,'word',key(w.word)+':'+(w.sense_id||''));
      if(extended){const full=words.get(queryId(entry,w));assert(full&&full.id===w.id&&full.word===w.word,'ALLIANCE_PROFILE_MISSING');}
    }
    for(const b of a.branches){
      assert(b.id&&b.title&&b.idea&&Array.isArray(b.word_ids)&&b.word_ids.length,'ALLIANCE_BRANCH');refs(b.source_ids);claim(b.id,'branch',b.id);
      const expected=a.words.filter(w=>w.branch===b.id).map(w=>w.id);
      assert(new Set(b.word_ids).size===b.word_ids.length&&b.word_ids.length===expected.length&&expected.every(id=>b.word_ids.includes(id)),'ALLIANCE_BRANCH_MEMBERS');
    }
    assert(Array.isArray(a.excluded),'ALLIANCE_EXCLUDED');const excluded=new Set();
    for(const x of a.excluded){assert(x.word&&x.reason&&!allianceWords.has(key(x.word))&&!excluded.has(key(x.word)),'ALLIANCE_EXCLUDED_CLASH '+x.word);
      assert(courseWords.has(key(x.word)),'ALLIANCE_EXCLUDED_NOT_COURSE '+x.word);excluded.add(key(x.word));
      if(extended){assert(['unresolved','different-root'].includes(x.status),'ALLIANCE_EXCLUSION_STATUS');if(x.status==='different-root')refs(x.source_ids);}
      claim('X'+x.word,'exclusion',key(x.word));
    }
    const project=w=>{const full=words.get(queryId(entry,w))||w;return {...full,...w,...courseWords.get(key(w.word)),query_id:extended?queryId(entry,w):w.sense_id||null,sense_id:w.sense_id||null,relation_kind:full.relation_kind||w.relation_kind||'close'};};
    alliance={id:entry.id,branches:a.branches.map(b=>({...b,words:a.words.filter(w=>w.branch===b.id).map(project)})),words:a.words.map(project),excluded:a.excluded,coverage_note:a.coverage_note,title:a.title,scope:a.scope||null};
    if(extended)assert(entry.words.length===a.words.length,'ALLIANCE_PROFILE_CLOSURE');
  }
  const uniqueClaims=[...new Set(claims)];
  if(requireReview){
    assert(review?.decision==='approved'&&review.entry_sha256===kit.sha(raw),'LEARNING_REVIEW_HASH');
    assert(typeof review.reviewer==='string'&&key(review.reviewer)&&key(review.reviewer)!==key(entry.author)&&typeof review.review_run_id==='string'&&review.review_run_id.trim(),'LEARNING_INDEPENDENT_REVIEW');
    assert(Array.isArray(review.approved_ids)&&review.approved_ids.length===uniqueClaims.length&&new Set(review.approved_ids).size===uniqueClaims.length&&uniqueClaims.every(id=>review.approved_ids.includes(id)),'LEARNING_REVIEW_CLOSURE');
  }
  return {sources,roots,words,claims:uniqueClaims,alliance};
}
// A pointer changes only after the entire candidate has been validated and persisted.
function publish(index,{entryRaw,reviewRaw,base=ws.ROOT}={}){
  const e=JSON.parse(entryRaw),r=JSON.parse(reviewRaw),v=validate(e,entryRaw,r,index,{readSnapshot:rel=>ws.bytes(base,rel)});
  const version=kit.sha(entryRaw),prefix=`learning/${e.id}`,rel=`${prefix}/versions/${version}`;
  return ws.locked(base,'learning-publish',()=>{
    const files={'entry.json':entryRaw,'review.json':reviewRaw};
    for(const [name,bytes] of Object.entries(files)){
      const dest=ws.file(base,rel+'/'+name);
      if(fs.existsSync(dest))assert(ws.bytes(base,rel+'/'+name).equals(Buffer.from(bytes)),'LEARNING_VERSION_IMMUTABLE');
      else ws.atomic(base,rel+'/'+name,bytes);
    }
    const pointer={schema_version:'1.0.0',id:e.id,version,review_sha256:kit.sha(reviewRaw),claims:v.claims.length};
    const current=ws.file(base,prefix+'/current.json');
    const previous=fs.existsSync(current)?ws.json(base,prefix+'/current.json'):null;
    if(previous&&previous.version===version&&previous.review_sha256===pointer.review_sha256)return {...pointer,changed:false};
    if(previous)ws.atomic(base,prefix+'/history/'+previous.version+'.json',previous);
    ws.atomic(base,prefix+'/current.json',pointer);return {...pointer,changed:true};
  });
}
const caches=new WeakMap();
function load(index,{base=ws.ROOT}={}) {
  const dir=ws.file(base,'learning'),entries=[],unavailable=[];
  if(!fs.existsSync(dir))return {entries,unavailable};
  let cache=caches.get(index);if(!cache){cache=new Map();caches.set(index,cache);}
  for(const name of fs.readdirSync(dir).sort()){
    if(!/^[a-z][a-z0-9-]*$/.test(name))continue;
    let rel=`learning/${name}/entry.json`,reviewRel=`learning/${name}/review.json`,token=null;
    try {
      const pointerRel=`learning/${name}/current.json`;
      if(fs.existsSync(ws.file(base,pointerRel))){
        const pRaw=ws.bytes(base,pointerRel),p=JSON.parse(pRaw);
        assert(p.id===name&&/^[a-f0-9]{64}$/.test(p.version)&&/^[a-f0-9]{64}$/.test(p.review_sha256),'LEARNING_POINTER');
        token=base+':'+name+':'+kit.sha(pRaw);const saved=cache.get(token);
        if(saved){entries.push(saved);continue;}
        rel=`learning/${name}/versions/${p.version}/entry.json`;reviewRel=`learning/${name}/versions/${p.version}/review.json`;
        assert(kit.sha(ws.bytes(base,rel))===p.version&&kit.sha(ws.bytes(base,reviewRel))===p.review_sha256,'LEARNING_VERSION_HASH');
      }
      if(!fs.existsSync(ws.file(base,rel)))continue;
      const raw=ws.bytes(base,rel),e=JSON.parse(raw),r=ws.json(base,reviewRel);
      assert(e.id===name,'LEARNING_DIRECTORY_ID');
      const valid=validate(e,raw,r,index,{readSnapshot:rel=>ws.bytes(base,rel)});
      const loaded={...e,words:[...valid.words.values()],version:kit.sha(raw),reviewed:true,alliance:valid.alliance||null};
      entries.push(loaded);if(token){for(const old of cache.keys())if(old.startsWith(base+':'+name+':'))cache.delete(old);cache.set(token,loaded);}
    }catch(e){unavailable.push({id:name,reason:e.message});}
  }
  return {entries,unavailable};
}
function query(index,id,options){
  const data=load(index,options);
  const matches=data.entries.flatMap(e=>e.words.filter(w=>w.query_id===id||w.sense_id===id).map(w=>({entry:e,word:w})));
  assert(matches.length<=1,'LEARNING_DUPLICATE_WORD');
  if(!matches.length)return index.nodes.some(n=>n.id===id)?{status:'unresolved',sense_id:id,message:'这个词义的词根溯源还未完成核对。'}:null;
  const {entry,word}=matches[0];
  const members=entry.alliance?entry.words:entry.words.filter(w=>w.root_ids.some(id=>word.root_ids.includes(id)));
  return {status:'reviewed',sense_id:word.sense_id||null,query_id:word.query_id,version:entry.version,word,roots:entry.roots.filter(r=>word.root_ids.includes(r.id)),family_roots:entry.roots,family:members.map(w=>({query_id:w.query_id,sense_id:w.sense_id||null,word:w.word,meaning:w.meaning})),members,sources:entry.sources,changes:entry.changes,alliance:entry.alliance||null};
}
function catalog(index,options){return load(index,options).entries.flatMap(e=>e.words.filter(w=>w.query_id).map(w=>({id:w.query_id,type:'learning_word',label:w.word,zh:w.meaning,pos:'',language:'en',course_member:true,alliance_id:e.id,relation_kind:w.relation_kind})));}
module.exports={validate,load,query,publish,catalog,queryId};
