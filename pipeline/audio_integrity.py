"""Audio reference checks; filename checks do not prove semantic correspondence."""
import re
from pathlib import Path

def audio_subject(ref):
    ref = str(ref or '').replace(chr(92), '/').lower()
    if re.search(r'speaking|\bspeak\b|口语', ref): return 'speaking'
    if re.search(r'listening|\blisten\b|听力', ref): return 'listening'
    return None

def check_audio_ref(ref, subject, task=None, no=None):
    actual = audio_subject(ref)
    if actual and actual != subject: return '引用了另一科的音频'
    if subject == 'speaking':
        m = re.search(r'speaking_(listen_repeat|take_interview)_q0*(\d+)(?:\D|$)', str(ref), re.I)
        if m:
            expected = {'TASK1': 'listen_repeat', 'TASK2': 'take_interview'}.get(task)
            if expected and m[1].lower() != expected: return '口语任务类型与音频不一致'
            if no is not None and int(m[2]) != int(no): return '口语题号与音频不一致'
    return None

def sanitize_speaking(rec, base):
    base=Path(base)
    files=[p for p in base.rglob('*') if p.is_file() and p.suffix.lower() in {'.mp3','.m4a','.wav','.ogg'} and not p.name.startswith('._')]
    tasks=rec.get('subjects',{}).get('speaking',{}).get('tasks',[])
    changes=[]
    for t in tasks:
        for it in t.get('items',[]):
            old=it.get('audio');ref=str(old or '').replace(chr(92),'/')
            reason=check_audio_ref(ref,'speaking',t.get('task'),it.get('no')) if ref else None
            valid=bool(ref) and (base/ref).is_file() and not reason
            if not valid and ref and not reason:
                matches=[p for p in files if p.name.lower()==Path(ref).name.lower()]
                if len(matches)==1:
                    candidate=matches[0].relative_to(base).as_posix()
                    if not check_audio_ref(candidate,'speaking',t.get('task'),it.get('no')):ref=candidate;valid=True
            if not valid:
                kind={'TASK1':'listen_repeat','TASK2':'take_interview'}.get(t.get('task'))
                pattern=re.compile(r'^speaking_'+str(kind)+r'_q0*'+str(it.get('no'))+r'\.(mp3|m4a|wav|ogg)$',re.I)
                matches=[p for p in files if kind and pattern.match(p.name)]
                if len(matches)==1:ref=matches[0].relative_to(base).as_posix();valid=True
            it['audio']=ref if valid else None
            if not valid:it['audio_issue']=reason or '源目录未找到可确认对应的口语音频；不以听力或其他题录音代替'
            else:it.pop('audio_issue',None)
            if old!=it['audio']:changes.append({'task':t.get('task'),'no':it.get('no'),'before':old,'after':it['audio']})
    counts={}
    for t in tasks:
        for it in t.get('items',[]):
            if it.get('audio'):counts[it['audio']]=counts.get(it['audio'],0)+1
    for t in tasks:
        for it in t.get('items',[]):
            ref=it.get('audio');it['audio_module_level']=bool(ref and counts.get(ref,0)>1 and not re.search(r'_q\d+',ref,re.I))
    return changes


def apply_audio_evidence(rec, base):
    """Explicitly reviewed whole recordings only; preserve ASR/human boundaries."""
    import json, hashlib
    index=Path(__file__).with_name('static-audio-evidence.json')
    entry=json.loads(index.read_text(encoding='utf-8')).get(rec.get('set_id')) if index.exists() else None
    if not entry: return False
    base=Path(base).resolve(); source=(base/entry['file']).resolve()
    tasks=rec.get('subjects',{}).get('speaking',{}).get('tasks',[])
    def reject():
        for task in tasks:
            for item in task.get('items',[]):
                if item.get('audio_evidence'):
                    item['audio']=None;item['audio_module_level']=False
                    item['audio_issue']='源录音或任务版本与核对证据不符，已隔离待重新核对'
                    for k in ['audio_evidence','audio_cue','prompt_source']:item.pop(k,None)
        return False
    if not source.is_relative_to(base) or not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest()!=entry['sha256']:return reject()
    if any(not any(t.get('task')==key and required.lower() in t.get('instruction','').lower() for t in tasks) for key,required in entry['required_instructions'].items()):return reject()
    for task in tasks:
        for item in task.get('items',[]):
            if check_audio_ref(entry['file'],'speaking',task.get('task'),item.get('no')): continue
            item['audio']=entry['file'];item['audio_module_level']=True;item.pop('audio_issue',None)
            item['audio_evidence']={k:entry[k] for k in ['method','human_verified','scope']}
            interview=entry['interview'].get(str(item.get('no'))) if task.get('task')=='TASK2' else None
            if interview:
                item['prompt']=interview['prompt'];item['prompt_source']='原录音离线转写（可能存在识别误差，可回听核对）';item['audio_cue']=interview['cue']
        if task.get('task')=='TASK2':task['note']='四个问句由原录音离线转写恢复；整份录音包含回答空白。跳转点是 ASR 辅助定位，不是精确裁剪或人工审签。'
    return True
