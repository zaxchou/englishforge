'use strict';
// Executes explicit, human authored selections from controlled candidate-plan.json.
// Does not discover facts, choose senses, assign review identities, or sign reviews.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
function assemble(id,owner) {
  ws.task(id);const dir=`packets/${id}`, claim=ws.json(ws.ROOT,`${dir}/claim.json`);
  if(claim.owner!==owner)throw Error('CLAIM_OWNER_MISMATCH');
  if(fs.existsSync(ws.file(ws.ROOT,`${dir}/packet.json`)))throw Error('PACKET_EXISTS: preserve IDs and use explicit rework');
  const plan=ws.json(ws.ROOT,`${dir}/candidate-plan.json`), captures=ws.json(ws.ROOT,`${dir}/captures.json`), sources=new Map();
  const courseRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,'build/vocab/cfcm-words.json')), course=JSON.parse(courseRaw);
  const membership={file:'build/vocab/cfcm-words.json',input_sha256:kit.sha(courseRaw),checked_at:ws.now(),matches:{},method:'逐个核对本包英文词头；不输出完整词表'};
  for(const h of plan.headwords) {
    const hits=h.language==='en'?(course.batches||[]).filter(b=>(b.words||[]).some(w=>w.w===h.title)).map(b=>b.id):[];
    if(!!h.course_member!==(hits.length>0))throw Error('COURSE_MEMBERSHIP_MISMATCH: '+h.title+'; check local course and explicit plan flag');
    membership.matches[h.title]=hits;
  }
  for(const capture of captures) {
    if(capture.title==='@rights')continue;
    const raw=ws.bytes(ws.ROOT,capture.snapshot);if(kit.sha(raw)!==capture.response_sha256)throw Error('CAPTURE_HASH');
    const page=JSON.parse(raw).query.pages[0], revision=page.revisions[0];
    if('enwiktionary-revid-'+revision.revid!==capture.source_version)throw Error('CAPTURE_VERSION');
    sources.set(capture.title,{capture,text:revision.slots.main.content});
  }
  const p={schema_version:'1.1.0',packet_id:id,synthetic:false,authors:[owner],created_at:ws.now(),scope:plan.scope,headwords:[],etymologies:[],senses:[],morphemes:[],evidence:[],analyses:[],relations:[],homograph_groups:[],redirects:[],publish_fact_ids:[],publish_node_ids:[]};
  const nid=k=>id+':'+k, node=k=>({id:nid(k),origin_packet:id,record_role:'owned'}), evMap=new Map(), selected=new Map();
  function evidence(title,language,locator,original) {
    const {capture,text}=sources.get(title)||{};if(!capture||!text.includes(original))throw Error('EXCERPT_NOT_IN_CAPTURE: '+title+'/'+locator);
    const start=text.indexOf(original), key=title+'|'+locator+'|'+original;if(evMap.has(key))return evMap.get(key);
    const eid=nid('e'+String(p.evidence.length+1).padStart(4,'0'));
    p.evidence.push({id:eid,source_family:'enwiktionary',url:'https://en.wiktionary.org/w/index.php?title='+encodeURIComponent(title)+'&oldid='+capture.source_version.replace('enwiktionary-revid-',''),entry:title,
      locator:language+'/'+locator+'; wikitext UTF-16 offset '+start+'; snapshot '+capture.snapshot,source_version:capture.source_version,retrieved_at:capture.retrieved_at,license:'CC-BY-SA-4.0',attribution:'English Wiktionary contributors, '+title+', revision '+capture.source_version.replace('enwiktionary-revid-','')+'; https://en.wiktionary.org/w/index.php?title='+encodeURIComponent(title)+'&action=history; CC BY-SA 4.0',original_text:original,excerpt_sha256:kit.sha(Buffer.from(original)),translation_zh:'',translation_note:'原文保留Wiktionary标记；节点英文为作者去标记整理，中文为作者翻译，均待独立复核。未修改原文片段。',captured_by:owner});
    evMap.set(key,eid);return eid;
  }
  for(const h of plan.headwords) {
    const source=sources.get(h.title);if(!source)throw Error('SOURCE_NOT_ACQUIRED: '+h.title);
    const marker='=='+h.source_language+'==', start=source.text.indexOf(marker);if(start<0)throw Error('LANGUAGE_NOT_FOUND');
    const next=source.text.indexOf('\n==',start+marker.length), rest=source.text.slice(start,next<0?undefined:next);
    // Heading includes are explicit; the revision URL and entry preserve lemma identity.
    const e=evidence(h.title,h.source_language,'language heading',marker);
    p.headwords.push({...node(h.key),language:h.language,display:h.title,lookup_key:kit.normalized(h.title),aliases:[],course_member:!!h.course_member,evidence_ids:[e]});
    for(const et of h.etymologies) {
      const heading='===Etymology'+(et.number?' '+et.number:'')+'===', begin=source.text.indexOf(heading,start);
      if(begin<0)throw Error('ETYMOLOGY_NOT_FOUND');
      const after=source.text.indexOf('\n===',begin+heading.length), end=after<0?source.text.length:after;
      const raw=source.text.slice(begin,end).trimEnd();
      const ee=evidence(h.title,h.source_language,'Etymology'+(et.number?' '+et.number:''),raw);
      p.etymologies.push({...node(et.key),headword_id:nid(h.key),identity_note:et.identity_note,source_locators:[{evidence_id:ee,source_version:source.capture.source_version,etymology_number:et.number,location:h.source_language+'/'+heading}]});
      for(const s of et.senses) {
        // Verify selected definition occurs under this language/etymology, not another homograph.
        const langEnd=source.text.slice(start+marker.length).search(/\n==[^=]/);const boundary=langEnd<0?source.text.length:start+marker.length+langEnd;
        const etEnd=source.text.indexOf('\n===Etymology ',begin+heading.length);
        const segment=source.text.slice(begin,Math.min(boundary,etEnd<0?boundary:etEnd));
        if(!segment.includes(s.original_line))throw Error('SENSE_OUTSIDE_SELECTED_ETYMOLOGY: '+s.key);
        const se=evidence(h.title,h.source_language,'Etymology'+(et.number?' '+et.number:'')+'/'+s.pos+'/'+s.key,s.original_line);
        p.headwords.find(x=>x.id===nid(h.key)).evidence_ids.push(se);
        p.senses.push({...node(s.key),headword_id:nid(h.key),etymology_id:nid(et.key),pos:s.pos,sense_key:s.key,definition_original:s.definition_original,definition_zh:s.definition_zh,evidence_ids:[se],coverage:{modern:'pending',historical:'pending',family:'unresolved'},coverage_notes:s.notes||'所选词义及中文为作者整理；全词族、来源链完整性与独立批准尚未完成。'});
        selected.set(s.key,{headword:h,etymology:et,sense:s});
      }
    }
  }
  for(const r of plan.relations) {
    const src=sources.get(r.source_title), ee=evidence(r.source_title,r.source_language,r.locator,r.original_text);
    if(!src)throw Error('RELATION_SOURCE_MISSING');
    const extra=(r.additional_evidence||[]).map(e=>evidence(e.title,e.language,e.locator,e.original_text));
    const fact={id:nid(r.key),from_id:nid(r.from),to_id:nid(r.to),type:r.type,layer:r.layer,assertion:'positive',evidence_ids:[ee,...extra],status:r.status,author:owner,note:r.note};p.relations.push(fact);
    if(r.request_publication){if(r.status!=='source_verified')throw Error('REQUEST_MUST_BE_SOURCE_VERIFIED');p.publish_fact_ids.push(fact.id);}
  }
  for(const g of plan.homograph_groups||[])p.homograph_groups.push({id:nid(g.key),headword_id:nid(g.headword),etymology_ids:g.etymologies.map(nid),note:g.note});
  p.publish_node_ids=kit.publicationPlan(p).node_ids;
  const raw=Buffer.from(JSON.stringify(p,null,2)+'\n'), errors=kit.validatePacket(p,raw,null,'candidate',kit.loadSchema());if(errors.length){const e=Error('CANDIDATE_INVALID');e.errors=errors;throw e;}
  ws.atomic(ws.ROOT,`${dir}/packet.json`,raw);
  ws.atomic(ws.ROOT,`${dir}/scope.json`,{packet_id:id,selected_sense_ids:p.senses.map(s=>s.id),headwords:p.headwords.map(h=>({id:h.id,display:h.display,language:h.language,course_member:h.course_member})),course_membership:membership,unresolved:plan.unresolved||[],provenance:{author:owner,identity_format:'workflow_run_id / workflow_actor / actor_name; actor is not a host agent UUID'}});
  ws.atomic(ws.ROOT,`${dir}/handoff.md`,plan.handoff+'\n\n作者身份：'+owner+'\n\n当前packet SHA-256：'+kit.sha(raw)+'\n独立review.json/review.md尚未创建；作者未签署。拟发布集合只是请求。累计返工见claim.json（当前'+claim.returns+'）。来源快照/字节哈希/取得时间见captures.json及snapshot capture.json。\n');
  ws.claim(id,owner,{status:'ready_for_review'});return {packet_id:id,packet_sha256:kit.sha(raw),headwords:p.headwords.length,senses:p.senses.length,evidence:p.evidence.length,requested_facts:p.publish_fact_ids.length,requested_nodes:p.publish_node_ids.length};
}
module.exports={assemble};
if(require.main===module){try{const [id,owner]=process.argv.slice(2);process.stdout.write(JSON.stringify({ok:true,...assemble(id,owner)})+'\n');}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message,errors:e.errors})+'\n');process.exitCode=1;}}
