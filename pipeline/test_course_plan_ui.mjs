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
  const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
  const m=html.match(/function shortLessonTitle\(title\)\{[\s\S]*?\n\}/);
  assert.ok(m,'shortLessonTitle present');
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
test('managed mistakes stay outside automatic due batch and persisted conflict is acknowledged',()=>{const html=fs.readFileSync(new URL('../web/index.html',import.meta.url),'utf8');assert.match(html,/if\(!r.ok&&!j.attemptSaved\)throw/);const batch=html.slice(html.indexOf('async function startDueReview('),html.indexOf('function reviewEntries('));assert.match(batch,/!cpManaged\(k\)/);assert.match(html,/cpAcceptAttempt\(item,j\)/);});
