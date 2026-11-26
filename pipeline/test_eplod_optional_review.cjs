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
test('required reviews project both due dates from the first full stamp',()=>{
  const anchor='2026-11-01',today='2026-11-08',projected='2026-11-09';
  for(const [stamps,due] of [[{[anchor]:all},'2026-11-03'],[{[anchor]:all,'2026-11-04':all},'2026-11-07']]){
    const drill={stampDays:{...stamps,[today]:[0,0,1]}};
    const projectDay=(...args)=>{
      assert.deepEqual(args,[due,anchor,today]);
      return projected;
    };
    const p=coverProgress(drill,3,today,projectDay);
    assert.equal(p.nextDue,projected);assert.equal(p.dueToday,false);
    assert.deepEqual(p.dates,Object.keys(stamps));
    assert.equal(p.todayN,2);assert.equal(p.todayStamped,false);
    assert.equal(coverProgress(drill,3,projected,()=>projected).dueToday,true);
  }
});
test('optional review projects from the third pass and keeps the actual fourth stamp',()=>{
  const today='2026-11-10',projected='2026-11-12';
  const projectDay=(...args)=>{
    assert.deepEqual(args,[today,'2026-11-03',today]);
    return projected;
  };
  const p=coverProgress({stampDays:third},3,today,projectDay);
  assert.equal(p.completed,3);assert.equal(p.extraDue,projected);assert.equal(p.extraToday,false);
  assert.equal(coverProgress({stampDays:third},3,projected,()=>projected).extraToday,true);
  const fourth=coverProgress({stampDays:{...third,[today]:all}},3,today,()=>assert.fail('Fourth pass already stamped'));
  assert.equal(fourth.extraDate,today);assert.equal(fourth.extraDue,null);
  assert.equal(fourth.todayN,3);assert.equal(fourth.todayStamped,true);
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
  const unknown=coverProgress({recoveredCover},3,'2026-11-10',()=>assert.fail('Recovered pass has no stamp date'));
  assert.equal(unknown.nextDue,null);assert.equal(unknown.extraDue,null);assert.equal(unknown.extraDate,null);
});
test('merging partial fourth passes preserves history and produces a full stamp',()=>{
  const a={stampDays:{...third,'2026-11-10':[0,1]}},b={stampDays:{'2026-11-10':[2]}};
  const before=JSON.stringify(a);
  const merged=mergeDrill(a,b);
  assert.equal(JSON.stringify(a),before);
  assert.deepEqual(merged.stampDays['2026-11-01'],all);
  assert.equal(coverProgress(merged,3,'2026-11-10').extra,true);
});
