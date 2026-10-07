"""Read-only offline quiz audit. No AI calls or production writes.
Warnings require review; absence of warnings does NOT certify semantic correctness.
Usage: python pipeline/audit_generated_quizzes.py INPUT --out DIR [--findings JSON]
"""
import argparse, collections, hashlib, json, re, unicodedata
from pathlib import Path

def norm(s):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(s))).strip().casefold()

def contains(text, term):
    text, term = norm(text), norm(term)
    if not term: return False
    if re.fullmatch(r"[a-z][a-z '-]*", term):
        return bool(re.search(r'(?<![a-z])'+re.escape(term)+r'(?![a-z])',text))
    return len(term)>=2 and term in text

def check(q):
    errors, flags = [], []
    if not isinstance(q,dict): return ['question_not_object'], []
    opts=q.get('options')
    if not isinstance(opts,dict) or set(opts)!=set('ABCD'):
        return ['exactly_four_ABCD_options_required'], []
    if q.get('answer') not in ('A','B','C','D'): errors.append('answer_must_be_exact_ABCD')
    texts=[]
    for o in opts.values():
        if not isinstance(o,dict) or not isinstance(o.get('t'),str) or not norm(o['t']):
            errors.append('nonempty_option_text_required'); continue
        texts.append(norm(o['t']))
        if not isinstance(o.get('note'),str) or not norm(o['note']): errors.append('each_option_needs_note')
    if len(set(texts))!=len(texts): errors.append('duplicate_option_text')
    for f in ('id','stem','explain'):
        if not isinstance(q.get(f),str) or not norm(q[f]): errors.append('nonempty_'+f+'_required')
    if q.get('type') not in ('root','meaning','cloze','collocation'): errors.append('unknown_type')
    for f in ('tags','covers'):
        if not isinstance(q.get(f,[]),list) or not all(isinstance(t,str) for t in q.get(f,[])): errors.append('invalid_'+f)
    if errors: return sorted(set(errors)), []
    stem=q['stem']; answer=opts[q['answer']]['t']; tags=q.get('tags',[])
    if any(norm(answer)==norm(t) for t in tags): flags.append('preanswer_tag_equals_answer')
    elif any(contains(t,answer) for t in tags): flags.append('preanswer_tag_contains_answer')
    if contains(stem,answer):
        if q['type']=='cloze' or not re.fullmatch(r"[a-z '-]+",norm(answer)): flags.append('answer_text_in_stem_review')
        elif re.search(r'同|哪个词|which word|another',stem,re.I): flags.append('self_comparison_review')
    notes=' '.join(o['note'] for o in opts.values())+' '+q['explain']
    if re.search(r'(?:本节|课堂|老师).{0,8}(?:未|没|没有).{0,8}(?:讲|涉及|提)|未重点讲解|更直接对应本节|不是课堂|超纲',notes): flags.append('scope_as_wrong_reason_review')
    wrong=' '.join(o['note'] for k,o in opts.items() if k!=q['answer'])
    if re.search(r'更贴切|更准确|本项虽正确|虽也表|虽然可以|更完整覆盖|不是最佳答案',wrong): flags.append('competing_correct_option_review')
    if re.search(r'划线词|下划线词|underlined word',stem,re.I): flags.append('target_rendering_review')
    if re.search(r'\bto\s+_{2,}',stem,re.I) and re.fullmatch('[a-z]+ing',norm(answer)): flags.append('to_ing_grammar_review')
    if re.search(r'\ba\s+_{2,}\s+society\b',stem,re.I) and norm(answer).endswith('archy'): flags.append('noun_in_adjective_slot_review')
    if any('**' in o['t'] or '__' in o['t'] for o in opts.values()): flags.append('markdown_option_rendering_review')
    if q.get('tier') not in ('core','ext'): flags.append('tier_missing_or_unknown')
    if not q.get('covers'): flags.append('coverage_not_declared')
    return [], sorted(set(flags))

