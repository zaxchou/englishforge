'use strict';
// Lesson 1 (cfcm-01) alliance: 13 classroom branches, 16 root identities, 176 words.
// Sources: 21 Wiktionary snapshots (one per root identity + in-group split words); candidate until independently reviewed.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const {englishEtymology}=require('./source-english.cjs');
const scopePath='build/qa/root-universe/review-20261107/cfcm-01-classroom-scope.json';
const scopeRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,scopePath));
const scope=JSON.parse(scopeRaw);
const courseRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,'build/vocab/cfcm-words.json'));
const course=JSON.parse(courseRaw),courseIndex=new Map();
for(const b of course.batches||[])for(const w of b.words||[])courseIndex.set(String(w.w).toLowerCase(),{lesson:w.lesson,ipa:w.ipa||'',def:w.def||'',sen:w.sen||'',senZh:w.senZh||''});
const caps=ws.json(ws.ROOT,'learning/alliance-captures.json');
const captureFor=Object.fromEntries(caps.map(c=>[c.title,c]));
const sources=[];const sourceIds=[];
function addSource(title){
 let s=sources.find(x=>x.entry===title);
 if(s)return s.id;
 const c=captureFor[title];if(!c)throw Error('NO_CAPTURE '+title);
 const snapshot=c.path.replace('build/root-universe/','');
 const bytes=ws.bytes(ws.ROOT,snapshot),rev=JSON.parse(bytes).query.pages[0].revisions[0];
 const text=rev.slots.main.content;
 const excerpt=englishEtymology(text,title);
 if(!text.includes(excerpt))throw Error('EXCERPT_BUILD '+title);
 const id='E'+title;
 sources.push({id,entry:title,snapshot,snapshot_sha256:kit.sha(bytes),revision:rev.revid,url:'https://en.wiktionary.org/w/index.php?title='+encodeURIComponent(title)+'&oldid='+rev.revid,excerpt,excerpt_sha256:kit.sha(Buffer.from(excerpt)),license:'CC-BY-SA-4.0',attribution:'English Wiktionary contributors',retrieved_at:c.retrieved_at});
 sourceIds.push(id);return id;
}
// One verbatim excerpt per source (auto-extracted English etymology paragraph head).
for(const t of ['fix','cross','road','ready','errand','err','ridicule','read','riddle','ratio','reason','sect','sex','saw','word','verb','tell','talk','tail','detail'])addSource(t);
const S=(...t)=>t.map(addSource);
// ---- Root identities (16) ----
const roots=[
 {id:'Rfix',label:'fix「固定」',meaning:'钉住；固定',origin:'拉丁 fīgō「钉住」→ fīxus「固定的」→ 古法语 → 英语 fix',forms_note:'fix 是现代英语基词；affix/prefix/suffix/transfix/crucifix 是拉丁介词+figere 的直接派生。印欧更早形式 *dʰeygʷ-「刺、钉」。',source_ids:S('fix')},
 {id:'Rcross',label:'cross「十字」',meaning:'交叉；十字',origin:'拉丁 crux「十字架」→ 古爱尔兰 cros → 古诺斯 kross → 古英语 cros → 英语 cross',forms_note:'cross 是日耳曼化的拉丁词；crucial/crucify/crux 等直接来自拉丁 crux，与 cross 同根。',source_ids:S('cross')},
 {id:'Rride',label:'ride「骑」',meaning:'骑；乘',origin:'古英语 rīdan「骑」← 印欧 *reydʰ-「骑」',forms_note:'road（rād「骑乘之旅」）与 raid 是 ride 的同源对词；override 等为现代复合。',source_ids:S('road')},
 {id:'Rready',label:'ready「准备好的」',meaning:'准备就绪',origin:'古英语 rǣde/ġerǣde「准备好的、备好骑乘的」← 日耳曼 *garaidijaz',forms_note:'ready 与 ride 同出印欧骑乘义（来源记载为可能融合），但现代是两条独立线索，分组记忆时分开记。',source_ids:S('ready')},
 {id:'Rerrand',label:'errand「差事」',meaning:'差事；跑腿',origin:'古英语 ǣrende「信息、差事」← 日耳曼 *ārundī「口信」',forms_note:'errand 与 err「犯错」来源无关，课堂上因拼形相邻。',source_ids:S('errand')},
 {id:'Rerr',label:'err「犯错」',meaning:'漫游；迷失；犯错',origin:'拉丁 errō「漫游、迷路、犯错」← 印欧 *h₁ers-',forms_note:'error/erratic/erroneous/errant/aberration 均为拉丁 errāre 词族；arrant 是 errant 的变体。',source_ids:S('err')},
 {id:'Rridere',label:'rīdēre「笑」',meaning:'笑；嘲笑',origin:'拉丁 rīdere「笑」→ rīdiculus「可笑的」→ ridicule / ridiculous / risible',forms_note:'rid 组虽以 rid 开头，但全部词来自拉丁 rīdere「笑」一脉。',source_ids:S('ridicule')},
 {id:'Rread',label:'read「读」',meaning:'阅读；解读',origin:'古英语 rǣdan「解读、建议」← 日耳曼 *rēdaną「建议」← 印欧 *Hreh₁dʰ-「整理」',forms_note:'西日耳曼语里该动词有「解读」义，英语发展为「解读文字」→ 阅读；riddle（谜）来自同根 rǣdels。',source_ids:S('read')},
 {id:'Rratio',label:'ratio「计算；理性」',meaning:'计算；比率；理性',origin:'拉丁 ratiō「计算、理性」← ratus ← reor「计算」← 印欧 *h₂reh₁-「思考」',forms_note:'rat 组与 reason 组同根：reason 经古法语 raison ← ratiō；ratio/ration/rational 直接借自拉丁。',source_ids:S('reason')},
 {id:'Rsect',label:'sect「宗派」',meaning:'切割出的群体；宗派',origin:'拉丁 secta「学派、宗派」；来源有两说：sequi「跟随」或 secō「切分」（快照原文保留两说）',forms_note:'section/sector/segment/dissect/insect/intersect 等按传统分析走 secō「切」一脉；secta 本身来源存两说，快照如实披露。',source_ids:S('sect')},
 {id:'Rsex',label:'sex「性别」',meaning:'性别；区分',origin:'拉丁 sexus「性别」← 印欧 *sek-「切」→「分成两半」→ 男女之分',forms_note:'sex 与 saw「锯」同出印欧 *sek-「切」，是远缘同源。',source_ids:S('sex')},
 {id:'Rsaw',label:'saw「锯」',meaning:'切割工具；锯',origin:'古英语 sagu「锯」← 日耳曼 *sagô ← 印欧 *sek-「切」（与拉丁 secō 同根）',forms_note:'saw/jigsaw/chainsaw/sawmill/seesaw 为日耳曼本土词；与拉丁 secare 词族远缘同源。',source_ids:S('saw')},
 {id:'Rword',label:'word「词」',meaning:'词；话语',origin:'古英语 word ← 日耳曼 *wurdą ← 印欧 *werdʰom ← *werh₁-「说」',forms_note:'拉丁 verbum「词」是 word 的同源对词（doublet）：proverb/verbal/verbatim 等是 verbum 直接派生，与 word 同根异途。',source_ids:S('word')},
 {id:'Rtell',label:'tell「数；讲」',meaning:'数；讲述；告诉',origin:'古英语 tellan「数、讲」← 日耳曼 *taljaną ← *talō「数」← 印欧 *dol-',forms_note:'talk 是 tell 的日耳曼反复动词形式（*talkōną），同根；tale 同源。',source_ids:S('tell')},
 {id:'Rtaila',label:'tailler「切」',meaning:'切；裁',origin:'古法语 taillier「切」← 拉丁 talea「切条」（detail 快照证实 detaillier = de- + taillier）',forms_note:'detail/retail/curtail/entail/tailor/tally 是「切」一脉：刻签计数、裁衣、分割。',source_ids:S('detail'),earlier_note:'taillier ← 拉丁 talea「切条」以及 retail/entail/curtail 的具体切分义属词典共识，当前快照（detail）只直证 de- + taillier「切」；已核范围以快照为准。'},
 {id:'Rtael',label:'tail「尾巴」',meaning:'尾巴；末端',origin:'古英语 tæġel「尾巴」← 日耳曼 *taglą「尾毛」← 印欧 *doḱ-「尾毛」',forms_note:'tail「尾巴」与 tailler「切」来源不同（日耳曼 vs 拉丁），cocktail/ponytail 走尾巴义。',source_ids:S('tail')}
];
// ---- Branch + word table: [word, rootId|null, clue] (rootId null = classroom contrast) ----
const table=[
 ['B1',null,'固定 · fix 词族（13）',[
  ['fix','Rfix','fix「钉住；固定」→ 维修；固定；安装'],
  ['fixed','Rfix','fix + -ed「被…的」→ 固定的，不变的'],
  ['fixer','Rfix','fix + -er「做…的人/物」→ 操纵者；定影剂'],
  ['fixing','Rfix','fix 的动名词 → 固定，修理；（美式）配菜'],
  ['fixity','Rfix','fix + -ity「性质」→ 固定性，不变性'],
  ['fixture','Rfix','fix + -ture「物」→ 固定设备；预定日期'],
  ['affix','Rfix','af-「向、贴」+ fix → 粘上，贴上；词缀'],
  ['prefix','Rfix','pre-「前」+ fix → 前缀；加前缀'],
  ['suffix','Rfix','suf-「后」+ fix → 后缀；加后缀'],
  ['transfix','Rfix','trans-「穿透」+ fix → 刺穿；（使震惊）呆住'],
  ['crucifix','Rfix','cruci「十字」+ fix → 耶稣受难十字架'],
  ['fixated','Rfix','fix + -ate「使…」+ -ed → 过分沉迷于…的（on）'],
  ['fixation','Rfix','fix + -ation「行为/状态」→ 专注，迷恋'],
 ]],
 ['B2',null,'交叉 · cross 词族（26）',[
  ['cross','Rcross','cross「十字」→ 穿过；使交叉；n. 十字架'],
  ['across','Rcross','a-「在」+ cross → 穿过，横跨；在对面'],
  ['cross-border','Rcross','cross + border「边界」→ 跨境的'],
  ['crossbow','Rcross','cross + bow「弓」→ 弩，十字弓'],
  ['crossbreed','Rcross','cross + breed「繁殖」→ 杂交品种；（使）杂交'],
  ['crosscheck','Rcross','cross + check「核对」→ 交叉核对'],
  ['cross-country','Rcross','cross + country「乡野」→ 越野的；横跨全国的'],
  ['cross-cultural','Rcross','cross + cultural「文化的」→ 跨文化的'],
  ['cross-examine','Rcross','cross + examine「盘问」→ 盘问，诘问（证人）'],
  ['crossfire','Rcross','cross + fire「火力」→ 交叉火力；来自多方的批评'],
  ['crossing','Rcross','cross 的动名词 → 横穿；交叉口；渡口'],
  ['cross-legged','Rcross','cross + legged「腿的」→ 盘腿的（地）'],
  ['crossover','Rcross','cross + over → 交叉，转变；跨界作品'],
  ['crossroads','Rcross','cross + roads → 十字路口；重大抉择关头'],
  ['cross-section','Rcross','cross + section「截面」→ 横截面；典型样本'],
  ['cross-sectional','Rcross','cross-section + -al → 横截面的；代表性的'],
  ['crosstalk','Rcross','cross + talk「话」→ 串扰；机智的对答'],
  ['crosswise','Rcross','cross + -wise「方向」→ 横向的（地），成十字状'],
  ['crossword','Rcross','cross + word「词」→ 纵横填字游戏'],
  ['crucial','Rcross','cruc「十字」（拉丁 crux）+ -ial → 至关重要的，决定性的'],
  ['crucify','Rcross','cruc「十字」+ -ify「使」→ 钉在十字架上；折磨迫害'],
  ['cruise','Rcross','cruc/cruis「十字（航线）」→ 巡航；乘船游览'],
  ['cruiser','Rcross','cruise + -er → 巡洋舰；游艇；巡逻车'],
  ['crusade','Rcross','crus「十字」（十字军）+ -ade → 十字军东征；改革运动'],
  ['crux','Rcross','拉丁 crux「十字」→ 问题的关键，症结'],
  ['excruciating','Rcross','ex-「出」+ cruc「十字（钉刑）」+ -ating → 极其痛苦的'],
 ]],
 ['B3',null,'骑乘 · ride 词族（14）',[
  ['ride','Rride','ride「骑」→ 骑（马/车）；乘坐'],
  ['rider','Rride','ride + -er → 骑手；乘车者；（法律）附加条款'],
  ['riding','Rride','ride 的动名词 → 骑马（运动）；（加拿大）选区'],
  ['road','Rride','rād「骑乘之旅」→ 路，道路；途径'],
  ['raid','Rride','road 的同源对词（经苏格兰英语）→ 突袭；搜查'],
  ['raider','Rride','raid + -er → 袭击者；突袭者'],
  ['override','Rride','over-「在上」+ ride「骑」→ 骑在…之上 → 推翻，否决；凌驾'],
  ['overriding','Rride','override 的形容词 → 最重要的，压倒一切的'],
  ['ready','Rready','rǣde「备好的（原义备好骑乘）」→ 准备好的；乐意的'],
  ['already','Rready','all + ready → 已经；早已'],
  ['readily','Rready','ready + -ly → 乐意地；容易地，迅速地'],
  ['readiness','Rready','ready + -ness「状态」→ 准备就绪；愿意'],
  ['ready-made','Rready','ready + made「做好的」→ 现成的，预制的'],
  ['errand','Rerrand','ǣrende「口信、差事」→ 差事，跑腿；使命'],
 ]],
 ['B4',null,'漫游与犯错 · err 词族（9）',[
  ['err','Rerr','拉丁 errāre「漫游、迷路」→ 犯错，出错'],
  ['error','Rerr','err 的名词 → 错误，差错；过失'],
  ['erratic','Rerr','err「游移」+ -atic → 不稳定的；古怪的'],
  ['erroneous','Rerr','error + -eous → 错误的，不正确的'],
  ['erroneously','Rerr','erroneous + -ly → 错误地'],
  ['unerring','Rerr','un-「不」+ err「犯错」+ -ing → 准确无误的，万无一失的'],
  ['errant','Rerr','err「游荡」+ -ant → 行为出格的；游荡的'],
  ['arrant','Rerr','errant 的变体 → 彻头彻尾的（贬义）'],
  ['aberration','Rerr','ab-「离开」+ err「漫游、偏离正路」+ -ation → 偏离，反常；光学像差'],
 ]],
 ['B5',null,'嘲笑 · rīdēre 词族（8）',[
  ['ridicule','Rridere','拉丁 rīdēre「笑」→ 嘲笑，奚落；n. 嘲笑'],
  ['ridiculous','Rridere','rīdiculus「可笑的」→ 荒谬的，可笑的'],
  ['ridiculously','Rridere','ridiculous + -ly → 荒谬地'],
  ['deride','Rridere','de-「向下」+ ride（rīdēre「笑」）→ 嘲笑，讥讽'],
  ['derision','Rridere','deride 的名词 → 嘲笑，嘲弄'],
  ['derisive','Rridere','derision + -ive → 嘲笑的，讥讽的'],
  ['derisory','Rridere','derision + -ory → 可笑的；少得荒谬的'],
  ['risible','Rridere','rīdēre「笑」+ -ible → 可笑的，引人发笑的'],
 ]],
 ['B6',null,'阅读 · read 词族（10）',[
  ['read','Rread','rǣdan「解读」→ 阅读，朗读；读懂；显示（读数）'],
  ['reading','Rread','read 的动名词 → 阅读；读物；解读；读数'],
  ['readable','Rread','read + -able → 可读的，易读的'],
  ['unreadabl','Rread','un-「不」+ readable → 不可读的（课程原形如此，全称 unreadable）'],
  ['reader','Rread','read + -er → 读者；读本；阅读器'],
  ['readership','Rread','reader + -ship → 读者人数，读者群体'],
  ['readout','Rread','read + out → 读数，数据显示'],
  ['misread','Rread','mis-「错」+ read → 读错，误读'],
  ['proofread','Rread','proof「校样」+ read → 校对'],
  ['riddle','Rread','rǣdels「谜」（同根 rǣdan「解读」）→ 谜语；费解之事'],
 ]],
 ['B7',null,'理性与计算 · ratio 词族 · 理由（6）',[
  ['reason','Rratio','拉丁 ratiō「计算、理性」→ 理由，原因；理性；推理'],
  ['reasonable','Rratio','reason + -able → 合理的；通情达理的'],
  ['reasonably','Rratio','reasonable + -ly → 合理地；相当地'],
  ['unreasonable','Rratio','un-「不」+ reasonable → 不合理的，过分的'],
  ['reasoned','Rratio','reason 的过去分词 → 经过深思熟虑的'],
  ['reasoning','Rratio','reason 的动名词 → 推理，论证；逻辑思考'],
 ]],
 ['B8',null,'理性与计算 · ratio 词族 · 估量（15）',[
  ['ratio','Rratio','拉丁 ratiō「计算」→ 比率，比例'],
  ['rate','Rratio','rata「固定的（份额）」→ 比率；速度；价格；v. 评价'],
  ['rating','Rratio','rate + -ing → 等级，评分；收视率'],
  ['ratify','Rratio','rat「核定」（ratus）+ -ify「使」→ 正式批准'],
  ['ratification','Rratio','ratify + -ication → 批准，认可'],
  ['ration','Rratio','ratio「配给的份额」→ 定量，配给量；v. 限量供应'],
  ['rational','Rratio','ratio「计算；理性」+ -al → 理性的；合理的'],
  ['rationalized','Rratio','rational + -ize「使」的过去分词 → 使合理化的'],
  ['irrational','Rratio','ir-「不」+ rational → 不合理的；无理性的'],
  ['irrationality','Rratio','irrational + -ity → 不合理；无理性'],
  ['rationale','Rratio','拉丁 rationale「计算依据」→ 基本原理，逻辑依据'],
  ['first-rate','Rratio','first + rate「等级」→ 第一流的'],
  ['second-rate','Rratio','second + rate → 二流的，平庸的'],
  ['overrated','Rratio','over-「过度」+ rate「评价」的过去分词 → 被高估的'],
  ['underrated','Rratio','under-「不足」+ rate → 被低估的'],
 ]],
 ['B9',null,'切割 · sect 词族（21）',[
  ['sect','Rsect','拉丁 secta「宗派」（一说 secō「切分」）→ 宗派，教派'],
  ['sectarian','Rsect','sect + -arian → 宗派的；偏狭的'],
  ['sectarianism','Rsect','sectarian + -ism → 宗派主义'],
  ['section','Rsect','secō「切」+ -tion → 部分，片段；截面；部门'],
  ['sectional','Rsect','section + -al → 部分的；截面图的'],
  ['sector','Rsect','sect「切出的块」+ -or → 行业，领域；扇形'],
  ['segment','Rsect','secāre 词干「切」+ -ment「物」→ 段，节；v. 分割'],
  ['bisect','Rsect','bi-「二」+ sect「切」→ 二等分，平分'],
  ['dissect','Rsect','dis-「分开」+ sect「切」→ 解剖；仔细剖析'],
  ['dissection','Rsect','dissect + -ion → 解剖；剖析'],
  ['insect','Rsect','in-「进入」+ sect「切」（切开的分节小虫）→ 昆虫'],
  ['insecticide','Rsect','insect + -i- + cide「杀」→ 杀虫剂'],
  ['insectivore','Rsect','insect + -vore「食…的」→ 食虫动物'],
  ['intersect','Rsect','inter-「相互」+ sect「切」→ 相交，交叉'],
  ['intersection','Rsect','intersect + -ion → 交叉点；交集'],
  ['saw','Rsaw','sagu「锯」（印欧 *sek-「切」，与拉丁 secō 同根）→ 锯子；v. 锯'],
  ['sawdust','Rsaw','saw + dust「屑」→ 锯末'],
  ['jigsaw','Rsaw','jig + saw → 拼图游戏；竖锯'],
  ['chainsaw','Rsaw','chain「链」+ saw → 链锯'],
  ['sawmill','Rsaw','saw + mill「磨坊」→ 锯木厂'],
  ['seesaw','Rsaw','see-saw 叠词（模仿锯的动作）→ 跷跷板；摇摆'],
 ]],
 ['B10',null,'性别 · sex 词族（13）',[
  ['sex','Rsex','sexus「性别」（印欧 *sek-「切」→ 男女之分）→ 性别；性'],
  ['sexual','Rsex','sex + -ual → 性的；性别的'],
  ['sexually','Rsex','sexual + -ly → 性方面地'],
  ['sexy','Rsex','sex + -y → 性感的；有魅力的'],
  ['sexuality','Rsex','sexual + -ity → 性取向；性特征'],
  ['sexism','Rsex','sex + -ism「主义」→ 性别歧视'],
  ['sexist','Rsex','sex + -ist → 性别歧视的；n. 歧视者'],
  ['asexual','Rsex','a-「无」+ sexual → 无性的；无性繁殖的'],
  ['bisexual','Rsex','bi-「双」+ sexual → 双性恋的'],
  ['homosexual','Rsex','homo「同」+ sexual → 同性恋的'],
  ['homosexuality','Rsex','homosexual + -ity → 同性恋'],
  ['heterosexual','Rsex','hetero「异」+ sexual → 异性恋的'],
  ['same-sex','Rsex','same「同」+ sex → 同性别的'],
 ]],
 ['B11',null,'词与说 · word 词族（20）',[
  ['word','Rword','word「词」→ 单词；话语；承诺；v. 措辞'],
  ['wording','Rword','word + -ing → 措辞，用词'],
  ['password','Rword','pass「通过」+ word → 口令，密码'],
  ['keyword','Rword','key（课堂对照：钥匙）+ word → 关键词'],
  ['buzzword','Rword','buzz（课堂对照：拟声嗡嗡）+ word → 流行术语'],
  ['proverb','Rword','pro-「公开」+ verb「词」（拉丁 verbum，与 word 同根）→ 谚语，格言'],
  ['proverbial','Rword','proverb + -ial → 谚语的；众所周知的'],
  ['verb','Rword','拉丁 verbum「词」（word 的同源对词）→ 动词'],
  ['verbal','Rword','verb + -al → 口头的；词语的；动词的'],
  ['verbally','Rword','verbal + -ly → 口头地'],
  ['nonverbal','Rword','non-「非」+ verbal → 非语言的'],
  ['verbatim','Rword','verbum「词」+ -atim「逐」→ 逐字的，一字不差的'],
  ['verbiage','Rword','verbum「词」+ -age → 冗词，废话'],
  ['verbose','Rword','verb + -ose「多…的」→ 冗长的，啰嗦的'],
  ['adverb','Rword','ad-「附加在」+ verb → 副词'],
  ['key',null,'课堂对照：key「钥匙、关键」古英语 cæg，与 word 词源无关'],
  ['low-key',null,'课堂对照：low「低」+ key → 低调的（key 来源与 word 无关）'],
  ['buzz',null,'课堂对照：拟声词「嗡嗡」，与词根无关'],
  ['reverberate',null,'课堂对照：拉丁 reverberare「反弹」，词中 verb 字形与 verbum「词」无关'],
 ]],
 ['B12',null,'讲述 · tell 词族（8）',[
  ['tell','Rtell','tellan「数、讲」→ 告诉；讲述；辨别；命令'],
  ['tale','Rtell','tell 的同源名词 → 故事，传说'],
  ['teller','Rtell','tell + -er → 讲述者；出纳员；计票员'],
  ['telling','Rtell','tell 的形容词 → 有效的；说明问题的'],
  ['telltale','Rtell','tell + tale「讲出的事」→ 泄露内情的；迹象'],
  ['talk','Rtell','tell 的日耳曼反复动词（*talkōną）→ 说话，谈话；演讲'],
  ['foretell','Rtell','fore-「预先」+ tell → 预言，预测'],
  ['retell','Rtell','re-「再」+ tell → 复述'],
 ]],
 ['B13',null,'切与尾巴 · tail 词族（14）',[
  ['tally','Rtaila','taillier「切」→ 切痕木签计数 → 计数，记录；得分'],
  ['detail','Rtaila','de-「分」+ tail「切」（taillier）→ 细节；v. 详述'],
  ['detailed','Rtaila','detail + -ed → 详细的'],
  ['entail','Rtaila','en-「使」+ tail「切定」→ 使必要；牵涉；限定继承'],
  ['retail','Rtaila','re-「再」+ tail「切」→ 切成小块卖 → 零售'],
  ['retailer','Rtaila','retail + -er → 零售商'],
  ['retailing','Rtaila','retail 的动名词 → 零售业'],
  ['curtail','Rtaila','cur-（拉丁 curtus「短的」）+ tail「切」→ 削减，缩减'],
  ['tailor','Rtaila','taillier「裁衣」→ 裁缝；v. 裁制；调整'],
  ['tailored','Rtaila','tailor + -ed → 定制的；专门的'],
  ['tail','Rtael','tæġel「尾巴」→ 尾巴；末端；v. 跟踪'],
  ['tailback','Rtael','tail + back → 拥堵的车队；（橄榄球）后卫'],
  ['cocktail','Rtael','cock「鸡」+ tail「尾」→ 鸡尾酒；混合物'],
  ['ponytail','Rtael','pony「马驹」+ tail → 马尾辫'],
 ]]
];
// classroom (null root) words still need parts/trace; close words get root trace.
const branchDefs=[],wordRows=[];const seen=new Set();
for(const [branchId,_unused,idea,rows2] of table){
 const title=rows2&&table?null:null;
}
for(const [branchId,rootOfBranch,idea,rows2] of table){
 for(const [word,rootId,clue] of rows2){
  if(seen.has(word))continue;seen.add(word);
  wordRows.push({word,rootId,clue,branch:branchId});
 }
}
const branchTitles={'B1':'固定 · fix 词族','B2':'交叉 · cross 词族','B3':'骑乘 · ride / ready / errand','B4':'漫游与犯错 · err 词族','B5':'嘲笑 · rīdēre 词族','B6':'阅读 · read 词族','B7':'理性与计算 · ratio（理由）','B8':'理性与计算 · ratio（估量）','B9':'切割 · sect / saw 词族','B10':'性别 · sex 词族','B11':'词与说 · word 词族','B12':'讲述 · tell 词族','B13':'切与尾巴 · tail 词族'};
for(const [branchId,,idea] of table){
 const ws2=wordRows.filter(w=>w.branch===branchId);
 const srcSet=[...new Set(ws2.flatMap(w=>w.rootId?roots.find(r=>r.id===w.rootId).source_ids:[]))];
 branchDefs.push({id:branchId,title:branchTitles[branchId],idea,source_ids:srcSet.length?srcSet:['Efix'],word_ids:ws2.map(w=>'A'+w.word)});
}
// Build learning words.
const words=[];
for(const w of wordRows){
 const c=courseIndex.get(w.word.toLowerCase());if(!c)throw Error('COURSE_MISSING '+w.word);
 const root=w.rootId?roots.find(r=>r.id===w.rootId):null;
 const rootLabel=root?root.label:w.word;
 const defClean=c.def.replace(/^[avnadjrpreppronconjuninternum]+\.\s*/i,'').split(/[;；]/)[0].trim()
  // Prompts must not leak the answer: strip any parenthetical or fragment containing English letters.
  .replace(/（[^）]*[A-Za-z][^）]*）/g,'').replace(/\([^)]*[A-Za-z][^)]*\)/g,'').replace(/，[^，]*[A-Za-z][^，]*$/,'');
 const isOriginalCourse=!!(c.sen&&c.senZh);
 words.push({
  id:'A'+w.word,word:w.word,query_id:`Lcfcm01:${w.word.toLowerCase()}`,meaning:c.def,root_ids:root?[root.id]:[],relation_kind:root?'close':'classroom',lesson:1,
  parts:root?[{label:rootLabel.replace(/「.*$/,''),role:'root',root_id:root.id,meaning:root.meaning,source_ids:root.source_ids}]:[{label:w.word,role:'base',meaning:defClean.slice(0,16)||'课堂对照词',source_ids:root?root.source_ids:['Efix']}],
  modern_formula:w.rootId?`${w.word} = ${rootLabel.replace(/「.*$/,'')} 词族成员`:`${w.word}（课堂对照词，不归入词根拆解）`,
  explanation:w.clue,
  trace:w.rootId?[
   {label:w.word,kind:'word',meaning:defClean||c.def,source_ids:root.source_ids},
   {label:rootLabel,kind:'root',meaning:root.meaning,root_id:root.id,source_ids:root.source_ids}
  ]:[{label:w.word,kind:'word',meaning:defClean||c.def,source_ids:['Efix']}],
  source_ids:root?root.source_ids:['Efix'],
  example:isOriginalCourse?{en:c.sen,zh:c.senZh,kind:'course'}:null,
  caveat:w.rootId?null:'本条为课堂记忆条目：构词线索为作者整理，引用词根代表词的已核快照；逐词独立来源待后续复核。',
  recall:{prompt:`「${defClean.slice(0,22)||c.def.slice(0,22)}」用哪个英文单词？`,answer:w.word,explanation:`${w.word}：${w.clue}`}
 });
}
// Alliance assembly.
const byBranch=new Map();
for(const w of words){(byBranch[w.lesson+'|'+(w.id)]=[]);}
const allianceWords=words.map(w=>({id:w.id,word:w.word,lesson:1,branch:w.branchOf||w.branch,clue:w.explanation,source_ids:w.source_ids,query_id:w.query_id,sense_id:null}));
// branchOf needs explicit mapping: derive from table again.
const wordBranch=new Map();for(const [bid,,] of table)for(const [word] of table.find(t=>t[0]===bid)[3])if(!wordBranch.has(word))wordBranch.set(word,bid);
for(const aw of allianceWords)aw.branch=wordBranch.get(aw.word)||'B1';
entry: {
}
const entry={schema_version:'1.1.0',id:'cfcm-01',author:'sess_ab049c26-65ea-48d2-a1b1-ef228119425e / main / learning-template-author',
 roots,words,
 sources,
 changes:'第1课13课堂组176词：16个根身份按21个快照定界（ride/ready/errand 三线、ratio 覆盖 rat+reason、sect/saw 远缘同源、tail 双根、word/verb 同根 doublet）；例句来自课程词表（kind:course）；课堂对照词标 classroom。',
 alliance:{
  title:'第1课词根联盟',course_file:'build/vocab/cfcm-words.json',course_sha256:kit.sha(courseRaw),
  coverage_note:`第1课 13 个课堂组、176 个词，16 个根身份（组内异源子线已按快照拆分，如 ride/ready/errand）。例句来自万词课词表。`,
  branches:branchDefs,
  words:allianceWords,
  excluded:[],
  scope:{file:scopePath,sha256:kit.sha(scopeRaw),occurrences:177}
 }
};
const out=Buffer.from(JSON.stringify(entry,null,2)+'\n');
const target='learning/cfcm-01/candidates/lesson1/entry.json';
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(out);
if(changed)ws.atomic(ws.ROOT,target,out);
console.log(JSON.stringify({ok:true,target,changed,hash:kit.sha(out),roots:roots.length,words:words.length,alliance_words:allianceWords.length,branches:branchDefs.length,sources:sources.length,classroom:words.filter(w=>w.relation_kind==='classroom').length}));
