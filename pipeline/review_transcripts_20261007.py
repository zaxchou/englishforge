"""Local review derivatives only. No API calls; never overwrite original materials.
The patch table is a human-readable record of assistant text review, not audio certification.
"""
from pathlib import Path
import re, json, hashlib, shutil, difflib
ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / 'docs/transcript-review-2026-10-07'
SRC = ROOT.parent / '新D方/新D方新托福全套/01 托福词汇课 孙曦/逐字稿'
OUT = ROOT / 'build/scripts-reviewed/ndf-01'

def sha(b): return hashlib.sha256(b).hexdigest()
def norm(s): return re.sub(r'[^a-z0-9\u4e00-\u9fff]', '', s.lower())

# Only locally supported corrections. Ambiguous quotations remain in pending notes.
PATCHES = {
1: [('孙旭老师','孙曦老师'), ('也就是l和m这两个辅音字母','也就是h和d这两个辅音字母')],
2: [('来自于阿del的','来自于Adele的'), ('reaching a favor pitch','reaching a fever pitch'), ('black。word','black board'), ('he made and showed projectors','he made and sold projectors')],
4: [('后缀叫否ful','后缀叫-ful'), ('而意思是系动词','而is是系动词')],
6: [('your studies is suffering','your studies are suffering'), ('new tree express','Nutri Express'), ('judge偏见','judge评判')],
7: [('unuse','unused'), ('corroborate this results','corroborate these results')],
8: [('l pollutants','air pollutants'), ('regular great pattern','regular grid pattern'), ('他说一这种庞大的橡树','他说这种庞大的橡树')],
10: [('show up','shore up'), ('into a new a person','into a new person'), ('in going vessels','ingoing vessels')],
11: [('this systems emit','these systems emit'), ('arterial pollutants','other air pollutants'), ('carbon 表示，两个啊','di 表示，两个啊'), ('were order l pollutants','other air pollutants'), ('events invest ourselves','invest ourselves'), ('two types of bounds','two types of bonds'), ('giving 就是一种让步','give in 就是一种让步')],
12: [('by the true of their small size','by virtue of their small size')],
13: [('three principle layers','three principal layers'), ('this results contrast','these results contrast'), ('amount for','account for')],
14: [('我见 我至 我征服','我至 我见 我征服'), ('capable of introspection and evaluate yourself','capable of introspection and evaluating yourself')],
15: [('and no nutritive sucking devices','and non-nutritive sucking devices'), ('no nutritive这个','non-nutritive这个'), ('this geologists','these geologists')],
16: [('portuguese directly route','Portuguese direct route'), ('a near long beach california','near Long Beach, California')],
17: [('he been trying','he has been trying')],
18: [('cocktails crocodiles','crocodiles'), ('fans dictate what we can do','funds dictate what we can do'), ('this include the chaotic','this includes the chaotic'), ('are contradiction','are contradictory'), ('call up on','call upon')],
19: [('the worker was found to the master','the worker was bound to the master')],
20: [("on the signaler’s cost that are",'on the signaler costs that are'), ("on the signaler's cost that are",'on the signaler costs that are'), ('phrase over叫短语动词','phrasal verb叫短语动词')],
21: [("they’re liking",'their liking'), ("they're liking",'their liking'), ("there believe in art for art's sake", "their belief in art for art's sake"), ('sign contract with','sign a contract with'), ('art for art sake',"art for art's sake")],
23: [('rollers','rowers'), ('roller','rower'), ('compulsively','compulsorily'), ('compulsory ly','compulsorily'), ('阿里巴巴刚刚强调','Oliver刚刚强调')],
26: [('proceeding','preceding'), ('rep len replenish','replenish'), ('but looks dominant size', "but Uruk's dominant size"), ('works dominant size', "Uruk's dominant size"), ('work就是一个乌鲁克','Uruk就是一个乌鲁克'), ('for supposing','far surpassing'), ('that it was original center','that it was a regional center')],
28: [('life is made up sobs','life is made up of sobs'), ("I'm just sniff around", "I'm just sniffing around")],
29: [('no taking','note-taking'), ('iam','I am'), ('the dog arches back','the dog arches its back')],
31: [('the conference did generated into a complete fiasco','the conference degenerated into a complete fiasco')],
32: [('船破','船舶'), ('根种','耕种')],
33: [('principle influences','principal influences'), ('mop表示，脱发','mop表示，拖把'), ('the lead actor and extraterrestrial heartthrob','the lead actor, an extraterrestrial heartthrob')],
38: [('in this politically correct times','in these politically correct times')],
40: [('the great canyon','the Grand Canyon'), ('a man of with granite determination','a man with granite determination')],
43: [('AC ring 叫酸雨','acid rain 叫酸雨')],
44: [('probable，叫概率','probability，叫概率')],
46: [('modify local kinds of。conservationists','mollify local conservationists'), ('be or for prey to somebody','be or fall prey to somebody'), ('poly androus','polyandrous')],
48: [('titut这个','stitut这个'), ('president bush。they told the Bill on July.sixth','President Bush vetoed the bill on July sixth'), ('竟然说w你不要','你不要')],
}

