'use strict';
const fs=require('node:fs');
const crypto=require('node:crypto');
const ws=require('./workspace.cjs');
const core=require('./core.cjs');
const kit=require('../pipeline/root-universe/validate-kit.cjs');
const VERSION=/^v-[a-f0-9]{64}$/;
function snapshot(base,version,expected) {
  if(!VERSION.test(version))throw Error('VERSION_INVALID');
  const manifest=ws.json(base,`versions/${version}/manifest.json`), raw=ws.bytes(base,`versions/${version}/index.json`), registry=ws.bytes(base,`versions/${version}/registry.json`);
  if(manifest.version!==version || manifest.index_sha256!==kit.sha(raw) || manifest.registry_sha256!==kit.sha(registry) || expected&&expected!==kit.sha(registry)) throw Error('SNAPSHOT_HASH');
  const index=JSON.parse(raw), reg=JSON.parse(registry);
  const inQA=base===ws.QA||base.startsWith(ws.QA+require('node:path').sep);
  if((index.synthetic&&!inQA) || reg.synthetic!==index.synthetic || core.stable(reg)!==core.stable({schema_version:index.schema_version,synthetic:index.synthetic,nodes:index.nodes,evidence:index.evidence})) throw Error('SNAPSHOT_REGISTRY');
  if('v-'+core.hash(index)!==version)throw Error('SNAPSHOT_VERSION');
  return {manifest,index,registry:reg};
}
function current(base=ws.ROOT) {
  const pointer=ws.json(base,'current.json');
  const s=snapshot(base,pointer.version);
  if(pointer.index_sha256!==s.manifest.index_sha256 || pointer.parent!==s.manifest.parent)throw Error('CURRENT_HASH');
  return {...s,pointer};
}
function build(ids,{base=ws.ROOT,failAt,syntheticBundles}={}) {
  base=ws.controlled(base);
  if(syntheticBundles && !(base===ws.QA||base.startsWith(ws.QA+require('node:path').sep)))throw Error('SYNTHETIC_BUILD_QA_ONLY');
  if(!ids.length || ids.some(id=>!ws.PID.test(id)))throw Error('PACKET_IDS_REQUIRED');
  return ws.locked(base,'build',()=>{
    const old=fs.existsSync(ws.file(base,'current.json'))?current(base):null;
    const requested=[...new Set([...(old?.index.packets.map(p=>p.packet_id)||[]),...ids])].sort();
    const bundles=requested.map(id=>syntheticBundles?syntheticBundles.find(b=>b.p.packet_id===id)||(()=>{throw Error('TEST_BUNDLE_MISSING');})():ws.bundle(id,'verified',base));
    for(const row of old?.index.packets||[]) if(kit.sha(bundles.find(b=>b.p.packet_id===row.packet_id).raw)!==row.packet_sha256)throw Error('IMMUTABLE_PACKET_REVISION_UNSUPPORTED: use integration task F-revisions');
    const index=core.compile(bundles,{allowSynthetic:!!syntheticBundles,resolveRegistry:(version,digest)=>snapshot(base,version,digest).registry});
    if(old) for(const node of old.index.nodes) {
      const replacement=index.nodes.find(n=>n.id===node.id);
      if(!replacement || core.semanticNode(node,node.type,new Map(old.index.evidence.map(e=>[e.id,e])))!==core.semanticNode(replacement,replacement.type,new Map(index.evidence.map(e=>[e.id,e]))))throw Error('IMMUTABLE_ID_CHANGE: '+node.id);
    }
    const version='v-'+core.hash(index);
    if(old?.pointer.version===version)return {ok:true,idempotent:true,version,counts:counts(index)};
    const tmp=`versions/.building-${crypto.randomUUID()}`, final=`versions/${version}`;
    ws.mkdir(base,tmp);
    try {
      const raw=Buffer.from(core.stable(index)+'\n');
      const registry=Buffer.from(core.stable({schema_version:index.schema_version,synthetic:index.synthetic,nodes:index.nodes,evidence:index.evidence})+'\n');
      const manifest={schema_version:'1.1.0',version,parent:old?.pointer.version||null,index_sha256:kit.sha(raw),registry_sha256:kit.sha(registry),packets:index.packets,
        reviews:bundles.map(b=>({packet_id:b.p.packet_id,review_sha256:kit.sha(b.reviewRaw||Buffer.from(core.stable(b.r))),reviewer:b.r.reviewer,review_run_id:b.r.review_run_id,translation_reviewer:b.r.translation_reviewer,translation_run_id:b.r.translation_run_id})),counts:counts(index),attribution:index.evidence.map(e=>({id:e.id,url:e.url,source_version:e.source_version,license:e.license,attribution:e.attribution,changes:e.translation_note}))};
      ws.atomic(base,`${tmp}/index.json`,raw); ws.atomic(base,`${tmp}/registry.json`,registry);ws.atomic(base,`${tmp}/manifest.json`,manifest);
      if(failAt==='after-write')throw Error('INJECTED_BUILD_FAILURE');
      if(fs.existsSync(ws.file(base,final)))snapshot(base,version);
      else fs.renameSync(ws.file(base,tmp),ws.file(base,final));
      const sealed=snapshot(base,version);
      if(old)ws.atomic(base,`history/${old.pointer.version}.json`,old.pointer);
      if(failAt==='before-switch')throw Error('INJECTED_BUILD_FAILURE');
      ws.atomic(base,'current.json',{version,index_sha256:sealed.manifest.index_sha256,parent:sealed.manifest.parent});
      return {ok:true,idempotent:false,version,counts:sealed.manifest.counts};
    } finally { if(fs.existsSync(ws.file(base,tmp)))fs.rmSync(ws.file(base,tmp),{recursive:true}); }
  });
}
function counts(index) {return {headwords:index.nodes.filter(n=>n.type==='headwords').length,senses:index.nodes.filter(n=>n.type==='senses').length,etymologies:index.nodes.filter(n=>n.type==='etymologies').length,morphemes:index.nodes.filter(n=>n.type==='morphemes').length,facts:index.facts.length,evidence:index.evidence.length,modern_senses:index.coverage.modern_sense_ids.length,historical_senses:index.coverage.historical_sense_ids.length};}
function rollback(version,{base=ws.ROOT}={}) {
  return ws.locked(base,'build',()=>{
    const old=current(base), target=snapshot(base,version);let ancestor=old.manifest.parent;const seen=new Set();
    while(ancestor&&ancestor!==version){if(seen.has(ancestor))throw Error('MANIFEST_PARENT_CYCLE');seen.add(ancestor);ancestor=snapshot(base,ancestor).manifest.parent;}
    if(version!==old.manifest.version&&ancestor!==version)throw Error('ROLLBACK_NOT_ANCESTOR');
    ws.atomic(base,`history/${old.pointer.version}.json`,old.pointer);
    ws.atomic(base,'current.json',{version,index_sha256:target.manifest.index_sha256,parent:target.manifest.parent});
    return {ok:true,version,counts:counts(target.index)};
  });
}
module.exports={build,current,snapshot,counts,rollback};
