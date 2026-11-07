'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const kit = require('../pipeline/root-universe/validate-kit.cjs');
const PROJECT = path.resolve(__dirname, '..');
const ROOT = path.join(PROJECT, 'build/root-universe');
const QA = path.join(PROJECT, 'build/qa/root-universe');
const PID = /^P\d{4}$/;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
function controlled(base = ROOT) {
  const abs = path.resolve(base);
  if (![ROOT, QA].some(r => abs === r || abs.startsWith(r + path.sep))) throw Error('CONTROL_ROOT_REQUIRED');
  kit.safeFile(PROJECT, path.relative(PROJECT, abs));
  return abs;
}
function file(base, rel) { return kit.safeFile(PROJECT, path.relative(PROJECT, kit.safeFile(controlled(base), rel))); }
function mkdir(base, rel = '.') { const dest=file(base,rel); fs.mkdirSync(dest,{recursive:true}); return dest; }
function bytes(base, rel) {
  const dest=file(base,rel), st=fs.statSync(dest);
  if (!st.isFile() || st.size > 16*1024*1024) throw Error('FILE_SIZE_OR_TYPE: '+rel);
  return fs.readFileSync(dest);
}
function json(base, rel) { return JSON.parse(bytes(base,rel)); }
function atomic(base, rel, value) {
  const dest=file(base,rel); mkdir(base,path.dirname(rel));
  const tmp=file(base,rel+'.tmp-'+crypto.randomUUID());
  try { fs.writeFileSync(tmp, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value,null,2)+'\n', {flag:'wx'}); fs.renameSync(tmp,dest); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function locked(base, name, action) {
  mkdir(base); const lock=file(base,name+'.lock'); let fd;
  try { fd=fs.openSync(lock,'wx'); } catch(e) { if(e.code==='EEXIST') throw Error('LOCK_HELD: '+name+'; inspect interrupted operation before manual removal'); throw e; }
  try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:now()})); return action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function task(id,base=ROOT) {
  if(!PID.test(id)) throw Error('PACKET_ID_INVALID');
  const errors=[];
  const t=kit.taskCheck(id,errors,{dependencyMerged:dep=>{try{return require('./build.cjs').current(base).index.packets.some(p=>p.packet_id===dep);}catch{return false;}}});
  if(errors.length){const e=Error('TASK_REGISTRY_INVALID');e.errors=errors;throw e;}
  if(t.foundation_output_dir!==`toefl-lab/build/root-universe/packets/${id}` || t.return_limit!==2) throw Error('FOUNDATION_TASK_PATH_OR_LIMIT');
  return t;
}
function claim(id, owner, {base=ROOT,rework=false,status}={}) {
  const t=task(id,base);
  if(status!==undefined&&!['in_progress','ready_for_review','blocked'].includes(status))throw Error('CLAIM_STATUS_INVALID');
  if(typeof owner!=='string' || !owner.trim() || owner.length>400) throw Error('OWNER_REQUIRED');
  return locked(base,'claims',()=>{
    const rel=`packets/${id}/claim.json`, dest=file(base,rel);
    let c=fs.existsSync(dest)?json(base,rel):null;
    if(c && c.owner!==owner) throw Error('CLAIM_OWNED_BY_OTHER');
    if(!c) {
      if(rework) throw Error('CLAIM_REQUIRED_BEFORE_REWORK');
      for(const dep of t.dependencies) {
        let merged=false;try{merged=require('./build.cjs').current(base).index.packets.some(p=>p.packet_id===dep);}catch{}
        if(!merged)throw Error('DEPENDENCY_PENDING: '+dep);
      }
      c={packet_id:id,owner,claimed_at:now(),returns:0,status:'in_progress',events:[],retained_ids:[]};
    }
    if(rework && c.returns>=t.return_limit) throw Error('REWORK_LIMIT');
    const packet=file(base,`packets/${id}/packet.json`);
    let hash=null, ids=[];
    if(fs.existsSync(packet)) {
      const raw=bytes(base,`packets/${id}/packet.json`), p=JSON.parse(raw); hash=kit.sha(raw);
      ids=kit.FIELDS.flatMap(k=>(p[k]||[]).filter(n=>n.record_role!=='reference').map(n=>n.id));
      if(c.retained_ids.some(x=>!ids.includes(x))) throw Error('IDENTITY_REMOVAL_REQUIRES_INTEGRATOR');
    }
    let archive=null;
    if(rework && hash) {
      archive=`packets/${id}/history/rework-${c.returns+1}-${hash}`;
      for(const name of ['packet.json','review.json','review.md','handoff.md','scope.json']) {
        const source=`packets/${id}/${name}`, target=`${archive}/${name}`;
        if(fs.existsSync(file(base,source))&&!fs.existsSync(file(base,target)))atomic(base,target,bytes(base,source));
      }
    }
    if(rework) c.returns++;
    c.retained_ids=[...new Set([...c.retained_ids,...ids])].sort();
    if(status)c.status=status;else if(rework)c.status='in_progress';
    c.events.push({kind:rework?'returned_for_rework':status|| (c.events.length?'resumed':'claimed'),at:now(),packet_sha256:hash,returns:c.returns,archive});
    atomic(base,rel,c); return c;
  });
}
function bundle(id, stage='verified', base=ROOT) {
  const t=task(id,base), rel=`packets/${id}`, raw=bytes(base,`${rel}/packet.json`), p=JSON.parse(raw);
  const claimRecord=json(base,`${rel}/claim.json`);
  if(claimRecord.packet_id!==id || !Array.isArray(p.authors) || !p.authors.includes(claimRecord.owner))throw Error('CLAIM_AUTHOR_MISMATCH');
  if(stage==='verified'&&claimRecord.status==='blocked')throw Error('CLAIM_BLOCKED');
  const reviewRaw=stage==='verified'?bytes(base,`${rel}/review.json`):null;
  const r=reviewRaw?JSON.parse(reviewRaw):null;
  bytes(base,`${rel}/handoff.md`); if(stage==='verified') bytes(base,`${rel}/review.md`);
  const schema=kit.loadSchema(), errors=[]; kit.schemaLint(schema,schema,errors);
  if(p.packet_id!==id) errors.push({code:'PACKET_DIRECTORY_ID'});
  errors.push(...kit.validatePacket(p,raw,r,stage,schema));
  if(!errors.some(e=>e.code.startsWith('SCHEMA_'))) {
    const scope=[...t.sense_scope.candidate_headwords,...(t.foundation_additional_headwords||[])];
    for(const h of p.headwords.filter(h=>h.record_role==='owned')) if(!scope.map(kit.normalized).includes(h.lookup_key)) errors.push({code:'TASK_SCOPE_EXTRA',id:h.id});
    for(const word of t.sense_scope.candidate_headwords) {
      const heads=p.headwords.filter(h=>h.lookup_key===kit.normalized(word) && (!t.foundation_require_course || h.course_member));
      if(!heads.some(h=>p.senses.some(s=>s.headword_id===h.id))) errors.push({code:'TASK_SCOPE_MISSING',word});
    }
    for(const e of p.evidence) if(!t.allowed_sources.some(s=>s.family===e.source_family)) errors.push({code:'TASK_SOURCE_FORBIDDEN',id:e.id});
  }
  if(errors.length) { const e=Error('PACKET_VALIDATION: '+id); e.errors=errors; throw e; }
  return {p,raw,r,reviewRaw,task:t};
}
module.exports={PROJECT,ROOT,QA,PID,now,controlled,file,mkdir,bytes,json,atomic,locked,task,claim,bundle};
