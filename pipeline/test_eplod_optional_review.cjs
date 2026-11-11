const assert=require('node:assert/strict');
const {test}=require('node:test');
const {coverProgress,mergeDrill}=require('../web/eplod-records.js');
const all=[0,1,2],third={'2026-11-01':all,'2026-11-02':all,'2026-11-03':all};
const progress=(stampDays,today='2026-11-10',more={})=>coverProgress({...more,stampDays},3,today);

test('three consecutive passes stay graduated and suggest third pass plus seven days',()=>{
  const p=progress(third,'2026-11-09');
  assert.equal(p.completed,3);assert.equal(p.extra,false);
  assert.equal(p.extraDue,'2026-11-10');assert.equal(p.extraToday,false);
  assert.equal(p.nextDue,null);assert.equal(p.dueToday,false);
  assert.equal(progress(third).extraToday,true);
});
test('optional review never becomes compulsory or removes stars when overdue',()=>{
  const p=progress(third,'2027-02-01');
  assert.equal(p.completed,3);assert.equal(p.extraToday,true);
  assert.equal(p.nextDue,null);assert.equal(p.dueToday,false);
});
test('partial and repeated sentences do not grant the fourth star',()=>{
  const p=progress({...third,'2026-11-10':[0,0,1,99,-1]});
  assert.equal(p.completed,3);assert.equal(p.extra,false);
  assert.equal(p.todayN,2);assert.equal(p.extraDue,'2026-11-10');
});
test('a fourth full day grants one extra star without changing graduation',()=>{
  const p=progress({...third,'2026-11-10':all});
  assert.equal(p.completed,3);assert.equal(p.extra,true);
  assert.equal(p.extraDate,'2026-11-10');assert.equal(p.extraDue,null);
  assert.equal(p.extraToday,false);assert.equal(p.todayStamped,true);
});
test('later practice keeps the fourth completion date and does not add another star',()=>{
  const p=progress({...third,'2026-11-10':all,'2026-11-17':all},'2026-11-17');
  assert.equal(p.completed,3);assert.equal(p.extra,true);
  assert.equal(p.extraDate,'2026-11-10');assert.equal(p.extraDue,null);
});
test('early optional practice remains allowed and one date only counts once',()=>{
  const p=progress({...third,'2026-11-04':all},'2026-11-04');
  assert.equal(p.extra,true);
  assert.equal(progress(third,'2026-11-03').extra,false);
});
test('historical recognition counts as a pass without inventing its date',()=>{
  const recoveredCover={sentences:all,recognizedAt:1};
  const p=progress({'2026-11-02':all,'2026-11-03':all},'2026-11-10',{recoveredCover});
  assert.equal(p.completed,3);assert.equal(p.extraDue,'2026-11-10');
  const fourth=progress({'2026-11-02':all,'2026-11-03':all,'2026-11-10':all},'2026-11-10',{recoveredCover});
  assert.equal(fourth.extra,true);assert.equal(fourth.extraDate,'2026-11-10');
  const unknown=progress({},'2026-11-10',{recoveredCover});
  assert.equal(unknown.extraDue,null);assert.equal(unknown.extraDate,null);
});
test('merging partial fourth passes preserves history and produces a full stamp',()=>{
  const a={stampDays:{...third,'2026-11-10':[0,1]}},b={stampDays:{'2026-11-10':[2]}};
  const before=JSON.stringify(a);
  const merged=mergeDrill(a,b);
  assert.equal(JSON.stringify(a),before);
  assert.deepEqual(merged.stampDays['2026-11-01'],all);
  assert.equal(coverProgress(merged,3,'2026-11-10').extra,true);
});