def audit(raw,findings=()):
    items=json.loads(raw.decode('utf-8-sig'))['items']; rows=[]; lessons=[]
    manual={(f['lesson'],f['id']):f for f in findings}
    for lesson,quiz in sorted(items.items()):
        seen_ids=set(); seen_stems={}; blanks={}; local=[]
        for q in quiz['questions']:
            errors,flags=check(q); qid=q.get('id') if isinstance(q,dict) else None
            if qid in seen_ids: errors.append('duplicate_id')
            seen_ids.add(qid)
            if isinstance(q,dict) and isinstance(q.get('stem'),str):
                key=re.sub(r'[\W_]+','',norm(q['stem']))
                if key in seen_stems: flags.append('duplicate_stem:'+str(seen_stems[key]))
                seen_stems[key]=qid
                segments=re.findall(r"[A-Za-z][A-Za-z0-9\s_'’\"“”,;:()\-.]*_{2,}[A-Za-z0-9\s_'’\"“”,;:()\-.]*",q['stem'])
                if segments:
                    blank=re.sub(r'[\W_]+','',norm(max(segments,key=len)))
                    if len(blank)>20:
                        if blank in blanks: flags.append('repeated_blank_sentence:'+str(blanks[blank]))
                        blanks[blank]=qid
            finding=manual.get((lesson,qid))
            sig=hashlib.sha256(json.dumps(q,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
            if finding and finding.get('questionSha256') != sig:
                raise ValueError(f'Stale or unsigned finding: {lesson}/{qid}')
            row={'lesson':lesson,'id':qid,'recordId':f"gen/{quiz.get('course')}/{quiz.get('lessonNo')}/quiz/{str(qid)[1:]}",
                'questionSha256':sig,
                'structuralErrors':sorted(set(errors)),'reviewWarnings':sorted(set(flags)),
                'semanticStatus':'confirmed_problem' if finding else 'not_certified','finding':finding}
            rows.append(row); local.append(row)
        lessons.append({'lesson':lesson,'title':quiz.get('title'),'questions':len(local),
            'structuralFailures':sum(bool(r['structuralErrors']) for r in local),
            'warningQuestions':sum(bool(r['reviewWarnings']) for r in local),
            'confirmedProblems':sum(bool(r['finding']) for r in local)})
    missing=set(manual)-{(r['lesson'],r['id']) for r in rows}
    if missing: raise ValueError('Findings reference absent questions: '+str(missing))
    return {'inputSha256':hashlib.sha256(raw).hexdigest(),'lessons':lessons,'questions':rows,'summary':{
        'lessons':len(lessons),'questions':len(rows),'structuralFailureQuestions':sum(bool(r['structuralErrors']) for r in rows),
        'warningQuestions':sum(bool(r['reviewWarnings']) for r in rows),'confirmedProblemQuestions':sum(bool(r['finding']) for r in rows),
        'warningsByCode':dict(collections.Counter(f.split(':')[0] for r in rows for f in r['reviewWarnings'])),
        'semanticPassNotImplied':True}}

def main():
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('input',type=Path); p.add_argument('--out',type=Path,required=True); p.add_argument('--findings',type=Path)
    a=p.parse_args(); source=a.input.resolve(); out=a.out.resolve()
    if source==out or source.is_relative_to(out): p.error('Output cannot replace input or its ancestor')
    findings=json.loads(a.findings.read_text(encoding='utf-8-sig')) if a.findings else []
    result=audit(source.read_bytes(),findings); out.mkdir(parents=True,exist_ok=True)
    (out/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    lines=['# 全量课后练扫描账本','','机械扫描不等于语义通过；not_certified 不是发布认证。','','```json',json.dumps(result['summary'],ensure_ascii=False,indent=2),'```','','| 课程 | 题数 | 结构失败 | 有风险提示 | 已确认问题 |','| --- | ---: | ---: | ---: | ---: |']
    for v in result['lessons']: lines.append(f"| {v['lesson']} | {v['questions']} | {v['structuralFailures']} | {v['warningQuestions']} | {v['confirmedProblems']} |")
    (out/'audit-summary.md').write_text('\n'.join(lines)+'\n',encoding='utf-8'); print(json.dumps(result['summary'],ensure_ascii=False))
    return 2 if result['summary']['structuralFailureQuestions'] else 0
if __name__=='__main__': raise SystemExit(main())
