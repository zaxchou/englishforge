import fs from 'node:fs';import assert from 'node:assert/strict';import {summarize,selectRound,validateEvent} from '../web/review/model.mjs';
const bank=JSON.parse(fs.readFileSync(new URL('../web/review/bank.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../build/scripts-reviewed/ndf-01/19 核心词汇之词根ject.md',import.meta.url),'utf8');
for(const u of bank.units){assert.ok(source.includes(u.source.quote),u.id);for(const q of u.questions){assert.ok(q.prompt&&q.explain);if(q.kind==='choice'){assert.equal(new Set(q.options).size,3);assert.equal(q.options.filter(o=>o===q.answer).length,1);assert.ok(!q.prompt.includes(q.answer),q.id);}}}
const now=Date.UTC(2026,9,12),events=[];
for(let r=0;r<8;r++){const qs=selectRound(bank,events,now);assert.equal(qs.length,3);assert.equal(new Set(qs.map(q=>q.unit)).size,3);for(const q of qs)events.push(validateEvent(bank,{id:'cr-'+crypto.randomUUID(),version:bank.version,unit:q.unit,question:q.id,phase:'check',...(q.kind==='recall'?{rating:'good'}:{choice:q.answer})},now));}
assert.equal(summarize(bank,events,now).filter(u=>u.count).length,17);assert.ok(summarize(bank,events,now).every(u=>u.interval<=2));
const u=bank.units.find(u=>u.id==='reject'),q=u.questions[0];const input={id:'cr-'+crypto.randomUUID(),version:bank.version,unit:u.id,question:q.id,phase:'check',choice:q.answer};
assert.throws(()=>validateEvent(bank,{...input,choice:'fake'}));assert.throws(()=>validateEvent(bank,{...input,version:'old'}));assert.throws(()=>validateEvent(bank,{...input,question:'fake'}));
const helped=validateEvent(bank,{...input,phase:'supplement'},now);assert.equal(summarize(bank,[helped],now).find(u=>u.id==='reject').interval,1);
console.log('17 provenance units, 34 question structures, rotation coverage, same-day spacing, supplement spacing and event validation passed');
