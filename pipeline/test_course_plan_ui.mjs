import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../web/course-plan-ui.js',import.meta.url),'utf8');
function context(){const state={lessonId:'ndf-01-01',quiz:{course:'ndf-01',lessonNo:1,questions:[{id:'q1'},{id:'q2'}]},phase:'ready'};const ctx=vm.createContext({console,Date,AbortSignal,JSON,Math,crypto:globalThis.crypto,fetch:()=>{},GQ_UI:state,recAttQueue:[],recFlushAttempts(){},gqScrollToCard(){},gqRefreshList(){},renderGenQuiz(){},gqStart(order){state.planRound=null;state.planPhase=null;state.order=order;state.answers={};state.phase='quiz';},gqQid(q,qst){return 'gen/'+q.course+'/'+q.lessonNo+'/quiz/'+qst.id.slice(1);},esc:x=>String(x),courseFind:()=>null,$:()=>null});vm.runInContext(source,ctx);return {ctx,state,run:s=>vm.runInContext(s,ctx)};}
test('caption distinguishes scheduled first review and historical unknown date',()=>{const c=context();assert.match(c.run('cpCaption({stamps:[],due:Date.now()+86400000})'),/安排在/);assert.match(c.run('cpCaption({stamps:[{}],pendingHistorical:true})'),/历史已练/);});
test('resume uses only current round and phase plus durable local pending answers',()=>{const c=context();c.ctx.recAttQueue.push({id:'pending',planRound:'round',planPhase:'main',ref:{qid:'gen/ndf-01/1/quiz/1'},answer:'A',ok:true});c.run("cpResume({active:{id:'round',phase:'main',order:['q1','q2'],answers:{},step:'q1'}})");assert.equal(c.state.ix,1);assert.equal(c.state.answers.q1.letter,'A');assert.equal(c.state.planRound,'round');c.ctx.recAttQueue[0].planPhase='main';c.run("cpResume({active:{id:'round',phase:'correction',order:['q1','q2'],correctionOrder:['q1'],answers:{q1:{letter:'B',ok:false}},corrections:{},step:'q1'}})");assert.equal(c.state.ix,0);assert.equal(c.state.answers.q1,undefined);});
test('finish phase does not overwrite pending result state',()=>{const c=context();c.run("cpResume({active:{id:'round',phase:'finish',answers:{},order:['q1']}})");assert.equal(c.state.phase,'plan-finish');assert.equal(c.state.planRound,'round');});
test('persisted plan conflict updates snapshot without blocking normal answer queue',()=>{const c=context();c.run("CP.data={plans:{}};GQ_UI.planRound='round';cpAcceptAttempt({planRound:'round'},{plan:{lessonId:'ndf-01-01',active:null},planError:'内容已更新'})");assert.equal(c.state.planConflict,true);assert.equal(c.run("CP.data.plans['ndf-01-01'].active"),null);});
test('late advance response cannot switch another lesson into previous round',async()=>{const c=context();let resolve;c.ctx.fetch=()=>new Promise(r=>resolve=r);c.state.planRound='round';const pending=c.run('cpAdvance()');c.state.lessonId='cfcm-01-01';c.state.planRound=null;resolve({ok:true,json:async()=>({plans:{'ndf-01-01':{active:{id:'round',phase:'finish'}}},settings:{}})});await pending;assert.equal(c.state.lessonId,'cfcm-01-01');assert.equal(c.state.phase,'ready');assert.equal(c.state.planRound,null);});
test('catalog short names drop duplicated prefixes without inventing new meaning',()=>{
  const src=fs.readFileSync(new URL('../web/course-plan-ui.js',import.meta.url),'utf8');
  const m=src.match(/function shortLessonTitle\(title\)\{[\s\S]*?\n\}/);
  assert.ok(m,'shortLessonTitle present at shared top level');
  const ctx=vm.createContext({});vm.runInContext(m[0]+';this.short=shortLessonTitle;',ctx);
  const cases={
    '总概-托福词汇简介':'托福词汇简介',
    '托福词汇-词汇“三维度”及记忆法':'词汇三维度与记忆法',
    '总概-“记”几个词汇背诵的小提示':'背诵的几个小提示',
    '总概-“用”突破托福写作语言大关':'用词汇突破写作',
    '总概-“考”真题词汇＝考点词汇？':'真题词汇＝考点词汇？',
    '托福词汇-前缀之 “方向”系列':'前缀 · 方向',
    '托福词汇-后缀系列':'后缀系列',
    '基础词汇 · 词根 ceive':'基础 · ceive',
    '学科词汇系列-天文学':'学科 · 天文学',
    '第01课 · fix / cross / ride…':'fix / cross / ride…'
  };
  for(const [input,expected] of Object.entries(cases))assert.equal(ctx.short(input),expected,input);
});
test('courses whose titles already carry section numbers hide the duplicate sequence column',()=>{
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../web/desk.css',import.meta.url),'utf8');
  assert.match(html,/const noSeq=seqN>=Math\.ceil\(c\.lessons\.length\*\.6\)/);
  assert.match(html,/noSeq\?'':`<span class="no">/);
  assert.match(css,/\.cli\.vcli\.nono\{grid-template-columns:minmax\((?:0|\d+px),1fr\) auto\}/);
  const numbered=['1.听力导学','2.1 认识学术讲座','1.1 写作导学'].every(t=>/^\d+(?:\.\d+)?[.、\s]/.test(t));
  assert.ok(numbered);
});
test('managed mistakes stay outside automatic due batch and persisted conflict is acknowledged',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');assert.match(html,/if\(!r.ok&&!j.attemptSaved\)throw/);const batch=html.slice(html.indexOf('async function startDueReview('),html.indexOf('function reviewEntries('));assert.match(batch,/!cpManaged\(k\)/);assert.match(html,/cpAcceptAttempt\(item,j\)/);});
test('due prompt picks the first unsnoozed lesson and snooze is one day with pruning',()=>{const c=context();
  c.ctx.localStorage={store:{},getItem(k){return this.store[k]??null;},setItem(k,v){this.store[k]=String(v);},removeItem(k){delete this.store[k];},get length(){return Object.keys(this.store).length;},key(i){return Object.keys(this.store)[i]??null;}};
  assert.equal(c.run("cpDuePick(['a','b'],{},'2026-10-31')"),'a');
  assert.equal(c.run("cpDuePick(['a','b'],{a:'2026-10-31'},'2026-10-31')"),'b','snoozed lesson is skipped for the day');
  assert.equal(c.run("cpDuePick(['a'],{a:'2026-10-31'},'2026-11-01')"),'a','snooze expires the next day');
  assert.equal(c.run("cpDuePick([],{},'2026-10-31')"),null);
  c.run("CP.snooze={stale:'2020-01-01'};cpSnooze('a')");
  assert.equal(c.run("cpSnoozeLoad().a"),c.run("cpTodayKey()"));
  assert.equal(c.run("cpSnoozeLoad().stale"),undefined,'older snooze entries are pruned on write');
});
test('due badge reflects remaining recommendations and disappears when none',()=>{const c=context();
  const num={textContent:''};
  const bell={hidden:true,title:'',classList:{toggle(_c,v){this.on=v;}},querySelector:sel=>sel==='#cp-bell-n'?num:null};
  c.ctx.$=id=>id==='cp-bell'?bell:null;
  c.run("CP.data={recommendations:['a','b','c']};cpBadgeUpdate()");
  assert.equal(bell.hidden,false,'badge shows when recommendations remain');
  assert.equal(num.textContent,'3');
  c.run("CP.data={recommendations:[]};cpBadgeUpdate()");
  assert.equal(bell.hidden,true,'badge hides when nothing is due');
  c.run("CP.data={recommendations:['a','b','c','d','e','f','g','h','i','j']};cpBadgeUpdate()");
  assert.equal(num.textContent,'9+','count caps at 9+');
});
test('badge counts every due lesson beyond the daily recommendation and adds EnglishPod passes',()=>{const c=context();
  const num={textContent:''};
  const bell={hidden:true,title:'',classList:{on:false,toggle(_c,v){this.on=v;}},querySelector:sel=>sel==='#cp-bell-n'?num:null};
  c.ctx.$=id=>id==='cp-bell'?bell:null;
  const past=Date.now()-60000;
  c.run(`CP.data={recommendations:['a'],plans:{
    a:{lessonId:'a',complete:false,begun:true,due:${past}},
    b:{lessonId:'b',complete:false,begun:true,due:${past}},
    c:{lessonId:'c',complete:false,begun:true,due:${past}}}};cpBadgeUpdate()`);
  assert.equal(num.textContent,'3','three due lessons count even when the daily recommendation is one');
  assert.match(bell.title,/3 课课后练到期/);
  c.run(`courseById=()=>({lessons:[{id:'eplod-0001',dialogue_count:2},{id:'eplod-0002',dialogue_count:2}]});
    EplodRecords={coverProgress:(drill,total,today)=>drill.fake};
    REC={course:{'eplod-0001':{drill:{fake:{dueToday:true,completed:1,extraToday:false}}},
                  'eplod-0002':{drill:{fake:{dueToday:false,completed:3,extraToday:true}}}}};
    epDay=()=>'2026-11-13';cpBadgeUpdate()`);
  assert.equal(num.textContent,'4','red count only: plan 3 + EP due 1; optional fourth is excluded');
  assert.match(bell.title,/1 课覆盖背诵到期/);
  assert.match(bell.title,/另有 1 课可选第四遍（可选，不计入）/);
  assert.equal(bell.classList.on,true,'optional presence shows as an amber dot class');
  c.run("cpBadgeUpdate()");   // idempotent re-render keeps the same count
  assert.equal(num.textContent,'4');
});
test('a lone optional fourth pass never lights the badge',()=>{const c=context();
  const bell={hidden:true,title:'',classList:{on:false,toggle(_c,v){this.on=v;}},querySelector:()=>({textContent:''})};
  c.ctx.$=id=>id==='cp-bell'?bell:null;
  c.run(`courseById=()=>({lessons:[{id:'eplod-0002',dialogue_count:2}]});
    EplodRecords={coverProgress:(drill)=>drill.fake};
    REC={course:{'eplod-0002':{drill:{fake:{dueToday:false,completed:3,extraToday:true}}}}};
    CP.data={recommendations:[],plans:{}};epDay=()=>'2026-11-13';cpBadgeUpdate()`);
  assert.equal(bell.hidden,true,'optional only: badge stays hidden');
  assert.equal(bell.title,'','no must-do title either');
});
test('never-started lessons stay out of due counts and the review center even when overdue',()=>{const c=context();
  const num={textContent:''};
  const bell={hidden:true,title:'',classList:{toggle(_c,v){this.on=v;}},querySelector:sel=>sel==='#cp-bell-n'?num:null};
  c.ctx.$=id=>id==='cp-bell'?bell:null;
  const past=Date.now()-60000;
  /* 万词班 36 节误推回归(2026-11-13): 计划启用日给没学过的课也写了 due=启用日,
     徽标必须沿用服务端 begun 门槛, 否则未学过的万词班全部涌进提醒 */
  c.run(`CP.data={recommendations:[],plans:{
    fresh:{lessonId:'fresh',complete:false,begun:false,due:${past}},
    mistapped:{lessonId:'mistapped',complete:false,begun:false,active:{answers:{}},due:${past}}}};cpBadgeUpdate()`);
  assert.equal(bell.hidden,true,'unbegun plans are never due, even with a zero-answer round');
  c.run(`CP.data={recommendations:['started'],plans:{
    started:{lessonId:'started',complete:false,begun:true,due:${past}}}};cpBadgeUpdate()`);
  assert.equal(num.textContent,'1','begun and due lessons still count');
});
test('optional fourth pass shows in the badge but the popup only ever nudges scheduled passes',()=>{const c=context();
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const source=fs.readFileSync(new URL('../web/course-plan-ui.js',import.meta.url),'utf8');
  assert.match(source,/filter\(x=>x\.kind==='due'\)\s*;?\s*$/m,'popup pool filters out optional passes');
  assert.match(source,/snooze\['#eplod'\]!==day/,'EnglishPod popup is at most once per day');
  assert.match(source,/kind==='optional'\).*不限时|第四遍可选（不限时）/,'review center marks the fourth pass optional');
  assert.doesNotMatch(source,/cpDuePick\([^)]*kind/, 'popup pick never sees optional entries');
});
test('badge click opens the single due item directly and the review center for several',()=>{const c=context();
  let opened=[];c.ctx.nav=h=>opened.push(h);c.ctx.location={hash:''};
  c.run("courseById=()=>({lessons:[]});REC={course:{}};CP.data={recommendations:['a'],plans:{a:{lessonId:'a',complete:false,begun:true,due:Date.now()-1}}};cpBadgeGo()");
  assert.deepEqual(opened,['course/a'],'one due lesson opens it directly');
  opened=[];
  c.run("courseById=()=>({lessons:[{id:'eplod-0001',dialogue_count:2}]});EplodRecords={coverProgress:d=>d.fake};REC={course:{'eplod-0001':{drill:{fake:{dueToday:true,completed:1}}}}};CP.data={recommendations:[],plans:{}};cpBadgeGo()");
  assert.deepEqual(opened,['eplod/eplod-0001'],'single EnglishPod due opens the lesson');
  c.run("courseById=()=>({lessons:[{id:'eplod-0001',dialogue_count:2},{id:'eplod-0002',dialogue_count:2}]});REC={course:{'eplod-0001':{drill:{fake:{dueToday:true,completed:1}}},'eplod-0002':{drill:{fake:{dueToday:true,completed:1}}}}};cpBadgeGo()");
  assert.equal(c.ctx.location.hash,'#/course/review','several due items go to the review center via the router');
});
test('due reminder ships with badge markup, boot watch and hidden-safe styles',()=>{
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../web/desk.css',import.meta.url),'utf8');
  assert.match(html,/id="cp-bell"/);
  assert.match(html,/cpDueWatch\(\)/);
  assert.match(css,/\.cp-bell\[hidden\]\{display:none\}/,'display:flex must not defeat the hidden attribute');
  assert.match(css,/\.cp-due-mask/);
});
test('review center is organized by source and retires the old folded practice app',()=>{
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  assert.match(html,/data-t="review" aria-selected="false">复习中心</);
  assert.match(source,/按来源分区/);
  assert.match(source,/cpEplodSummary\(\)/,'EnglishPod coverage has its own section');
  assert.match(source,/cpExamCard\(\)/,'final exam card is part of the review center');
  assert.match(source,/data-exam-go/);
  assert.match(source,/错题与词根/);
  assert.match(source,/ndf-01.*cfcm-01|cpPlansOf\('ndf-01'\)/,'vocabulary plans are grouped separately');
  assert.doesNotMatch(source,/cp-old-review|import\('\/review\/app\.mjs'\)/,'old knowledge-point app is no longer mounted here');
});
test('direct lesson links return to the course tab, never the review tab',()=>{
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const branch=html.slice(html.indexOf("if(v==='course'&&arg)"),html.indexOf("if(v==='eplod')"));
  assert.match(branch,/csCourseTab='review'/,'review route still works');
  assert.match(branch,/csCourseTab='learn';/,'lesson route resets to the course tab');
  assert.ok(branch.indexOf("csCourseTab='learn';")>branch.indexOf("if(arg==='review')"),'reset applies to lesson links only');
});