TAIL_PATCHES = {2: [('hor di culture', 'horticulture'), ('holy culture', 'horticulture'), ('called cult', 'cult'), ('in edible', 'inedible'), ('不可以使用的', '不可以食用的'), ('和it，你会发现', '和eat，你会发现'), ('SID表示做', 'SID表示坐'), ('一直做在这里', '一直坐在这里'), ('双斜', '双写'), ('arguous', 'arduous'), ('arches', 'arduous'), ('rgus', 'arduous'), ('叫great后面补个一字母就可以了', '叫grade'), ('aggreavate', 'aggravate'), ('刑法来记住', '记法来记住'), ('adver cate', 'advocate'), ('词根部分grieve', '词根部分grav'), ('具有启迪性意义的叫illumination', '具有启迪性意义的叫illuminating'), ('而luna形容词月球的', '而lunar形容词月球的'), ('Chinese luna calendar', 'Chinese lunar calendar'), ('jason raz', 'Jason Mraz'), ('单词叫呃。cumulate', '单词叫accumulate'), ('这就是呃。cumulate', '这就是accumulate'), ('organism这个单词叫什么有机物', 'organism这个单词叫什么生物体'), ('叫做呢的意思', '叫做泥的意思'), ('生命成长的group', '生命成长的growth'), ('brie。ef', 'brief'), ('new is school', 'New East School'), ('nos new and school', 'NOS New Oriental School'), ('at动词后缀', 'ate动词后缀'), ('是这个童话就是', '是这个同化就是')], 6: [('地表向下', 'de表向下'), ('刚才PR 1不一样', '刚才pre不一样'), ('浪表长度', 'long表长度'), ('drive，这个drive', 'dry，这个dry'), ('disasters表示的意思叫做灾难性的', 'disastrous表示的意思叫做灾难性的'), ('moeote', 'mot'), ('f ization', 'fossilization'), ('soft body ed animals', 'soft-bodied animals'), ('soft boded animals', 'soft-bodied animals'), ('soft body animals', 'soft-bodied animals'), ('ever loving', 'Avril Lavigne'), ('a fact叫影响', 'affect叫影响'), ('法令咨章', '法令滋彰'), ('法令私章', '法令滋彰'), ('铸形鼎', '铸刑鼎'), ('注形顶', '铸刑鼎'), ('顶上面注那些法律', '鼎上面铸那些法律'), ('因因解释', '英英解释'), ('英音字典', '英英字典'), ('音音解释', '英英解释'), ('它的注名', '它的著名'), ('叫for其实也很简单', '叫fore-其实也很简单'), ('这是for这个前缀', '这是fore-这个前缀'), ('rt oric device', 'rhetorical device'), ('投运', '头韵'), ('头晕', '头韵'), ('托付写作', '托福写作'), ('而focus叫提前扔', '而forecast叫提前扔'), ('for tell', 'foretell'), ('for c遇见', 'foresee预见'), ('叫延吃延期', '叫延迟延期'), ('刚刚说了jack这个词根', '刚刚说了ject这个词根'), ('表示网理', '表示往里'), ('my weight was reduce to', 'my weight was reduced to'), ('减少。了20公顷', '减少。了20公斤'), ('具和败的含义', 'to和by的含义'), ('标深', '飙升'), ('叫所。注意发音', '叫soar。注意发音'), ('so er', 'soar'), ('不会写also n', '不会写翱翔'), ('那么硕这个字', '那么soar这个词'), ('search', 'surge'), ('reflects of the walls', 'reflects off the walls'), ('re。vibration', 'reverberation'), ('同感或同义的意思', '同感或同意的意思'), ('它的形容词非常重要，叫consensus', '它的名词非常重要，叫consensus'), ('right toys', 'right choice'), ('the oldest harvest', 'the oyster harvest'), ('这个hamburger这个词', '这个hamper这个词'), ('也会影响娱乐的一些', '也会影响鱼类的一些')]}

