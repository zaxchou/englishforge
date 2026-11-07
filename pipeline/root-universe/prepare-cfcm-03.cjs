'use strict';
// Lesson 3 (cfcm-03): 10 branches, 11 roots, ~236 words.
const fs=require('node:fs');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const {englishEtymology}=require('./source-english.cjs');
const scopePath='build/qa/root-universe/review-20261107/cfcm-03-classroom-scope-corrected.json';
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
for(const t of ['base','abyss','line','psyche','social','chemistry','bio-','hair','horror','meter','life','wild'])addSource(t);
const S=(...t)=>t.map(addSource);
const roots=[
 {id:'Rbase',label:'basis「基础」',meaning:'基础；底',origin:'拉丁 basis ← 希腊 βάσις「步、底座」（同词源 basis）',forms_note:'base/bass（低音）是 doublet；abase/debase 走「压低」义。',source_ids:S('base')},
 {id:'Rline',label:'line「线」',meaning:'线；绳；行列',origin:'古英语 līne「绳、线」← 日耳曼 *līnǭ「亚麻绳」← *līną「亚麻」← 印欧 *līno-「亚麻」',forms_note:'linen（亚麻布）同根；拼写受古法语 ligne（拉丁 linea）影响。最老义「绳索」→ 引申「线、行列」。',source_ids:S('line')},
 {id:'Rpsycho',label:'psychē「灵魂」',meaning:'灵魂；心智',origin:'希腊 ψυχή「灵魂、气息」→ psyche/psychology/psychiatry 等',forms_note:'psych- 词族庞大；somatic（身体的）、therapy（照护）等是同组希腊词但非 psych 根。',source_ids:S('psyche')},
 {id:'Rsoci',label:'socius「同伴」',meaning:'同伴；联合',origin:'拉丁 socius「同伴、伙伴」← sequor「跟随」→ social/society/associate',forms_note:'associate 本义「结为同伴」；sociology=社会+学。',source_ids:S('social')},
 {id:'Rchem',label:'chēmeia「炼金术」',meaning:'化学；炼金',origin:'chemist ← 拉丁 alchimista ← 阿拉伯 اَلْكِيمِيَاء ← 希腊 χυμεία「合金术/液体」← χέω「倒、灌」',forms_note:'al- 是阿拉伯语定冠词（alchemy 保留）；chemistry 是 chemist 的派生。',source_ids:S('chemistry')},
 {id:'Rbio',label:'bios「生命」',meaning:'生命；生物',origin:'希腊 βίος「生命」→ biology/biochemistry/antibiotic 等',forms_note:'aerobic=空气+生命（需氧）、amphibian=两（种）生命、symbiosis=共同生活；bio 单词是 biology 的截缩。',source_ids:S('bio-')},
 {id:'Rhair',label:'hair「头发」',meaning:'头发；毛',origin:'古英语 hǣr「头发」← 日耳曼 *hērą ← 印欧 *ḱes-「刮、梳」',forms_note:'hair 组的「可怕」义走拉丁 horrēre（B8 第二根）——「毛竖起」意象连接两组，但 hair 与 horror 词源不同根。',source_ids:S('hair')},
 {id:'Rhorrere',label:'horrēre「毛竖」',meaning:'毛骨悚然；可怕',origin:'拉丁 horrere「（毛发因恐惧）竖起」→ horror/horrible/abhor',forms_note:'ab-「离开」+ horrēre → 令人发毛 → 憎恶；与 hair（日耳曼）不同根。',source_ids:S('horror')},
 {id:'Rmetron',label:'métron「测量」',meaning:'测量；尺度',origin:'希腊 métron「量具、尺度」（印欧 *mē-「量」）→ -meter 仪表词族/metric/geometry',forms_note:'meter 本词是日耳曼 metan「量」+受希腊 -meter 影响的拼法；拉丁 mensura（measure）与希腊 metron 同出印欧 *mē-，是远缘同源。',source_ids:S('meter')},
 {id:'Rlife',label:'līf「生命」',meaning:'生命；生活',origin:'古英语 līf ← 日耳曼 *lībą「生命、身体」← lībaną「留存」← 印欧 *leyp-「黏附」',forms_note:'live/alive/lively 等同根；liver（肝）也出自 *leyp-「黏脂」义；deliver（使自由←liber）只是拼形相近。',source_ids:S('life')},
 {id:'Rwild',label:'wild「野」',meaning:'野的；野生',origin:'古英语 wilde ← 日耳曼 *wilþijaz ← 印欧 *h₂welh₁-「毛、绒」',forms_note:'wilderness=wild+deor（野兽）+ness；wildlife 等现代复合。',source_ids:S('wild')}
];
const table=[
 ['B1',null,'基础 · basis 词族（16）',[
  ['base','Rbase','basis「基础」→ 基础，基地；底座'],
  ['basal','Rbase','base + -al → 基部的，基础的'],
  ['basic','Rbase','base + -ic → 基本的'],
  ['basically','Rbase','basic + -ally → 基本上，从根本上说'],
  ['basis','Rbase','拉丁 basis（同源 doublet）→ 基础，根据'],
  ['bass','Rbase','bassus「低的」（base 同源）→ 低音； bass 低音的'],
  ['abase','Rbase','a-「向」+ base「低」→ 使低下 → 贬低，使屈辱'],
  ['debase','Rbase','de-「向下」+ base → 贬低（价值、人格）'],
  ['basement','Rbase','base + -ment → 地下室'],
  ['baseball','Rbase','base「垒」+ ball → 棒球'],
  ['baseless','Rbase','base + -less → 无根据的'],
  ['baseline','Rbase','base + line → 基线，底线'],
  ['baseman','Rbase','base + man → （棒球）垒手'],
  ['database','Rbase','data「数据」+ base → 数据库'],
  ['abyss',null,'课堂对照：abyss「深渊」← 希腊 ἄβυσσος「无底的」（*dʰewbʰ- 深），与 basis 无关'],
  ['basin',null,'课堂对照：basin「盆」← 拉丁 bacinus「碗」，与 basis 无关'],
 ]],
 ['B2',null,'线 · line 词族（42）',[
  ['line','Rline','līne「绳、线」→ 线；行列；台词；v. 排列'],
  ['lineage','Rline','line「世系线」+ -age → 血统，家系'],
  ['lineal','Rline','line「世系」+ -al → 直系的'],
  ['linear','Rline','linea「线」+ -ar → 线性的'],
  ['nonlinear','Rline','non-「非」+ linear → 非线性的'],
  ['linebacker','Rline','line「锋线」+ backer → （橄榄球）线后卫'],
  ['lineman','Rline','line + man → （橄榄球）锋线球员；线路工'],
  ['linen','Rline','līn「亚麻」（词根本义）→ 亚麻布，床单'],
  ['liner','Rline','line + -er → 班轮；衬里'],
  ['lineup','Rline','line + up → 阵容； lineup'],
  ['airline','Rline','air + line → 航空公司'],
  ['airliner','Rline','airline + -er → 班机'],
  ['align','Rline','a-（ad-）+ line「线」→ 排成一线 → 对齐；使一致'],
  ['alignment','Rline','align 的名词 → 对齐；结盟'],
  ['realignment','Rline','re-「重新」+ alignment → 重新调整，改组'],
  ['baseline','Rline','base + line → 基线'],
  ['borderline','Rline','border「边」+ line → 边界线；介于两者之间的'],
  ['byline','Rline','by「署名处」+ line → （文章）署名行'],
  ['coastline','Rline','coast「海岸」+ line → 海岸线'],
  ['deadline','Rline','dead「死」+ line「界线」（不得越过的线）→ 截止期限'],
  ['delineate','Rline','de-「完整地」+ line「画线」+ -ate → 勾勒，描述'],
  ['front-line','Rline','front「前线」+ line → 一线的，前沿的'],
  ['fur-lined','Rline','fur「毛皮」+ lined → 衬毛皮的'],
  ['guideline','Rline','guide「指导」+ line → 指导方针'],
  ['hairline','Rline','hair「发」+ line → 发际线；极细的'],
  ['hard-line','Rline','hard「强硬」+ line → 强硬路线的'],
  ['headline','Rline','head「头」+ line → 标题；头条'],
  ['hemline','Rline','hem「褶边」+ line → （裙）底边线'],
  ['hotline','Rline','hot「热」+ line → 热线'],
  ['jetliner','Rline','jet「喷气」+ liner → 喷气客机'],
  ['lifeline','Rline','life「命」+ line → 生命线'],
  ['mainline','Rline','main「主要」+ line → 干线；主流的'],
  ['neckline','Rline','neck「颈」+ line → 领口线'],
  ['offline','Rline','off「离」+ line → 离线的'],
  ['online','Rline','on「在」+ line → 在线的'],
  ['outline','Rline','out「外」+ line「勾线」→ 轮廓；大纲；概述'],
  ['pipeline','Rline','pipe「管」+ line → 管道；在筹备中'],
  ['shoreline','Rline','shore「岸」+ line → 岸线'],
  ['sideline','Rline','side「边」+ line → 副业；边线；使靠边'],
  ['skyline','Rline','sky「天」+ line → 天际线'],
  ['streamline','Rline','stream「流」+ line → 使成流线型；精简'],
  ['underline','Rline','under-「在下」+ line「划线」→ 在…下划线；强调'],
 ]],
 ['B3',null,'灵魂与心智 · psychē 词族（32）',[
  ['psyche','Rpsycho','ψυχή「灵魂」→ 心灵，精神'],
  ['psychic','Rpsycho','psychē + -ic → 精神的；通灵的'],
  ['psycho','Rpsycho','psychē 截缩 → 精神变态者（口语）'],
  ['psychotic','Rpsycho','psychē「心智」+ -osis「病」+ -tic → 精神病的'],
  ['psychedelic','Rpsycho','psychē「心智」+ dēlos「显现」→ 迷幻的'],
  ['psychiatry','Rpsycho','psychē「心智」+ iatros「医治」→ 精神病学'],
  ['psychiatric','Rpsycho','psychiatry + -ic → 精神病学的'],
  ['psychiatrist','Rpsycho','psychiatry + -ist → 精神科医生'],
  ['psychoanalysis','Rpsycho','psycho + analysis「分析」→ 精神分析'],
  ['psychoanalyst','Rpsycho','psychoanalysis + -ist → 精神分析师'],
  ['psychoanalytic','Rpsycho','psychoanalysis + -tic → 精神分析的'],
  ['psychological','Rpsycho','psychē + -logical → 心理的'],
  ['psychologically','Rpsycho','psychological + -ly → 心理上'],
  ['psychologist','Rpsycho','psychology + -ist → 心理学家'],
  ['psychology','Rpsycho','psychē「心智」+ -logy「学」→ 心理学'],
  ['psychometric','Rpsycho','psycho + metric「测量」→ 心理测量的'],
  ['psychopath','Rpsycho','psycho「心智」+ pathos「病」→ 精神变态者'],
  ['psychopathology','Rpsycho','psycho + pathology → 精神病理学'],
  ['psychosis','Rpsycho','psychē「心智」+ -osis「病态」→ 精神病'],
  ['psychosocial','Rpsycho','psycho + social → 心理社会的'],
  ['psychosomatic','Rpsycho','psycho「心」+ sōma「身」→ 心身的，心因的'],
  ['psychotherapist','Rpsycho','psycho + therapist → 心理治疗师'],
  ['psychotherapy','Rpsycho','psycho + therapy → 心理治疗'],
  ['somatic',null,'课堂对照：sōma「身体」（希腊），独立词根（psychosomatic 的后半）'],
  ['chromosome',null,'课堂对照：chrōma「颜色」+ sōma「体」→ 染色体，独立希腊根'],
  ['chrome',null,'课堂对照：chrōma「颜色」→ 铬；铬合金，与 psyche 无关'],
  ['chromium',null,'课堂对照：chrōma「颜色」→ 元素铬，与 psyche 无关'],
  ['monochrome',null,'课堂对照：mono「单」+ chrōma「色」→ 单色的，与 psyche 无关'],
  ['therapy',null,'课堂对照：therapeia「照护」（希腊），独立词根'],
  ['therapist',null,'课堂对照：therapy + -ist → 治疗师，独立词根'],
  ['therapeutic',null,'课堂对照：therapeia「照护」+ -tic → 治疗的（独立希腊根，与 psyche 无关）'],
  ['chemotherapy',null,'课堂对照：chemo「化学」+ therapy「治」→ 化疗，两个独立根'],
 ]],
 ['B4',null,'同伴 · socius 词族（22）',[
  ['social','Rsoci','socius「同伴」+ -al → 社会的；社交的'],
  ['socially','Rsoci','social + -ly → 在社交方面'],
  ['socialism','Rsoci','social + -ism → 社会主义'],
  ['socialist','Rsoci','social + -ist → 社会主义者；社会主义的'],
  ['socialite','Rsoci','social + -ite → 社会名流'],
  ['socialize','Rsoci','social + -ize → 交往；使社会化'],
  ['socialization','Rsoci','socialize + -ation → 社会化'],
  ['societal','Rsoci','society + -al → 社会的'],
  ['society','Rsoci','socius「同伴」+ -etas → 社会；社团'],
  ['sociable','Rsoci','socius + -able → 好交际的'],
  ['unsociable','Rsoci','un-「不」+ sociable → 不合群的'],
  ['sociology','Rsoci','socius「社会」+ -logy「学」→ 社会学'],
  ['sociological','Rsoci','sociology + -ical → 社会学的'],
  ['sociologist','Rsoci','sociology + -ist → 社会学家'],
  ['antisocial','Rsoci','anti-「反」+ social → 反社会的'],
  ['associate','Rsoci','ad-「向」+ socius「结为同伴」→ 联想；合伙人；交往'],
  ['associated','Rsoci','associate 的过去分词 → 有关联的'],
  ['association','Rsoci','associate + -ion → 协会；联想；交往'],
  ['associative','Rsoci','association + -ive → 联想的'],
  ['disassociate','Rsoci','dis-「分离」+ associate → 使分离'],
  ['dissociate','Rsoci','dis-「分离」+ socius「同伴」→ 分开，脱离'],
  ['psychosocial','Rsoci','psycho + social → 心理社会的'],
 ]],
 ['B5',null,'炼金与化学 · chēmeia 词族（7）',[
  ['alchemy','Rchem','al-（阿拉伯定冠词）+ chēmeia「炼金术」→ 炼金术'],
  ['chemical','Rchem','chemistry + -al → 化学的；n. 化学品'],
  ['chemically','Rchem','chemical + -ly → 用化学方法'],
  ['chemist','Rchem','chēmeia「炼金」+ -ist → 化学家；药剂师'],
  ['chemistry','Rchem','chemist + -ry → 化学'],
  ['biochemical','Rchem','bio「生物」+ chemical → 生物化学的'],
  ['biochemistry','Rchem','bio + chemistry → 生物化学'],
 ]],
 ['B6',null,'生命 · bios 词族（29）',[
  ['biology','Rbio','bios「生命」+ -logy「学」→ 生物学'],
  ['biological','Rbio','biology + -ical → 生物的，生物学的'],
  ['biologically','Rbio','biological + -ly → 生物学上'],
  ['biologist','Rbio','biology + -ist → 生物学家'],
  ['biography','Rbio','bios「一生」+ graphein「写」→ 传记'],
  ['biographer','Rbio','biography + -er → 传记作者'],
  ['biographical','Rbio','biography + -ical → 传记的'],
  ['autobiographical','Rbio','auto-「自」+ biographical → 自传的'],
  ['autobiography','Rbio','auto-「自」+ biography → 自传'],
  ['biodiversity','Rbio','bio + diversity「多样」→ 生物多样性'],
  ['biomass','Rbio','bio + mass「量」→ 生物量'],
  ['biomedical','Rbio','bio + medical → 生物医学的'],
  ['biopsy','Rbio','bios「生命」+ opsis「观看」→ 活组织检查'],
  ['biosphere','Rbio','bio + sphere「圈层」→ 生物圈'],
  ['biotech','Rbio','bio + technology 截缩 → 生物技术'],
  ['biotechnology','Rbio','bio + technology → 生物技术'],
  ['antibiotic','Rbio','anti-「抗」+ bios「生命」→ 抗生的；抗生素'],
  ['biodegradable','Rbio','bio + degradable「可降解」→ 可生物降解的'],
  ['microbe','Rbio','mikros「小」+ bios「生命」→ 微生物'],
  ['microbiology','Rbio','micro「微」+ biology → 微生物学'],
  ['microbiologist','Rbio','microbiology + -ist → 微生物学家'],
  ['symbiosis','Rbio','syn-「共同」+ bios「生活」→ 共生'],
  ['symbiotic','Rbio','symbiosis + -tic → 共生的'],
  ['aerobic','Rbio','aero「空气」+ bios「生命」→ 需氧的（空气+生命，本词根是 aēr，见第2课）'],
  ['anaerobe','Rbio','an-「无」+ aero + bios → 厌氧微生物'],
  ['anaerobic','Rbio','an-「无」+ aerobic → 厌氧的'],
  ['amphibian','Rbio','amphi「两」+ bios「生命」→ 水陆两栖 → 两栖动物'],
  ['amphibious','Rbio','amphi「两」+ bios → 两栖的；水陆两用的'],
  ['aerobics','Rbio','aerobic 的名词 → 有氧运动'],
 ]],
 ['B7',null,'毛发与惊惧 · hair / horrēre（13）',[
  ['hair','Rhair','hǣr「头发」（印欧 *ḱes-「刮梳」）→ 头发；毛'],
  ['horror','Rhorrere','horrēre「毛竖」→ 恐怖；震惊'],
  ['horrible','Rhorrere','horror + -ible → 可怕的，糟糕的'],
  ['horribly','Rhorrere','horrible + -ly → 可怕地，非常'],
  ['horrid','Rhorrere','horrēre + -id → 可怕的，讨厌的'],
  ['horrify','Rhorrere','horror + -ify「使」→ 使恐惧'],
  ['horrifying','Rhorrere','horrify + -ing → 令人恐惧的'],
  ['horrified','Rhorrere','horrify 的过去分词 → 惊骇的'],
  ['horrific','Rhorrere','horror + -ific → 极其可怕的'],
  ['horrendous','Rhorrere','horrēre + -endus（拉丁动形词）→ 可怕的，惊人的'],
  ['abhor','Rhorrere','ab-「远离」+ horrēre「发毛」→ 憎恶'],
  ['abhorrence','Rhorrere','abhor + -ence → 憎恶'],
  ['abhorrent','Rhorrere','abhor + -ent → 令人憎恶的'],
 ]],
 ['B8',null,'测量 · métron 词族（35）',[
  ['meter','Rmetron','日耳曼 metan「量」+受希腊 métron 影响的拼法 → 表，计；米；韵律'],
  ['altimeter','Rmetron','alti「高」+ meter → 测高仪'],
  ['ammeter','Rmetron','ampere「安培」+ meter → 电流表'],
  ['anemometer','Rmetron','anemos「风」+ meter → 风速计'],
  ['barometer','Rmetron','baro「压」+ meter → 气压计；（行情）晴雨表'],
  ['centimeter','Rmetron','centi「百分之一」+ meter → 厘米'],
  ['decimeter','Rmetron','deci「十分之一」+ meter → 分米'],
  ['diameter','Rmetron','dia-「穿过」+ metron → 直径'],
  ['kilometer','Rmetron','kilo「千」+ meter → 千米'],
  ['millimeter','Rmetron','milli「千分之一」+ meter → 毫米'],
  ['odometer','Rmetron','hodos「路」+ meter → 里程表'],
  ['parameter','Rmetron','para-「旁」+ metron → 参数，参量'],
  ['pedometer','Rmetron','ped「脚」+ meter → 计步器'],
  ['perimeter','Rmetron','peri-「周」+ metron → 周长；周边'],
  ['spectrometer','Rmetron','spectro「光谱」+ meter → 光谱仪'],
  ['speedometer','Rmetron','speed「速度」+ meter → 速度计'],
  ['thermometer','Rmetron','thermo「热」+ meter → 温度计'],
  ['metric','Rmetron','metron「量」+ -ic → 米制的；度量标准'],
  ['asymmetric','Rmetron','a-「不」+ symmetric → 不对称的'],
  ['asymmetrical','Rmetron','asymmetric + -al → 不对称的'],
  ['asymmetry','Rmetron','a- + symmetry → 不对称'],
  ['diametrically','Rmetron','diameter「直径」+ -ically → 直接地（径直相对地）'],
  ['geometric','Rmetron','geō「地」+ metria「量地」→ 几何的'],
  ['geometry','Rmetron','geō「地」+ metria「量」（古时测地）→ 几何学'],
  ['symmetric','Rmetron','syn-「共同」+ metron「同尺度」→ 对称的'],
  ['symmetrical','Rmetron','symmetric + -al → 对称的'],
  ['symmetry','Rmetron','syn- + metron → 对称'],
  ['measure','Rmetron','拉丁 mēnsūra「量」（与希腊 metron 同印欧 *mē- 根，远缘同源）→ 测量；措施'],
  ['measured','Rmetron','measure 的过去分词 → 经过斟酌的，有节制的'],
  ['measuring','Rmetron','measure 的动名词 → 测量（用的）'],
  ['measurable','Rmetron','measure + -able → 可测量的，明显的'],
  ['commensurate','Rmetron','com-「同」+ mensur「量」+ -ate → 相称的，相当的'],
  ['incommensurate','Rmetron','in-「不」+ commensurate → 不相称的'],
  ['dimensional','Rmetron','拉丁 dīmēnsiō「量出」（同 *mē- 根）+ -al → 维度的'],
  ['immense','Rmetron','im-「不」+ mēnsūra「可量」→ 量大不可测 → 巨大的'],
 ]],
 ['B9',null,'生命 · līf 词族（40）',[
  ['life','Rlife','līf「生命」（印欧 *leyp-「黏附→留存」）→ 生命；生活'],
  ['afterlife','Rlife','after「后」+ life → 来世，余生'],
  ['lifeboat','Rlife','life + boat → 救生艇'],
  ['lifeguard','Rlife','life + guard「护卫」→ 救生员'],
  ['lifeless','Rlife','life + -less → 无生命的；死气沉沉的'],
  ['lifelike','Rlife','life + like「像」→ 逼真的'],
  ['lifelong','Rlife','life + long → 终身的'],
  ['life-saving','Rlife','life + saving → 救命的；救生'],
  ['life-size','Rlife','life + size → 与原物一样大的'],
  ['lifestyle','Rlife','life + style → 生活方式'],
  ['life-threatening','Rlife','life + threatening → 危及生命的'],
  ['lifetime','Rlife','life + time → 一生；使用期'],
  ['nightlife','Rlife','night「夜」+ life → 夜生活'],
  ['pro-life','Rlife','pro-「支持」+ life → 反堕胎的（支持生命）'],
  ['real-life','Rlife','real「真实」+ life → 现实生活中的'],
  ['wildlife','Rlife','wild「野」+ life → 野生动物'],
  ['alive','Rlife','a-「在」+ live「活」→ 活着的；有活力的'],
  ['live','Rlife','līf 的动词/形容词形式 → 活；现场直播的'],
  ['livable','Rlife','live + -able → 适合居住的'],
  ['lively','Rlife','live + -ly → 活泼的，生动的'],
  ['liven','Rlife','live + -en「使」→ 使有生气（up）'],
  ['enliven','Rlife','en-「使」+ liven → 使活跃'],
  ['livelihood','Rlife','live「生活」+ -lihood「状态」→ 生计'],
  ['living','Rlife','live 的动名词 → 生计；活着的'],
  ['livestock','Rlife','live + stock「牲畜」→ 牲畜'],
  ['outlive','Rlife','out-「超过」+ live → 比…活得长'],
  ['relive','Rlife','re-「再」+ live → 再体验，重温'],
  ['short-lived','Rlife','short + lived「活了」→ 短命的，短暂的'],
  ['long-lived','Rlife','long + lived → 长命的，持久的'],
  ['liver','Rlife','印欧 *leyp-「黏脂」→ 黏糊之物 → 肝脏（与 life 同根属词典共识：life 快照 cognate 链直证 *leyp-「黏」义与 body/脂义分支，liver 本词无单独快照）'],
  ['proliferate',null,'课堂对照：拉丁 prōlēs「后代」+ ferre「带」→ 激增，与 līf 无关'],
  ['proliferation',null,'课堂对照：proliferate 的名词 → 激增，与 līf 无关'],
  ['deliver',null,'课堂对照：拉丁 dē + līberāre「使自由」（liber「自由」）→ 递送，与 life 拼形相近不同根'],
  ['deliverance',null,'课堂对照：deliver + -ance → 解救，同上'],
  ['delivery',null,'课堂对照：deliver 的名词 → 递送，同上'],
  ['livid',null,'课堂对照：拉丁 livēre「青黑」→ 怒气青紫的，与 līf 无关'],
  ['oblivion',null,'课堂对照：拉丁 oblīvīscī「忘」（*lewh- 根）→ 遗忘，与 life 无关'],
  ['oblivious',null,'课堂对照：oblivion 的形容词 → 未察觉的，同上'],
  ['olive',null,'课堂对照：拉丁 olīva「橄榄」，与 life 无关'],
  ['oil',null,'课堂对照：拉丁 oleum「油」，与 life 无关'],
 ]],
 ['B10',null,'野 · wild 词族（9，wildlife另见life组）',[
  ['wild','Rwild','wilde「野的」（印欧 *h₂welh₁-「毛发蓬乱」）→ 野的；狂热的'],
  ['wilderness','Rwild','wild + deor「野兽」+ -ness → 荒野'],
  ['wildfire','Rwild','wild + fire → 野火；燎原之势'],
  ['wildflower','Rwild','wild + flower → 野花'],
  ['wildly','Rwild','wild + -ly → 狂乱地；极其'],
  ['bewildered','Rwild','bewilder + -ed → 困惑的；迷失方向的'],
  ['bewildering','Rwild','bewilder + -ing → 令人困惑的'],
  ['bewilderment','Rwild','bewilder + -ment → 困惑；茫然'],
 ]]
];
const branchDefs=[],wordRows=[],seen=new Set(),wordBranch=new Map();
for(const [branchId,_u,idea,rows] of table)for(const [word,rootId,clue] of rows){
 if(seen.has(word))continue;seen.add(word);
 wordRows.push({word,rootId,clue,branch:branchId});wordBranch.set(word,branchId);
}
const branchTitles=Object.fromEntries(table.map(t=>[t[0],t[2].split('（')[0]]));
for(const [branchId,_u,idea] of table){
 const ws2=wordRows.filter(w=>w.branch===branchId);
 const srcSet=[...new Set(ws2.flatMap(w=>w.rootId?roots.find(r=>r.id===w.rootId).source_ids:[]))];
 branchDefs.push({id:branchId,title:branchTitles[branchId],idea,source_ids:srcSet.length?srcSet:['Ebase'],word_ids:ws2.map(w=>'A'+w.word)});
}
const words=[];
for(const w of wordRows){
 const c=courseIndex.get(w.word.toLowerCase());if(!c)throw Error('COURSE_MISSING '+w.word);
 const root=w.rootId?roots.find(r=>r.id===w.rootId):null;
 const rootLabel=root?root.label:w.word;
 const defClean=c.def.replace(/^[avnadjrpreppronconjuninternum]+\.\s*/i,'').split(/[;；]/)[0].trim()
  .replace(/（[^）]*[A-Za-z][^）]*）/g,'').replace(/\([^)]*[A-Za-z][^)]*\)/g,'').replace(/，[^，]*[A-Za-z][^，]*$/,'');
 const isCognate=w.rootId&&['measure','measured','measuring','measurable','commensurate','incommensurate','immense','dimensional'].includes(w.word);
 words.push({
  id:'A'+w.word,word:w.word,query_id:`Lcfcm-03:${w.word.toLowerCase()}`,meaning:c.def,root_ids:root?[root.id]:[],relation_kind:root?(isCognate?'cognate':'close'):'classroom',lesson:c.lesson,
  parts:root?[{label:rootLabel.replace(/「.*$/,''),role:'root',root_id:root.id,meaning:root.meaning,source_ids:root.source_ids}]:[{label:w.word,role:'base',meaning:defClean.slice(0,16)||'课堂对照词',source_ids:['Ebase']}],
  modern_formula:w.rootId?`${w.word} = ${rootLabel.replace(/「.*$/,'')} 词族成员`:`${w.word}（课堂对照词，不归入词根拆解）`,
  explanation:w.clue,
  trace:w.rootId?[{label:w.word,kind:'word',meaning:defClean||c.def,source_ids:root.source_ids},{label:rootLabel,kind:'root',meaning:root.meaning,root_id:root.id,source_ids:root.source_ids}]:[{label:w.word,kind:'word',meaning:defClean||c.def,source_ids:['Ebase']}],
  source_ids:root?root.source_ids:['Ebase'],
  example:(c.sen&&c.senZh)?{en:c.sen,zh:c.senZh,kind:'course'}:null,
  caveat:w.rootId?(isCognate?'拉丁 mēnsūra 与希腊 métron 同出印欧 *mē-「量」，是远缘同源而非同一词根。':null):'本条为课堂记忆条目：构词线索为作者整理，引用词根代表词的已核快照；逐词独立来源待后续复核。',
  recall:{prompt:`「${defClean.slice(0,22)||c.def.slice(0,22)}」用哪个英文单词？`,answer:w.word,explanation:`${w.word}：${w.clue}`}
 });
}
const allianceWords=words.map(w=>({id:w.id,word:w.word,lesson:w.lesson,branch:wordBranch.get(w.word),clue:w.explanation,source_ids:w.source_ids,query_id:w.query_id,sense_id:null}));
const entry={schema_version:'1.1.0',id:'cfcm-03',author:'sess_ab049c26-65ea-48d2-a1b1-ef228119425e / main / learning-template-author',
 roots,words,sources,
 changes:'第3课10课堂组242词：11根身份（basis/line/psychē/socius/chēmeia/bios/hair/horrēre/métron/līf/wild）。hair与horror异根教学对照（毛竖意象）；meter本词为日耳曼metan；measure族与meter同印欧*mē-标cognate；somatic/chrome/therapy/deliver/livid/olive等课堂对照词标classroom。three-dimensiona（讲义换行截断形）与 larger-than-life（跨组词、课程表无此条目）不入档；wild 组按印刷30—31页跨文件续接9词，wildlife在life组保留一次；补入wildly/bewildered/bewildering/bewilderment。例句来自课程词表。',
 alliance:{
  title:'第3课词根联盟',course_file:'build/vocab/cfcm-words.json',course_sha256:kit.sha(courseRaw),
  coverage_note:`第3课 10 个课堂组、242 个词，11 个根身份（hair 与 horror 异根对照、measure 与 meter 远缘同源、21 个课堂对照词已标明）。`,
  branches:branchDefs,words:allianceWords,excluded:[],
  scope:{file:scopePath,sha256:kit.sha(scopeRaw),occurrences:247}
 }
};
const out=Buffer.from(JSON.stringify(entry,null,2)+'\n');
const target='learning/cfcm-03/candidates/lesson3/entry.json';
const changed=!fs.existsSync(ws.file(ws.ROOT,target))||!ws.bytes(ws.ROOT,target).equals(out);
if(changed)ws.atomic(ws.ROOT,target,out);
console.log(JSON.stringify({ok:true,target,changed,hash:kit.sha(out),roots:roots.length,words:words.length,branches:branchDefs.length,sources:sources.length,classroom:words.filter(w=>w.relation_kind==='classroom').length,cognate:words.filter(w=>w.relation_kind==='cognate').length}));
