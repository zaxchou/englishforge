'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const ws=require('../../root-universe/workspace.cjs'),kit=require('./validate-kit.cjs');
const learning=require('../../root-universe/learning.cjs'),index=require('../../root-universe/build.cjs').current().index;
const out={ok:false,checks:[],errors:[]},stamp='learning-release-'+crypto.randomUUID(),base=ws.mkdir(ws.QA,stamp);
const raw=ws.bytes(ws.ROOT,'learning/dict/entry.json'),entry=JSON.parse(raw),reviewRaw=ws.bytes(ws.ROOT,'learning/dict/review.json'),review=JSON.parse(reviewRaw);
const test=(name,fn)=>{fn();out.checks.push(name);};
const bytes=e=>Buffer.from(JSON.stringify(e));
const reject=(mutate,pattern,reviewEdit)=>{const e=structuredClone(entry);mutate(e);const r=structuredClone(review),b=bytes(e);r.entry_sha256=kit.sha(b);if(reviewEdit)reviewEdit(r);assert.throws(()=>learning.validate(e,b,r,index),pattern);};
try{
 test('real existing review satisfies exact closure and bound identities',()=>learning.validate(entry,raw,review,index));
 test('extra approval rejected',()=>reject(()=>{},/CLOSURE/,r=>r.approved_ids.push('not-a-claim')));
 test('duplicate approval rejected',()=>reject(()=>{},/CLOSURE/,r=>r.approved_ids.push(r.approved_ids[0])));
 test('whitespace cannot bypass self-review',()=>reject(()=>{},/INDEPENDENT/,r=>r.reviewer=entry.author+' '));
 test('blank reviewer rejected',()=>reject(()=>{},/INDEPENDENT/,r=>r.reviewer=' '));
 test('blank review run rejected',()=>reject(()=>{},/INDEPENDENT/,r=>r.review_run_id=' '));
 test('wrong sense headword rejected',()=>reject(e=>e.words[0].sense_id='P0011:s0001',/WORD_BINDING/));
 test('duplicate learning identity rejected',()=>reject(e=>e.words[1].id=e.words[0].id,/WORD_ID/));
 test('alliance wrong sense rejected',()=>reject(e=>e.alliance.words.find(w=>w.word==='contradict').sense_id='P0001:s0001',/WORD_BINDING/));
 test('branch membership must agree in both directions',()=>reject(e=>e.alliance.branches[0].word_ids.pop(),/BRANCH_MEMBERS/));
 test('duplicate branch membership rejected',()=>reject(e=>e.alliance.branches[0].word_ids.push(e.alliance.branches[0].word_ids[0]),/BRANCH_MEMBERS/));
 test('source cannot reuse root identity',()=>reject(e=>{e.roots[0].id=e.sources[0].id;},/ID_COLLISION/));
 // Real signed source bytes, copied to an isolated fixture; no synthetic signatures are published.
 for(const s of entry.sources)if(!fs.existsSync(ws.file(base,s.snapshot)))ws.atomic(base,s.snapshot,ws.bytes(ws.ROOT,s.snapshot));
 test('first publication is immutable and readable',()=>{
   const r=learning.publish(index,{entryRaw:raw,reviewRaw,base});assert(r.changed);assert.equal(learning.query(index,'P0001:s0001',{base}).status,'reviewed');
 });
 const pointer=ws.bytes(base,'learning/dict/current.json');
 test('same-byte publication is a no-op',()=>assert.equal(learning.publish(index,{entryRaw:raw,reviewRaw,base}).changed,false));
 test('failed candidate cannot switch active content',()=>{
   const e=structuredClone(entry);e.changes=['unreviewed candidate'];assert.throws(()=>learning.publish(index,{entryRaw:bytes(e),reviewRaw,base}),/REVIEW_HASH/);
   assert(ws.bytes(base,'learning/dict/current.json').equals(pointer));
 });
 test('legacy working copy cannot take published content offline',()=>{
   ws.atomic(base,'learning/dict/entry.json',{...entry,changes:['unfinished draft']});
   ws.atomic(base,'learning/dict/review.json',review);
   const d=learning.query(index,'P0001:s0001',{base});assert.equal(d.status,'reviewed');assert.equal(d.version,kit.sha(raw));
 });
 test('published review bytes cannot be replaced in place',()=>{
   assert.throws(()=>learning.publish(index,{entryRaw:raw,reviewRaw:bytes({...review,notes:['altered review']}),base}),/IMMUTABLE/);
   assert(ws.bytes(base,'learning/dict/current.json').equals(pointer));
 });
 test('warm published reads do not reopen all source snapshots',()=>{
   const original=ws.bytes;let sourceReads=0;ws.bytes=(b,r)=>{if(entry.sources.some(s=>s.snapshot===r))sourceReads++;return original(b,r);};
   try{for(let i=0;i<4;i++)assert.equal(learning.query(index,'P0001:s0001',{base}).status,'reviewed');assert.equal(sourceReads,0);}finally{ws.bytes=original;}
 });
 out.ok=true;
}catch(e){out.errors.push(e.stack||e.message);}
finally{out.exit_code=out.ok?0:1;ws.atomic(base,'result.json',out);ws.atomic(base,'exit-code.json',{exit_code:out.exit_code});}
console.log(JSON.stringify({...out,evidence:base}));process.exitCode=out.exit_code;