NOTES = {
1: ['contradictory meteorite 与“球粒状陨石”不对应，候选为 chondritic meteorite；讲义未给出这条短语，待听音或看幻灯片确认。home/dome 的联想不能作为已核验的词源关系。'],
2: ['原校对稿在“所以有一些”处中断；后续已按原始转写补回并作本地文字复核，尾段原始转写另存供追查。a和梗/鹰嘴一狗、fair ratio、quiet 等片段待原音核对；词根联想不等于已证实词源。specific the meaning、which means can 片段不完整，不能猜补后出题。'],
3: ['音变、字母互换是记忆辅助，不能据此断言任意新词的真实词源。'],
4: ['many people are poor and hunger / people are poverty 是课堂错误示例，保留，不能作为正确句入库。量词和程度副词的讲解需要结合实际搭配，不形成无例外禁令。'],
5: ['“考点词汇”的定义附近存在漏句；ced 与方向性前缀的衔接也缺目标词。缺词段待听音，不猜补。'],
6: ['原校对稿在 pride and prejudice 后的“好，下一个”处中断；prescription 及后续方向性前缀已按原始转写补回并作本地文字复核。takao 地名、first three、roof/y 的词根片段、laws and order 及歌德引文仍待原音核对。liger、which one is by two ways 片段待听音。'],
7: ['demerit/mar 的对照片段残缺；inflation 与 flow 的词源关系、crucial 的程度副词限制不能仅凭记忆联想认定。'],
8: ['motion pictures 表示电影；动作片为 action films。casting a chance shade 片段有误听，原词不确定，待听音。sorb/soup、pigment/pig 等联想不是已核验词源。'],
9: ['sip sap sip cap 的词根拼写、promoting the federal welfare 的引文需原音核对。the chances are against 表示可能性不利，不等于绝对不可能。'],
10: ['transform berry snow into glacial ice 的 berry 有误听嫌疑；flipper self 引文残缺，待听音。'],
11: ['admit 与 admit of 的表达不能只靠词根推断搭配，需逐项核对。'],
12: ['vanish ness、most favorite 等引文碎片待听音，不据此造词或确定词性。'],
13: ['nothing is more regrettable 一段英文引文语法残缺，暂不作为标准例句；美国宪法“第一部”历史断言未做本地证据核验。'],
14: ['mummy spirit/stubborn and king、begging course 的英文引文残缺，待听音；不擅自重造完整句。'],
15: ['although origin in Richard 片段与戏剧/仪式语境不符，待听音。try to do 是尝试/努力做，不自动等于“不遗余力”。'],
16: ['intervene 的释义出现 do you become involved 片段，待听音确认是定义还是问句。'],
17: ['so one’s natural selection had shape 等整句转写残缺；另一课出现相近引文，但不据此冒充已听音还原。river to I rica、strategic one in number 等片段待听音。'],
18: ['dogs vocalize at many different sounds 的介词、book/voc 的词根片段待听音。'],
19: ['green algorithm 疑似藻类词误听；small firm granules 疑为 firn granules，讲义无对应引文，待原音确认。object doing 是课堂错误示例，不改成正确例句。'],
20: ['another oe well 引文不完整。at your disposal 的表达要区分“随时供你使用”和帮助他人，不能照残句套用。'],
21: ['本次仅确认文字与搭配问题，未听音核对课堂引文。'],
22: ['and organized government 的所指不明，原音核对前不改写成新的历史引文。'],
23: ['free citizens 指自由公民，不等于失业者；原有解释不作为释义出题依据。'],
24: ['homicide 泛指杀人，不自动等于 murder 谋杀，司法含义需结合具体语境。'],
25: ['Academus 等专名和历史联系未核验；this wraps/rough 在鹿擦痕语境有误听嫌疑，待听音。'],
26: ['Spartan 在植物语境有误听嫌疑。Obama 引文中的 a founders 等不完整，待原音核对。'],
27: ['parking 在人物语境可能是人名，无法仅凭文本确认拼写。'],
28: ['deer sniff and lick and unfamiliar up / TIA 与上下文不符，待原音定位。communication purpose 一段的搭配残缺，不重造引文。'],
29: ['Sabin/Sabine 专名待原稿证据核验。archy/Arctic 等记忆联系不能充当真实词源。'],
30: ['史前技术一段引文的过去时与原文完整性未听音确认，不作引文认证。'],
31: ['课堂历史/词源讲解未逐项作事实认证。'],
32: ['vessel 表示船舶、容器等；navigator 指导航者/导航设备，navigate 是航行/导航。此处把“舰艇”“导航仪”接在一起的原文存在漏词，待听音；讲义分别列出 navy/naval/navigate/navigation/navigator。demarcation line 是分界线，不仅限于三八线。'],
33: ['mop 用于头发语境可表示浓密的一团头发，不是“脱发”；词源联想与形象记忆需分开。'],
34: ['“九大行星”属于课程旧材料口径，不作为现行天文学知识认证。if I should be you 的示例与常见 if I were you 不宜混作一个固定表达。'],
35: ['you have us to have us believe 片段残缺，待听音。'],
36: ['词根记忆法仅作为教学辅助，未逐词认证历史词源。'],
37: ['keel boats continue 的引文时态尚未听音核对。'],
38: ['politically correct 的评价色彩取决于语境，不固定为一个贬义释义。'],
39: ['radar 的来历不能从 radius/rad 记忆联想直接推出，需独立词源证据。'],
40: ['本课被移出的重复概述不再作为课堂逐字正文。'],
41: ['ethic 为名词（道德原则等），ethical 才是常用的“伦理的”形容词；ethnic 为“种族/民族的”，三者不能混用。'],
42: ['水流/电流的讲解应对应 current，不能把 static electricity（静电）当作“水流”。resonance 是共振/共鸣，不等于 echo 回声；TilTiva come 地名片段待听音。'],
43: ['ecologist 是生态学家名词；原先添加的概述将其写作形容词，该概述已隔离。'],
44: ['fraction 为分数，decimal 为小数；“糖”的化学式未给出完整下标，不猜填一种糖的分子式。'],
45: ['sauce 泛指酱汁，soy sauce 才是酱油；cyclone 为气旋，不直接等于 tornado 龙卷风。'],
46: ['whole/some 在恒温动物词根段中疑似误听；predator ing and conniver s 片段残缺，待原音确认。'],
47: ['保留口语停顿和课堂省略，不将所有英文碎片都擅自改成新的完整引文。'],
48: ['metropolitan 的 chill/poly 片段残缺；城市词素 poli/polis 与 poly（多）不同。美国宪法的历史“第一部”口径未认证。'],
}


