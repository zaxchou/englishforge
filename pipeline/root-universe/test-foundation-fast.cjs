'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const kit=require('./validate-kit.cjs');
const core=require('../../root-universe/core.cjs');
const ws=require('../../root-universe/workspace.cjs');
const builder=require('../../root-universe/build.cjs');
const copy=x=>JSON.parse(JSON.stringify(x));
// Only synthetic assertions/review signatures. No real source approval is generated here.
function seal(f) {
  f.p.publish_node_ids=kit.publicationPlan(f.p).node_ids;
  f.raw=Buffer.from(JSON.stringify(f.p,null,2)+'\n');f.r.packet_sha256=kit.sha(f.raw);
  const plan=kit.publicationPlan(f.p);
  f.r.approved_fact_ids=[...f.p.publish_fact_ids];f.r.approved_node_ids=[...plan.node_ids];
  f.r.fact_checks=f.p.publish_fact_ids.map(id=>({fact_id:id,verdict:'approved',checked_evidence_ids:[...f.p.relations,...f.p.analyses].find(f=>f.id===id).evidence_ids,translation_verdict:'approved',notes:'SYNTHETIC ONLY'}));
  f.r.node_checks=plan.node_ids.map(id=>({node_id:id,verdict:'approved',checked_fields:kit.PUBLISH_FIELDS[plan.nodeMap.get(id).type],checked_evidence_ids:plan.nodeEvidence.get(id),translation_verdict:'approved',notes:'SYNTHETIC ONLY'}));
  f.r.source_checks=plan.evidence_ids.map(id=>({evidence_id:id,excerpt_sha256:f.p.evidence.find(e=>e.id===id).excerpt_sha256,actual_source_checked:true,license_checked:true,attribution_checked:true,notes:'SYNTHETIC ONLY, no actual source'}));
  return f;
}
function renamed(id){const f=kit.fixture();return seal(JSON.parse(JSON.stringify({p:f.p,r:f.r}).replaceAll('P9999',id)));}
function crossReference(a) {
  const f=renamed('P9998');
  for(const type of kit.NODE_FIELDS) f.p[type]=copy(a.p[type].filter(n=>n.id!=='P9999:t2')).map(n=>{
    n.record_role='reference';n.registry_version='synthetic-registry-v1';n.registry_sha256='a'.repeat(64);
    if(n.evidence_ids)n.evidence_ids=['P9998:e1'];
    if(n.source_locators)n.source_locators.forEach(l=>l.evidence_id='P9998:e1');
    if(n.forms)n.forms.forEach(form=>form.evidence_ids=['P9998:e1']);return n;
  });
  f.p.homograph_groups=[];Object.assign(f.p.relations[0],{from_id:'P9999:s1',to_id:'P9999:m1',type:'borrowed_from'});
  return seal(f);
}
function runFast() {
  const checks=[], errors=[];
  const check=(name,fn)=>{try{fn();checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:e.message});errors.push({name,message:e.message,stack:e.stack});}};
  const base=path.join(ws.QA,'fast-'+crypto.randomUUID());ws.mkdir(base);
  check('import has no CLI stdout or exitCode side effect',()=>{const child=spawnSync(process.execPath,['-e',`process.exitCode=23;require(${JSON.stringify(path.join(__dirname,'validate-kit.cjs'))});if(process.exitCode!==23)throw Error('exitCode changed');`],{encoding:'utf8',cwd:ws.PROJECT});assert.equal(child.status,23);assert.equal(child.stdout,'');assert.equal(child.stderr,'');});
  check('original 1.1.0 self-test including all contract counterexamples',()=>{const r=kit.selfTest(kit.loadSchema());assert.equal(r.ok,true,JSON.stringify(r.errors));checks.push(...r.checks.map(c=>({...c,name:'contract: '+c.name})));});
  check('candidate, disputed, unapproved text excluded from approved projection',()=>{
    const f=kit.fixture();f.p.senses[0].coverage_notes='UNREVIEWED SECRET';f.p.scope='UNREVIEWED SCOPE';f.p.morphemes.push({...copy(f.p.morphemes[0]),id:'P9999:m2'});f.p.relations.push({...copy(f.p.relations[0]),id:'P9999:r2',to_id:'P9999:m2',status:'disputed',note:'UNREVIEWED CANDIDATE'});seal(f);
    const i=core.compile([f],{allowSynthetic:true});const text=core.stable(i);assert(!text.includes('UNREVIEWED'));assert(!i.nodes.some(n=>n.id==='P9999:m2'));assert.equal(i.facts.length,1);
  });
  check('real build refuses synthetic bundles even when explicitly requested',()=>assert.throws(()=>builder.build(['P9999'],{syntheticBundles:[kit.fixture()]}),/SYNTHETIC_BUILD_QA_ONLY/));
  check('synthetic cannot pass production project path',()=>assert.throws(()=>core.project(kit.fixture()),/VERIFIED_REQUIRED/));
  check('repeated same packet is idempotent and input ordering deterministic',()=>{const a=kit.fixture(),b=renamed('P9998');assert.equal(core.stable(core.compile([a,a,b],{allowSynthetic:true})),core.stable(core.compile([b,a],{allowSynthetic:true})));});
  check('same packet ID with changed bytes rejected',()=>{const a=kit.fixture(),b=kit.fixture();b.p.scope+='x';seal(b);assert.throws(()=>core.compile([a,b],{allowSynthetic:true}),/PACKET_HASH_CONFLICT/);});
  check('cross packet reference proves exact registry version/hash and semantic fields',()=>{
    const a=kit.fixture(),b=crossReference(a),p=core.project(a,{allowSynthetic:true});
    const reg={nodes:p.nodes,evidence:p.evidence};let calls=0;
    const options={allowSynthetic:true,resolveRegistry:(v,h)=>{assert.equal(v,'synthetic-registry-v1');assert.equal(h,'a'.repeat(64));calls++;return reg;}};
    assert.equal(core.compile([a,b],options).facts.length,2);assert(calls>0);
    b.p.senses[0].definition_zh='合成篡改';seal(b);assert.throws(()=>core.compile([a,b],options),/REFERENCE_SEMANTIC_CONFLICT/);
    const c=crossReference(a);assert.throws(()=>core.compile([a,c],{allowSynthetic:true,resolveRegistry:()=>{throw Error('SNAPSHOT_HASH');}}),/SNAPSHOT_HASH/);
  });
  check('cross packet same proposition duplicate and polarity conflict rejected',()=>{
    const a=kit.fixture(),b=crossReference(a),p=core.project(a,{allowSynthetic:true}),opts={allowSynthetic:true,resolveRegistry:()=>({nodes:p.nodes,evidence:p.evidence})};
    b.p.relations[0].type='historical_derived_from';seal(b);assert.throws(()=>core.compile([a,b],opts),/DUPLICATE_GLOBAL_RELATION/);
    b.p.relations[0].assertion='negative';seal(b);assert.throws(()=>core.compile([a,b],opts),/GLOBAL_RELATION_CONFLICT/);
  });
  check('same spelling different etymologies remains two separate senses',()=>{
    const f=kit.fixture();f.p.etymologies[1].source_locators=copy(f.p.etymologies[0].source_locators);f.p.senses.push({...copy(f.p.senses[0]),id:'P9999:s2',etymology_id:'P9999:t2',sense_key:'synthetic-two'});
    f.p.relations.push({...copy(f.p.relations[0]),id:'P9999:r2',from_id:'P9999:s2'});f.p.publish_fact_ids.push('P9999:r2');seal(f);
    const i=core.compile([f],{allowSynthetic:true}),results=core.search(i,'SyntheticA');assert.equal(results.results[0].senses.length,2);assert.notEqual(results.results[0].senses[0].etymology_id,results.results[0].senses[1].etymology_id);
  });
  check('bounded directional and symmetric neighbors, unknown IDs, query limits',()=>{
    const f=kit.fixture(),i=core.compile([f],{allowSynthetic:true});assert.equal(core.neighbors(i,'P9999:s1',{direction:'out'}).edges.length,1);assert.equal(core.neighbors(i,'P9999:s1',{direction:'in'}).edges.length,0);assert(core.neighbors(i,'P9999:s1',{maxNodes:1}).truncated);assert.equal(core.neighbors(i,'P9999:nope').found,false);
    assert.throws(()=>core.neighbors(i,'P9999:s1',{depth:3}),/QUERY_LIMIT/);assert.throws(()=>core.search(i,'x'.repeat(121)),/INPUT_LIMIT/);assert.throws(()=>core.neighbors(i,'P9999:s1',{maxEdges:201}),/QUERY_LIMIT/);
    f.p.morphemes.push({...copy(f.p.morphemes[0]),id:'P9999:m2'});f.p.relations.push({...copy(f.p.relations[0]),id:'P9999:r2',from_id:'P9999:m1',to_id:'P9999:m2',type:'cognate_with'});f.p.publish_fact_ids.push('P9999:r2');seal(f);
    const j=core.compile([f],{allowSynthetic:true});assert.equal(core.neighbors(j,'P9999:s1',{depth:1}).edges.length,1);assert.equal(core.neighbors(j,'P9999:s1',{depth:2}).edges.length,2);assert.equal(core.neighbors(j,'P9999:m2',{direction:'out',type:'cognate_with'}).edges.length,1);assert(core.neighbors(j,'P9999:s1',{depth:2,maxEdges:1}).truncated);
  });
  check('unsupported redirects explicitly rejected',()=>{const f=kit.fixture();f.p.homograph_groups=[];f.p.redirects=[{id:'P9999:d1',from_id:'P9999:t2',action:'deprecate',to_ids:['P9999:t1'],reason:'SYNTHETIC',evidence_ids:['P9999:e1']}];seal(f);assert.throws(()=>core.compile([f],{allowSynthetic:true}),/UNSUPPORTED_REDIRECT/);});
  check('controlled paths reject traversal, absolute outside root and link escapes',()=>{
    assert.throws(()=>ws.file(base,'../../../../records/anything'),/PATH_ESCAPE/);assert.throws(()=>ws.controlled(ws.PROJECT),/CONTROL_ROOT_REQUIRED/);assert.throws(()=>ws.claim('../P0001','test',{base}),/PACKET_ID_INVALID/);
    const evidence=require('./probe-path-links.cjs').probePathLinks(base);
    checks.push({name:'actual local-filesystem link rejection and workspace root isolation',ok:true,detail:evidence});
  });
  check('claim recovery owner protection, persistent returns limit and ID retention',()=>{
    const c=ws.claim('P0012','synthetic-owner',{base});assert.equal(c.returns,0);assert.equal(ws.claim('P0012','synthetic-owner',{base}).owner,'synthetic-owner');assert.throws(()=>ws.claim('P0012','other',{base}),/CLAIM_OWNED_BY_OTHER/);
    ws.atomic(base,'packets/P0012/packet.json',{synthetic:true,packet_id:'P0012',headwords:[{id:'P0012:h1'}]});ws.claim('P0012','synthetic-owner',{base});
    assert.equal(ws.claim('P0012','synthetic-owner',{base,rework:true}).returns,1);assert.equal(ws.claim('P0012','synthetic-owner',{base,rework:true}).returns,2);assert.throws(()=>ws.claim('P0012','synthetic-owner',{base,rework:true}),/REWORK_LIMIT/);
    ws.atomic(base,'packets/P0012/packet.json',{synthetic:true,packet_id:'P0012',headwords:[]});assert.throws(()=>ws.claim('P0012','synthetic-owner',{base}),/IDENTITY_REMOVAL/);
  });
  check('actual immutable build, same filesystem atomic switch, failure preserves old current',()=>{
    const a=kit.fixture(),b=renamed('P9998'), area=path.join(base,'build');const first=builder.build(['P9999'],{base:area,syntheticBundles:[a]});const old=ws.bytes(area,'current.json');
    assert(builder.build(['P9999','P9999'],{base:area,syntheticBundles:[a]}).idempotent);
    for(const failAt of ['after-write','before-switch']) {assert.throws(()=>builder.build(['P9998'],{base:area,syntheticBundles:[a,b],failAt}),/INJECTED_BUILD_FAILURE/);assert.equal(ws.bytes(area,'current.json').toString(),old.toString());assert.equal(builder.current(area).manifest.version,first.version);}
    const second=builder.build(['P9998'],{base:area,syntheticBundles:[b,a]});assert.notEqual(second.version,first.version);assert.equal(builder.snapshot(area,first.version).index.facts.length,1);assert.equal(ws.json(area,`history/${first.version}.json`).version,first.version);
    assert.equal(builder.rollback(first.version,{base:area}).version,first.version);assert.equal(builder.current(area).index.facts.length,1);assert.equal(builder.build(['P9998'],{base:area,syntheticBundles:[a,b]}).version,second.version);
    const bad=renamed('P9998');bad.p.relations[0].status='candidate';seal(bad);const pointer=ws.bytes(area,'current.json');assert.throws(()=>builder.build(['P9998'],{base:area,syntheticBundles:[a,bad]}));assert.equal(ws.bytes(area,'current.json').toString(),pointer.toString());
    ws.atomic(area,`versions/${second.version}/index.json`,'corrupt');assert.throws(()=>builder.current(area),/SNAPSHOT_HASH/);
  });
  const result={ok:errors.length===0,mode:'foundation-fast',synthetic:true,checks,errors,limits:['Machine checks declarations, bytes and known formal contradictions; it does not prove actual source truth, licensing, reviewer identity, undeclared homographs or linguistic correctness.'],artifact_dir:base};
  ws.atomic(base,'result.json',result);ws.atomic(base,'exit-code.json',{exit_code:result.ok?0:1});return result;
}
module.exports={runFast,seal,renamed,crossReference};
if(require.main===module){try{const r=runFast();process.stdout.write(JSON.stringify(r)+'\n');process.exitCode=r.ok?0:1;}catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}}
