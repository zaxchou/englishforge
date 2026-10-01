from pathlib import Path
import json
r=Path(r'Z:\BaiduNetdiskWorkspace\myagent-work\zcode\JunEnglish\sentence-forge\docs\curriculum-v4\design-complete-system')
route='<div class="route">'+''.join(f'<div class="stop {"current" if i==3 else ""}"><span>{i:02d} / {s}</span><b>{t}</b><small>{desc}</small></div>' for i,s,t,desc in [(1,'已跨过','找到句子主线','谁做什么 · 句子骨架'),(2,'已跨过','把信息接起来','修饰与限定 · 关系范围'),(3,'你在这里','跟上复杂表达','嵌套与逻辑 · 声音切块'),(4,'下一段','组织自己的话','复述 · 理由 · 澄清'),(5,'将会抵达','参与真实讨论','课堂互动 · 观点回应'),(6,'持续生长','处理专业语境','艺术科技 · 学术论证')])+'</div>'
read=lambda f:(r/f).read_text(encoding='utf-8-sig')
candidates=[]
for id,name,brand,fonts,palette,concept,traits in [
('atlas','学习地图','Sentence Forge<small>ENGLISH / ATLAS</small>','Georgia / 宋体标题；微软雅黑正文；Courier New 编号。59px主标题，16px正文。',['#F5F2E9','#233A2E','#306448'],'像打开自己的学习图册，先看清位置，再知道训练如何接近目的地。',['通栏书页标题与六段路线','绿色细线、无圆角任务行','知识位置优先，作品提供成长证据']),
('studio','表达工作室','FORGE / STUDIO','Bahnschrift 英文与标题；微软雅黑中文；Consolas编号。52px标题，36px语言片段。',['#17191F','#C0A8F7','#F2F1F8'],'像进入练习工作室，以真实回应为主角，地图为每个动作提供方向。',['任务台与纵向理解/输出/迁移','紫色语言片段与声音节奏','技能与作品在工作台下方展开']),
('quest','成长关卡','FORGE<em> →</em>','Trebuchet MS / 等线；粗标题与大节点数字。48px挑战标题，17px正文。',['#2456DC','#EEF2FA','#FFCBAF'],'每次挑战跨过一个真实表达障碍，路线和新情境作品组成有依据的过关感。',['阶段轨迹与蓝色通栏挑战','四步横向行动条','过关看作品和迁移，不看题量积分'])]:
    header=f'<header><a href="#today">{brand}</a><nav aria-label="学习导航"><button class="on" data-go="today">今天</button><button data-go="map">学习地图</button><button data-go="evidence">我的能力</button><button data-go="growth">成长作品</button></nav><span class="muted" style="font-size:12px">{name}</span></header>'
    html='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+name+' · Sentence Forge</title><style>'+read('common.css')+read(id+'.css')+'</style></head><body>'+header+'<main>'+read(id+'-home.html').replace('{{route}}',route)+read('screens.html').replace('{{route}}',route)+'</main><script>'+read('interaction.js')+'</script></body></html>'
    (r/(id+'.html')).write_text(html,encoding='utf-8')
    candidates.append(dict(id=id,name=name,concept=concept,typography=fonts,palette=palette,traits=traits,kind='html',source=id+'.html',interactive=True))
manifest=dict(schemaVersion=1,project='Sentence Forge · 完成体学习系统',brief='展示当前位置、训练理由、任务体验、能力证据与下一站。三个方向表达同一学习任务，字体、配色和首屏构图分别设计。',round='完成态 01',candidates=candidates)
(r/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
print('Three standalone candidates ready')