def main():
    coverage = json.loads((AUDIT/'coverage.json').read_text('utf-8'))
    excluded = {x['lesson'] for x in json.loads((AUDIT/'unmatched-prefix-evidence.json').read_text('utf-8'))}
    OUT.mkdir(parents=True, exist_ok=True)
    for d in ['excluded-prefixes','pending-tails','original-inventories']:
        (AUDIT/d).mkdir(exist_ok=True)
    manifest=[]; total=0
    for c in coverage:
        n=c['lesson']; name=c['file']; original=(AUDIT/'originals'/name).read_bytes()
        if sha((SRC/name).read_bytes()) != c['sha256'] or sha(original)!=c['sha256']:
            raise RuntimeError(f'source drift: {name}')
        s=original.decode('utf-8').replace('\r\n','\n'); raw=(ROOT/f'build/scripts-raw/ndf-01-{n:02d}.txt').read_text('utf-8')
        heads=list(re.finditer(r'^## .+$',s,re.M)); prefix=''; removed=0
        if n in excluded:
            assert len(heads)==2, (n,'heading drift')
            prefix=s[heads[0].start():heads[1].start()];removed=len(prefix)
            (AUDIT/'excluded-prefixes'/name).write_text('# 隔离的非逐字前缀：原始转写未定位，非认证课堂原文\n\n'+prefix,encoding='utf-8')
            s=s[:heads[0].start()]+s[heads[1].start():]
        applied=[];absent=[]
        for old,new in PATCHES.get(n,[]):
            # ASCII boundaries prevent unuse->unused from corrupting already-correct unused.
            pat=(r'(?<![A-Za-z])' if old[0].isascii() and old[0].isalpha() else '')+re.escape(old)+(r'(?![A-Za-z])' if old[-1].isascii() and old[-1].isalpha() else '')
            hits=list(re.finditer(pat,s));count=len(hits)
            if not count: absent.append(old);continue
            context=[s[max(0,m.start()-35):m.end()+55] for m in hits]
            s=re.sub(pat,lambda m:new,s)
            applied.append({'before':old,'after':new,'occurrences':count,'contextBefore':context})
            total+=count
        stem=f'ndf-01-{n:02d}'; invfile=SRC/(stem+'.words.json')
        invbytes=invfile.read_bytes();inv=json.loads(invbytes)
        (AUDIT/'original-inventories'/invfile.name).write_bytes(invbytes)
        removedwords=[]
        if prefix:
            for key in ['words','affixes','roots','phrases']:
                kept=[]
                for word in inv.get(key,[]):
                    w=norm(word)
                    if len(w)>=4 and w in norm(prefix) and w not in norm(s) and w not in norm(raw):
                        removedwords.append({'field':key,'value':word,'reason':'仅在未定位前缀中出现，正文与原始转写均未匹配'})
                    else:kept.append(word)
                inv[key]=kept
        # Align the corrected spelling when that inventory item itself is present.
        invfix={23:{'roller':'rower','rollers':'rowers'},44:{'probable':'probability'}}.get(n,{})
        for key in ['words']:
            inv[key]=list(dict.fromkeys(invfix.get(w,w) for w in inv.get(key,[])))
        if n in [2,6]:
            a=norm(original.decode('utf-8')[-1500:]);b=norm(raw)
            blocks=difflib.SequenceMatcher(None,a,b,autojunk=False).get_matching_blocks()
            m=max((m for m in blocks if m.size>=30),key=lambda m:m.a+m.size)
            assert m.a+m.size>=len(a)-10
            mapping=[i for i,ch in enumerate(raw) if re.match(r'[a-z0-9\u4e00-\u9fff]',ch.lower())]
            start=mapping[m.b+m.size-1]+1
            (AUDIT/'pending-tails'/(stem+'.md')).write_text('# 缺失尾段原始转写（未校对，不作出题依据）\n\n'+raw[start:],encoding='utf-8')
            tail=raw[start:].replace('\r\n','\n')
            tailApplied=[]
            for old,new in TAIL_PATCHES[n]:
                pat=(r'(?<![A-Za-z])' if old[0].isascii() and old[0].isalpha() else '')+re.escape(old)+(r'(?![A-Za-z])' if old[-1].isascii() and old[-1].isalpha() else '')
                hits=list(re.finditer(pat,tail))
                if not hits:continue
                contexts=[tail[max(0,m.start()-35):m.end()+55] for m in hits]
                tail=re.sub(pat,lambda m:new,tail)
                tailApplied.append({'before':old,'after':new,'occurrences':len(hits),'contextBefore':contexts,'source':'restored-raw-tail'})
                total+=len(hits)
            # HTML entity decoding is presentation cleanup, not an extra lexical correction.
            import html
            tail=html.unescape(tail)
            s=s.rstrip()+tail+'\n'
            applied.extend(tailApplied)
            (AUDIT/('reviewed-tail-'+stem+'.md')).write_text('# 补回尾段：本地文字复核，未听音\n\n'+tail,encoding='utf-8')
            tailWords={2:['inedible','horticulture','arduous','graduate','assiduous','competition','commemorate','communication','combine','computer','aggravate','illuminate','illuminating','luminary','lunar','accumulate','cumuli','abbreviate','assimilation'],6:['prescribe','prescription','prolong','prolonged','promote','promotion','proliferate','proliferation','prominent','eminent','former','foremost','forecast','forecaster','foretell','foresee','postwar','postgraduate','postpone','return','reject','reduce','rocket','soar','surge','boom','plummet','rejuvenate','reverberate','reverberation','reverberant','resent','resentful','sentence','consent','consensus','interact','interval','interfere','middle','midday','midnight','immediate','immediately','Mediterranean']}[n]
            newWords=[w for w in tailWords if w.lower() not in {v.lower() for v in inv['words']} and norm(w) in norm(tail)]
            inv['words'].extend(newWords)

        note='> **本地文字复核 · 2026-10-07**：检查范围为来源结构、英文词项/短语及疑点上下文；未逐句听音。原稿另存，不覆盖。以下注记是复核者的说明，不是老师原话。\n>\n'
        note+='\n'.join('> - '+x for x in NOTES[n])+'\n>\n> 后续出题必须跳过未确认片段；记忆联想不等于已证实的词源规律。\n\n'
        # Keep review metadata outside the teacher body for downstream consumers.
        s=re.sub(r'^source:.*$', 'source: 原始转写与本地文字复核（未听音）', s, flags=re.M, count=1)
        s=re.sub(r'^(---[\s\S]*?---\n*)',lambda m:m.group(0)+note,s,count=1)
        reviewed=s.encode('utf-8');(OUT/name).write_bytes(reviewed)
        inv['sourceReview']={'version':'2026-10-07.local-text-v1','reviewer':'Codex local text review','audioVerified':False,'fullChineseLineReview':False,'reviewedSha256':sha(reviewed),'sourceSha256':c['sha256'],'rawSourceSha256':sha((ROOT/f'build/scripts-raw/ndf-01-{n:02d}.txt').read_bytes()),'notes':NOTES[n],'sourceIncomplete':False,'restoredTailFromRaw':n in [2,6], 'generationReady':False,'generationHoldReason':'复核注记中仍有待确认片段/教学断言；尚未逐考点确认，不自动重新生成课后练。'}
        (OUT/(stem+'.words.json')).write_text(json.dumps(inv,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        c.update(status='local-lexical-and-source-review-with-pending',reviewedSha256=sha(reviewed),excludedPrefixChars=removed,correctionOccurrences=sum(x['occurrences'] for x in applied),audioVerified=False,fullChineseLineReview=False)
        manifest.append({'lesson':n,'file':name,'sourceSha256':c['sha256'],'reviewedSha256':sha(reviewed),'rawSourceSha256':sha((ROOT/f'build/scripts-raw/ndf-01-{n:02d}.txt').read_bytes()),'restoredRawTailStart':start if n in [2,6] else None,'restoredRawTailChars':len(raw[start:]) if n in [2,6] else 0,'tailInventoryAdditions':newWords if n in [2,6] else [],'sourceChars':len(original.decode('utf-8')),'excludedPrefixChars':removed,'patches':applied,'unmatchedPatchCandidates':absent,'removedInventoryItems':removedwords,'notes':NOTES[n],'sourceIncomplete':False,'restoredTailFromRaw':n in [2,6]})
    (AUDIT/'coverage.json').write_text(json.dumps(coverage,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    (AUDIT/'correction-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'lessons':len(manifest),'correctionOccurrences':total,'changedLessons':sum(bool(x['patches']) for x in manifest),'excludedPrefixes':len(excluded),'excludedChars':sum(x['excludedPrefixChars'] for x in manifest),'removedInventoryItems':sum(len(x['removedInventoryItems']) for x in manifest),'unmatchedCandidates':{x['lesson']:x['unmatchedPatchCandidates'] for x in manifest if x['unmatchedPatchCandidates']}},ensure_ascii=False))
if __name__=='__main__':main()
