'use strict';
// Lesson 2 (cfcm-02): 10 branches, 12 roots, 216 words. Same as prepare-cfcm-01 but data differs.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const {englishEtymology}=require('./source-english.cjs');
const scopePath='build/qa/root-universe/review-20261107/cfcm-02-classroom-scope.json';
const scopeRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,scopePath));
const courseRaw=fs.readFileSync(kit.safeFile(ws.PROJECT,'build/vocab/cfcm-words.json'));
const course=JSON.parse(courseRaw),courseIndex=new Map();
for(const b of course.batches||[])for(const w of b.words||[])courseIndex.set(String(w.w).toLowerCase(),{lesson:w.lesson,ipa:w.ipa||'',def:w.def||'',sen:w.sen||'',senZh:w.senZh||''});
const caps=ws.json(ws.ROOT,'learning/alliance-captures.json');
const captureFor=Object.fromEntries(caps.map(c=>[c.title,c]));
const sources=[];
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
 return id;
}
for(const t of ['pass','passion','path','centipede','foot','pedagogy','brief','bridge','port','deport','air','space'])addSource(t);
const S=(...t)=>t.map(addSource);
const roots=[
 {id:'Rpass',label:'pass「步；通过」',meaning:'步；通过',origin:'拉丁 passus「步」→ 通俗拉丁 *passāre「走、过」→ 古法语 passer → 英语 pass',forms_note:'pace（步速）、compass（一起量出→罗盘）、trespass（越界）都是 passus「步」词族。印欧更早 *peth₂-「展开」。',source_ids:S('pass')},
 {id:'Rpassion',label:'patī「忍受」',meaning:'忍受；承受（→感情、被动）',origin:'拉丁 patior「忍受」→ passio「忍受之事」→ 感情；patientia → patience',forms_note:'passion/patient 两支同出 patior；希腊 pathos（B3）义同源词不同根，课堂对照记。印欧 *peh₁-「伤害」。',source_ids:S('passion')},
 {id:'Rpathos',label:'páthos「感受」',meaning:'感受；痛苦；疾病',origin:'希腊 páthos「感受、痛苦」→ pathetic/pathology/empathy 等',forms_note:'与拉丁 passio 义同根异（印欧 *kʷent- 与 *peh₁- 不同源），同义词分开记。pathogen/pathology 走「病痛」义。',source_ids:S('passion')},
 {id:'Rpath',label:'path「小路」',meaning:'小路；路径',origin:'古英语 pæþ「小路」← 日耳曼 *paþaz（快照：可能借自伊朗语，印欧 *póntoh₁s「路」）',forms_note:'path/pathway 是本土小路词，与希腊 pathos「感受」无关。',source_ids:S('path')},
 {id:'RpedFoot',label:'pēs「脚」',meaning:'脚',origin:'拉丁 pēs/pedis「脚」（印欧 *ped-）→ centipede/expedite/pedal 等',forms_note:'pedigree 来自拉丁短语 pē de grue「鹤脚」（家谱树的形状）；expedite 本义「把脚解开→使便利」。',source_ids:S('centipede')},
 {id:'Rfoot',label:'foot「脚」',meaning:'脚',origin:'古英语 fōt「脚」← 印欧 *pṓds（与拉丁 pēs 同根 doublet）',forms_note:'foot 是日耳曼本土词，与拉丁 pēs 同出印欧 *ped-；复合词大量（football/footprint…）。',source_ids:S('foot')},
 {id:'RpedChild',label:'país「儿童」',meaning:'儿童；教育',origin:'希腊 país/paid-「儿童」（印欧 *peh₂w-「小」）→ pedagogy/pediatric 等',forms_note:'ped-「儿童」（希腊）与 ped-「脚」（拉丁）拼写相同来源不同——同形异源对照组。',source_ids:S('pedagogy')},
 {id:'Rbrief',label:'brevis「短」',meaning:'短；简短',origin:'拉丁 brevis「短」← 印欧 *mréǵʰus「短」',forms_note:'brevity/abbreviate/abridge 同根；bridge 与 brief 无关（日耳曼 brycg）。',source_ids:S('brief')},
 {id:'RportHarbor',label:'portus「港；门」',meaning:'港；通道',origin:'拉丁 portus「港、通道」← 印欧 *pértus「渡口」（与 ford 同源 doublet）',forms_note:'opportunity 本义「（船）正对港口的风→有利的时机」；porch/portal 走 porta「门」一支。',source_ids:S('port')},
 {id:'RportCarry',label:'portāre「携带」',meaning:'携带；运送',origin:'拉丁 portō「搬运、携带」→ deport/export/import/report/support/transport/sport 等',forms_note:'sport 是 disport「消遣」（dis+porter「带走工作」）的截缩；important 本义「带入（心中）」。',source_ids:S('deport')},
 {id:'Rair',label:'aēr「空气」',meaning:'空气',origin:'希腊 āḗr「空气」→ 拉丁 āēr → 古法语 air → 英语',forms_note:'malaria 来自意大利语 mala aria「坏空气」；aerobic/aerosol 等是希腊 aer- 直接派生。',source_ids:S('air')},
 {id:'Rspace',label:'spatium「空间」',meaning:'空间；空隙',origin:'拉丁 spatium「空间、时段」← 印欧 *(s)peh₂-「拉、伸」',forms_note:'spacious/spatial 同根；span/spoon/spade 拼形相近但来源无关（课堂对照）。',source_ids:S('space')}
];
const table=[
 ['B1',null,'步与通过 · pass 词族（19）',[
  ['pass','Rpass','passus「步」→ 走过 → 通过；传递'],
  ['pace','Rpass','passus「步」→ 步速；速度'],
  ['passing','Rpass','pass 的动名词/形容词 → 经过；短暂的'],
  ['passage','Rpass','pass「通过」+ -age → 通过；段落；通道'],
  ['passageway','Rpass','passage + way → 通道，走廊'],
  ['bypass','Rpass','by-「旁边」+ pass → 绕过；旁路'],
  ['compass','Rpass','com-「共同」+ pass「量步」→ 环绕量出 → 罗盘；界限'],
  ['encompass','Rpass','en-「使」+ compass「环绕」→ 包含，围绕'],
  ['passable','Rpass','pass + -able → 可通行的；过得去的'],
  ['impasse','Rpass','im-「不」+ passe「通过」（法语）→ 死路，僵局'],
  ['impassable','Rpass','im-「不」+ passable → 不可通行的'],
  ['passport','Rpass','pass + port「港/城门」→ 过境证件 → 护照'],
  ['password','Rpass','pass + word「话」→ 通过所需的话 → 密码'],
  ['passenger','Rpass','pass「通过」+ -enger → 过客 → 乘客'],
  ['passer-by','Rpass','pass + by「旁边」→ 过路人'],
  ['surpass','Rpass','sur-「在上」+ pass → 越过 → 超过，胜过'],
  ['trespass','Rpass','tres-「超越」（法语 très）+ pass → 越界 → 非法侵入'],
  ['underpass','Rpass','under-「在下」+ pass → 地下通道'],
  ['overpass','Rpass','over-「在上」+ pass → 立交桥，天桥'],
 ]],
 ['B2',null,'忍受与感情 · patī 词族（11）',[
  ['passion','Rpassion','patī「忍受」→ 忍受之事 → 强烈的感情；激情'],
  ['passionate','Rpassion','passion + -ate → 充满激情的'],
  ['passionately','Rpassion','passionate + -ly → 激情地'],
  ['impassioned','Rpassion','im-「使」+ passion + -ed → 慷慨激昂的'],
  ['compassion','Rpassion','com-「共同」+ passion「受苦」→ 共同感受 → 同情'],
  ['compassionate','Rpassion','compassion + -ate → 有同情心的'],
  ['dispassionate','Rpassion','dis-「离开」+ passionate → 不动感情的，冷静的'],
  ['passive','Rpassion','patī「承受」→ 被动的，消极的'],
  ['impassive','Rpassion','im-「不」+ passive → 不动声色的，无表情的'],
  ['passively','Rpassion','passive + -ly → 被动地'],
  ['passivity','Rpassion','passive + -ity → 被动性'],
 ]],
 ['B3',null,'感受与病痛 · pathos 词族（28）',[
  ['pathos','Rpathos','páthos「感受、痛苦」→ 感染力；哀婉'],
  ['pathetic','Rpathos','pathos + -etic → 可怜的；可鄙的'],
  ['apathy','Rpathos','a-「无」+ pathos「感受」→ 冷漠，无动于衷'],
  ['apathetic','Rpathos','apathy + -etic → 冷漠的'],
  ['sympathy','Rpathos','sym-「共同」+ pathos → 共同感受 → 同情'],
  ['sympathetic','Rpathos','sympathy + -etic → 同情的；赞同的'],
  ['sympathetically','Rpathos','sympathetic + -ly → 同情地'],
  ['unsympathetic','Rpathos','un-「不」+ sympathetic → 不同情的'],
  ['sympathize','Rpathos','sympathy + -ize → 同情；赞同'],
  ['empathy','Rpathos','em-「进入」+ pathos → 进入对方感受 → 共情'],
  ['empathetic','Rpathos','empathy + -etic → 有共情力的'],
  ['empathize','Rpathos','empathy + -ize → 共情，感同身受'],
  ['antipathy','Rpathos','anti-「相反」+ pathos → 相反之感 → 反感'],
  ['antipathetic','Rpathos','antipathy + -etic → 反感的'],
  ['telepathy','Rpathos','tele-「远」+ pathos「感受」→ 远距感应 → 心灵感应'],
  ['pathogen','Rpathos','pathos「病痛」+ -gen「产生」→ 病原体'],
  ['pathology','Rpathos','pathos「病」+ -logy「学」→ 病理学'],
  ['pathological','Rpathos','pathology + -ical → 病理的；病态的'],
  ['pathologist','Rpathos','pathology + -ist → 病理学家'],
  ['psychopath','Rpathos','psychē「心智」+ pathos「病」→ 精神变态者'],
  ['psychopathology','Rpathos','psycho + pathology → 精神病理学'],
  ['homeopathy','Rpathos','homoio-「相似」+ pathos → 顺势疗法'],
  ['patience','Rpassion','patī「忍受」→ 忍耐 → 耐心'],
  ['impatience','Rpassion','im-「不」+ patience → 不耐心'],
  ['patient','Rpassion','patī「承受」→ 能承受的 → 耐心的；n. 病人'],
  ['impatient','Rpassion','im-「不」+ patient → 不耐烦的'],
  ['compatible','Rpassion','com-「共同」+ patī「承受」→ 能共处的 → 兼容的'],
  ['incompatible','Rpassion','in-「不」+ compatible → 不兼容的'],
 ]],
 ['B4',null,'小路与脚 · path / pēs（22）',[
  ['path','Rpath','古英语 pæþ「小路」（与 pathos 感受义无关）→ 小路；路径'],
  ['pathway','Rpath','path + way → 小径；通路'],
  ['centipede','RpedFoot','centi「百」+ pēs「脚」→ 百足虫 → 蜈蚣'],
  ['millipede','RpedFoot','milli「千」+ pēs「脚」→ 千足虫 → 马陆'],
  ['expedient','RpedFoot','ex-「出」+ ped「脚」→ 脚已解开 → 便利的；n. 权宜之计'],
  ['inexpedient','RpedFoot','in-「不」+ expedient → 不适宜的'],
  ['expediency','RpedFoot','expedient 的名词 → 权宜，便利'],
  ['expedite','RpedFoot','ex- + ped「脚」→ 解脚赶路 → 加快，促进'],
  ['expedition','RpedFoot','expedite 的名词 → 远征，考察'],
  ['expeditious','RpedFoot','expedite + -ious → 迅速高效的'],
  ['impede','RpedFoot','im-「在」+ ped「脚」→ 拴住脚 → 阻碍'],
  ['impediment','RpedFoot','impede 的名词 → 阻碍；障碍（口吃）'],
  ['pedal','RpedFoot','pēs「脚」+ -al → 脚踏的；n. 踏板'],
  ['soft-pedal','RpedFoot','soft + pedal → 轻踩弱音踏板 →淡化，低调处理'],
  ['peddle','RpedFoot','ped-「脚」→ 挑担走卖 → 兜售'],
  ['peddler','RpedFoot','peddle + -er → 小贩'],
  ['pedestal','RpedFoot','pēs/ped-「脚」→ 底座；基座'],
  ['pedestrian','RpedFoot','pēs「脚」→ 用脚走的 → 步行者；平淡的'],
  ['pedicure','RpedFoot','pēs「脚」+ cura「护理」→ 足部护理'],
  ['pedigree','RpedFoot','拉丁短语 pē de grue「鹤脚」（家谱树状）→ 家谱；血统'],
  ['crane',null,'课堂对照：crane「鹤」古英语 cran，与 pēs 无关（pedigree 的鹤脚联想）'],
  ['stampede',null,'课堂对照：来自西班牙语 estampida「踩踏惊逃」，词尾 -pede 拼形相近来源不同'],
 ]],
 ['B5',null,'脚 · foot 词族（16）',[
  ['foot','Rfoot','fōt「脚」（与拉丁 pēs 同印欧根）→ 脚；英尺；底部'],
  ['afoot','Rfoot','a-「在」+ foot → 在进行中，酝酿中'],
  ['barefoot','Rfoot','bare「赤裸」+ foot → 赤脚的（地）'],
  ['footage','Rfoot','foot「英尺」+ -age → 按英尺计的胶片 → 影片素材'],
  ['football','Rfoot','foot + ball → 足球'],
  ['footbridge','Rfoot','foot + bridge → 人行桥'],
  ['foothill','Rfoot','foot「底部」+ hill → 山麓丘陵'],
  ['foothold','Rfoot','foot + hold「立足处」→ 立足点'],
  ['footing','Rfoot','foot 的动名词 → 立足；地位； footing'],
  ['footloose','Rfoot','foot + loose「自由」→ 自由自在的'],
  ['footnote','Rfoot','foot「页脚」+ note → 脚注'],
  ['footprint','Rfoot','foot + print → 脚印'],
  ['footstep','Rfoot','foot + step → 脚步'],
  ['footwear','Rfoot','foot + wear「穿戴」→ 鞋类'],
  ['footwork','Rfoot','foot + work → 步法，脚下功夫'],
  ['underfoot','Rfoot','under-「在下」+ foot → 在脚下的'],
 ]],
 ['B6',null,'儿童与教育 · país 词族（8）',[
  ['pedagogy','RpedChild','paid-「儿童」+ agōgos「引导」→ 教育法；教育学'],
  ['pedagogical','RpedChild','pedagogy + -ical → 教学法的'],
  ['pedantry','RpedChild','paid- 希腊词脉（迂夫子）→ 迂腐'],
  ['pedantic','RpedChild','pedantry 的形容词 → 迂腐的，学究的'],
  ['encyclopedia','RpedChild','enkyklios「全面的」+ paideia「教育」→ 百科全书'],
  ['encyclopedic','RpedChild','encyclopedia + -ic → 百科全书式的，渊博的'],
  ['pediatric','RpedChild','paid-「儿童」+ iatros「医生」→ 儿科的'],
  ['pediatrician','RpedChild','pediatric + -ician → 儿科医生'],
 ]],
 ['B7',null,'简短 · brevis 词族（7）',[
  ['brief','Rbrief','brevis「短」→ 简短的；n. 摘要；指示'],
  ['briefcase','Rbrief','brief「公文」+ case「盒」→ 公文包'],
  ['abbreviate','Rbrief','ab-「使」+ brevi「短」+ -ate → 缩写，缩略'],
  ['abbreviation','Rbrief','abbreviate 的名词 → 缩写，缩略词'],
  ['brevity','Rbrief','brevis + -ity → 简短；简洁'],
  ['abridge','Rbrief','ab- + brevis「短」→ 缩短，节略'],
  ['bridge',null,'课堂对照：bridge「桥」古英语 brycg（木地板义），与 brevis 无关'],
 ]],
 ['B8',null,'港与携带 · portus / portāre（55）',[
  ['port','RportHarbor','portus「港」→ 港口；（船）左舷'],
  ['airport','RportHarbor','air + port「港」→ 机场'],
  ['seaport','RportHarbor','sea + port → 海港'],
  ['passport','Rpass','见第1组：pass + port「城门」→ 护照'],
  ['deport','RportCarry','de-「离开」+ portare「带」→ 驱逐出境'],
  ['deportation','RportCarry','deport + -ation → 驱逐'],
  ['export','RportCarry','ex-「向外」+ portare → 出口'],
  ['exporter','RportCarry','export + -er → 出口商'],
  ['import','RportCarry','im-「向内」+ portare → 进口；引入'],
  ['importation','RportCarry','import + -ation → 进口'],
  ['imported','RportCarry','import 的过去分词 → 进口的'],
  ['importer','RportCarry','import + -er → 进口商'],
  ['importance','RportCarry','import「带入」+ -ance → 带入心中的分量 → 重要性'],
  ['important','RportCarry','import「带入」+ -ant → 重要的'],
  ['all-important','RportCarry','all + important → 至关重要的'],
  ['importantly','RportCarry','important + -ly → 重要地'],
  ['unimportant','RportCarry','un-「不」+ important → 不重要的'],
  ['importune','RportHarbor','拉丁 importūnus「不合港口/时宜的」→ 强求，硬缠'],
  ['importunate','RportHarbor','importune + -ate → 纠缠不休的'],
  ['opportunist','RportHarbor','op-「朝」+ portus「港」→ 风正对港 → 有利时机 → 机会主义者'],
  ['opportune','RportHarbor','朝向港口（顺风）→ 恰逢其时的'],
  ['inopportune','RportHarbor','in-「不」+ opportune → 不合时宜的'],
  ['opportunistic','RportHarbor','opportunist + -ic → 投机的'],
  ['opportunity','RportHarbor','opportune 的名词 → 机会，时机'],
  ['portable','RportCarry','portare「带」+ -able → 便携的'],
  ['porter','RportCarry','portare「搬运」+ -er → 搬运工；门房'],
  ['portfolio','RportCarry','portare「携带」+ folium「叶片」→ 可携的纸页夹 → 公文包；投资组合'],
  ['purport','RportCarry','por-「向前」+ portare「带出」→ 大意；旨在'],
  ['purported','RportCarry','purport + -ed → 传闻的，号称的'],
  ['purportedly','RportCarry','purported + -ly → 据称'],
  ['rapport','RportCarry','re-「回」+ porter（法语）→ 来回带回 → 关系融洽'],
  ['report','RportCarry','re-「回」+ portare「带回」→ 报告'],
  ['reported','RportCarry','report 的过去分词 → 据报道的'],
  ['reportedly','RportCarry','reported + -ly → 据报道'],
  ['reporter','RportCarry','report + -er → 记者'],
  ['reporting','RportCarry','report 的动名词 → 报道'],
  ['support','RportCarry','sup-「在下」+ portare「扛」→ 支撑 → 支持'],
  ['supporter','RportCarry','support + -er → 支持者'],
  ['supporting','RportCarry','support 的形容词 → 支持的；配角'],
  ['supportive','RportCarry','support + -ive → 给予支持的'],
  ['insupportable','RportCarry','in-「不」+ supportable → 难以忍受的'],
  ['transport','RportCarry','trans-「跨越」+ portare → 运输'],
  ['transportation','RportCarry','transport + -ation → 交通运输'],
  ['sport','RportCarry','disport「消遣」（dis+porter 带走工作）的截缩 → 体育运动'],
  ['sporting','RportCarry','sport + -ing → 体育的；公正的'],
  ['sportsman','RportCarry','sport + s-man → 运动员'],
  ['sportsmanship','RportCarry','sportsman + -ship → 体育精神'],
  ['sportswriter','RportCarry','sport + writer → 体育记者'],
  ['sporty','RportCarry','sport + -y → 运动型的'],
  ['porch','RportHarbor','porta「门」（同 portus 印欧根）→ 门廊'],
  ['portal','RportHarbor','porta「门」+ -al → 大门；门户（网站）'],
  ['portmanteau','RportCarry','portare「携带」+ manteau「披风」→ 携带衣物的箱 → 旅行皮箱；合成词'],
  ['foliage',null,'课堂对照：foliage「叶」← 拉丁 folium，与 port 无关'],
  ['exfoliate',null,'课堂对照：ex- + folium「叶」→ 剥落，与 port 无关'],
  ['mantle',null,'课堂对照：mantle「披风、覆盖层」← 拉丁 mantellum，与 port 无关'],
 ]],
 ['B9',null,'空气 · aēr 词族（41）',[
  ['air','Rair','aēr「空气」→ 空气；空中；神态'],
  ['airy','Rair','air + -y → 通风的；轻快的'],
  ['airing','Rair','air 的动名词 → 通风；晾晒'],
  ['airbase','Rair','air + base → 空军基地'],
  ['airborne','Rair','air + borne「承载」→ 空中的；空运的'],
  ['air-conditioned','Rair','air + conditioned 复合 → 装有空调的'],
  ['air-conditioning','Rair','air + conditioning 复合 → 空调系统'],
  ['air-cooled','Rair','air + cooled → 风冷的'],
  ['aircraft','Rair','air + craft「飞行器」→ 飞机；航空器'],
  ['anti-aircraft','Rair','anti-「反」+ aircraft → 防空的'],
  ['airfare','Rair','air + fare「费用」→ 机票价'],
  ['airfield','Rair','air + field → 飞机场'],
  ['airflow','Rair','air + flow「流」→ 气流'],
  ['airless','Rair','air + -less → 无空气的；不通风的'],
  ['airlift','Rair','air + lift → 空运'],
  ['airline','Rair','air + line → 航空公司；航线'],
  ['airliner','Rair','airline + -er → 班机'],
  ['airlock','Rair','air + lock → 气闸舱'],
  ['airmail','Rair','air + mail → 航空邮件'],
  ['airman','Rair','air + man → 飞行员；空军士兵'],
  ['airplane','Rair','air + plane → 飞机'],
  ['airport','Rair','air + port → 机场'],
  ['airspace','Rair','air + space → 领空'],
  ['airstrike','Rair','air + strike「打击」→ 空袭'],
  ['airstrip','Rair','air + strip「带状地」→ 简易跑道'],
  ['airtight','Rair','air + tight「密」→ 密封的；无懈可击的'],
  ['airwaves','Rair','air + waves「波」→ 电波；广播'],
  ['airway','Rair','air + way → 航路；气道'],
  ['airworthy','Rair','air + worthy「适」→ 适航的'],
  ['malaria','Rair','意大利语 mala aria「坏空气」（古时认为沼泽坏气致病）→ 疟疾'],
  ['aeration','Rair','aer「空气」+ -ation → 通气，充气'],
  ['aerial','Rair','aer「空气」+ -ial → 空中的；天线'],
  ['aerobatics','Rair','aero「空」+ batics「走」→ 特技飞行'],
  ['aerobic','Rair','aero「空」+ bios「生命」→ 需氧的'],
  ['aerobics','Rair','aerobic 的名词 → 有氧运动'],
  ['anaerobic','Rair','an-「无」+ aerobic → 厌氧的'],
  ['aerodynamic','Rair','aero + dynamic「动力」→ 空气动力的'],
  ['aerodynamics','Rair','aerodynamic 的名词 → 空气动力学'],
  ['aeroplane','Rair','aero + plane → 飞机（英式拼法）'],
  ['aerosol','Rair','aero「空」+ solutio「溶液」→ 气溶胶；喷雾剂'],
  ['aerospace','Rair','aero + space → 航空航天'],
 ]],
 ['B10',null,'空间 · spatium 词族（11）',[
  ['space','Rspace','spatium「空间」→ 空间；太空；空隙'],
  ['cyberspace','Rspace','cyber「网络」+ space → 网络空间'],
  ['spacecraft','Rspace','space + craft「飞行器」→ 宇宙飞船'],
  ['spaceship','Rspace','space + ship → 宇宙飞船'],
  ['spacing','Rspace','space 的动名词 → 间隔，间距'],
  ['spacious','Rspace','spati「空间」+ -ous → 宽敞的'],
  ['spatial','Rspace','spatium + -al → 空间的'],
  ['spatially','Rspace','spatial + -ly → 空间上地'],
  ['span',null,'课堂对照：span「跨度」古英语 spannan「连接」，与 space 同源关系待核'],
  ['spoon',null,'课堂对照：spoon「勺」古英语 spōn「木片」，与 space 无关'],
  ['spade',null,'课堂对照：spade「锹」古英语 spædu，与 space 无关'],
 ]]
];
const branchDefs=[],wordRows=[],seen=new Set(),wordBranch=new Map();
for(const [branchId,_u,idea,rows] of table)for(const [word,rootId,clue] of rows){
 if(seen.has(word))continue;seen.add(word);
 wordRows.push({word,rootId,clue,branch:branchId});wordBranch.set(word,branchId);
}
const branchTitles=Object.fromEntries(table.map(t=>[t[0],t[2].split(' · ')[0]+' · '+t[2].split('（')[0]]));
for(const [branchId,_u,idea] of table){
 const ws2=wordRows.filter(w=>w.branch===branchId);
 const srcSet=[...new Set(ws2.flatMap(w=>w.rootId?roots.find(r=>r.id===w.rootId).source_ids:[]))];
 branchDefs.push({id:branchId,title:branchTitles[branchId],idea,source_ids:srcSet.length?srcSet:['Epass'],word_ids:ws2.map(w=>'A'+w.word)});
}
const words=[];
for(const w of wordRows){
 const c=courseIndex.get(w.word.toLowerCase());if(!c)throw Error('COURSE_MISSING '+w.word);
 const root=w.rootId?roots.find(r=>r.id===w.rootId):null;
 const rootLabel=root?root.label:w.word;
 const defClean=c.def.replace(/^[avnadjrpreppronconjuninternum]+\.\s*/i,'').split(/[;；]/)[0].trim()
  .replace(/（[^）]*[A-Za-z][^）]*）/g,'').replace(/\([^)]*[A-Za-z][^)]*\)/g,'').replace(/，[^，]*[A-Za-z][^，]*$/,'');
 words.push({
  id:'A'+w.word,word:w.word,query_id:`Lcfcm-02:${w.word.toLowerCase()}`,meaning:c.def,root_ids:root?[root.id]:[],relation_kind:root?'close':'classroom',lesson:c.lesson,
  parts:root?[{label:rootLabel.replace(/「.*$/,''),role:'root',root_id:root.id,meaning:root.meaning,source_ids:root.source_ids}]:[{label:w.word,role:'base',meaning:defClean.slice(0,16)||'课堂对照词',source_ids:['Epass']}],
  modern_formula:w.rootId?`${w.word} = ${rootLabel.replace(/「.*$/,'')} 词族成员`:`${w.word}（课堂对照词，不归入词根拆解）`,
  explanation:w.clue,
  trace:w.rootId?[{label:w.word,kind:'word',meaning:defClean||c.def,source_ids:root.source_ids},{label:rootLabel,kind:'root',meaning:root.meaning,root_id:root.id,source_ids:root.source_ids}]:[{label:w.word,kind:'word',meaning:defClean||c.def,source_ids:['Epass']}],
  source_ids:root?root.source_ids:['Epass'],
  example:(c.sen&&c.senZh)?{en:c.sen,zh:c.senZh,kind:'course'}:null,
  caveat:w.rootId?null:'本条为课堂记忆条目：构词线索为作者整理，引用词根代表词的已核快照；逐词独立来源待后续复核。',
  recall:{prompt:`「${defClean.slice(0,22)||c.def.slice(0,22)}」用哪个英文单词？`,answer:w.word,explanation:`${w.word}：${w.clue}`}
 });
}
const allianceWords=words.map(w=>({id:w.id,word:w.word,lesson:w.lesson,branch:wordBranch.get(w.word),clue:w.explanation,source_ids:w.source_ids,query_id:w.query_id,sense_id:null}));
const entry={schema_version:'1.1.0',id:'cfcm-02',author:'sess_ab049c26-65ea-48d2-a1b1-ef228119425e / main / learning-template-author',
 roots,words,sources,
 changes:'第2课10课堂组216词：12根身份（pass步/passion忍受/pathos感受/path小路/pēs脚/foot脚/país儿童/brevis短/portus港/portāre携/aēr空气/spatium空间）。passion与pathos同义异源、ped双义（脚/儿童）同形异源、port组拆港/携两根，均按快照定界；crane/stampede/foliage等课堂对照词标classroom。pass/port组内跨组词（passport）引第一组。例句来自课程词表。',
 alliance:{
  title:'第2课词根联盟',course_file:'build/vocab/cfcm-words.json',course_sha256:kit.sha(courseRaw),
  coverage_note:`第2课 10 个课堂组、216 个词，12 个根身份（passion/pathos 同义异源、ped 脚/儿童同形异源、port 港/携两根均按快照拆分）。`,
  branches:branchDefs,words:allianceWords,excluded:[],
  scope:{file:scopePath,sha256:kit.sha(scopeRaw),occurrences:218}
 }
};
const out=Buffer.from(JSON.stringify(entry,null,2)+'\n');
const target='learning/cfcm-02/candidates/lesson2/entry.json';
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(out);
if(changed)ws.atomic(ws.ROOT,target,out);
console.log(JSON.stringify({ok:true,target,changed,hash:kit.sha(out),roots:roots.length,words:words.length,branches:branchDefs.length,sources:sources.length,classroom:words.filter(w=>w.relation_kind==='classroom').length}));
