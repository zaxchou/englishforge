"""Local integration checks: isolated records/build, fake local-only AI endpoint."""
from pathlib import Path
import json, re, hashlib, shutil, subprocess, os, time, urllib.request, urllib.error
ROOT=Path(__file__).resolve().parents[1]
AUDIT=ROOT/'docs/transcript-review-2026-10-07'
NODE=Path('C:/Users/zeroz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    manifest=json.loads((AUDIT/'correction-manifest.json').read_text('utf-8'))
    src=ROOT.parent/'新D方/新D方新托福全套/01 托福词汇课 孙曦/逐字稿'
    fixture=AUDIT/'test-fixture';fixture.mkdir(exist_ok=True)
    build=fixture/'build';(build/'courses').mkdir(parents=True,exist_ok=True)
    shutil.copy2(ROOT/'build/courses/catalog.json',build/'courses/catalog.json')
    shutil.copytree(ROOT/'build/scripts-reviewed',build/'scripts-reviewed',dirs_exist_ok=True)
    records=fixture/'records';records.mkdir(exist_ok=True)
    production=ROOT.parent/'data/toefl-lab-production/records/generated-quizzes.json'
    before=digest(production);shutil.copy2(production,records/'generated-quizzes.json')
    env=dict(os.environ,TFL_AI_KEY='local-test-not-a-secret',TFL_AI_BASE_URL='http://127.0.0.1:9',TFL_TLS_KEY='',TFL_TLS_CERT='')
    log=(fixture/'server.log').open('w',encoding='utf-8')
    proc=subprocess.Popen([str(NODE),str(ROOT/'server.mjs'),'--port','8027','--records',str(records),'--build',str(build)],cwd=str(ROOT),env=env,stdout=log,stderr=log)
    def request(path,data=None):
        req=urllib.request.Request('http://127.0.0.1:8027'+path,data=json.dumps(data).encode() if data is not None else None,headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(req,timeout=4) as r:return r.status,json.load(r)
        except urllib.error.HTTPError as e:return e.code,json.load(e)
    try:
        for _ in range(60):
            if proc.poll() is not None:raise RuntimeError('server exited; see fixture/server.log')
            try:
                if request('/api/health')[0]==200:break
            except OSError:time.sleep(.15)
        else:raise RuntimeError('server not ready')
        for x in manifest:
            n=x['lesson'];lesson=f'ndf-01-{n:02d}'
            assert digest(src/x['file'])==x['sourceSha256']
            assert digest(AUDIT/'originals'/x['file'])==x['sourceSha256']
            reviewed=ROOT/'build/scripts-reviewed/ndf-01'/x['file']
            assert digest(reviewed)==x['reviewedSha256']
            code,j=request('/api/lesson-script/'+lesson);assert code==200,(lesson,code,j)
            assert j['md']==re.sub(r'^---[\s\S]*?---\n*','',reviewed.read_text('utf-8')).strip()
            assert j['md'].startswith('> **本地文字复核')
            assert j['inv']['sourceReview']['reviewedSha256']==x['reviewedSha256']
            assert not j['inv']['sourceReview']['generationReady']
            code,q=request('/api/ai/quiz',{'lessonId':lesson});assert code==200 and q['cached'],(lesson,code,q)
            code,j=request('/api/ai/quiz',{'lessonId':lesson,'force':True});assert code==409 and '暂停新题生成' in j['error'],(lesson,code,j)
        # Regression: demonstrated errors remain examples rather than silently rewritten.
        md4=next((build/'scripts-reviewed/ndf-01').glob('04 *.md')).read_text('utf-8')
        assert 'many people are poor and hunger' in md4
        assert 'people are poverty' in md4
        f=next((build/'scripts-reviewed/ndf-01').glob('01 *.md'));f.write_text(f.read_text('utf-8')+'\n签名漂移测试',encoding='utf-8')
        code,j=request('/api/ai/quiz',{'lessonId':'ndf-01-01','force':True});assert code==409 and '签名不一致' in j['error']
        assert digest(production)==before
        result={'localOnly':True,'lessonScriptChecks':48,'cachedQuizChecks':48,'freshGenerationHeldBeforeModelCall':48,'signatureDriftRejected':True,'teachingWrongExamplesPreserved':True,'originalMdHashesUnchanged':48,'productionQuizSha256Unchanged':before,'audioVerified':False,'fullChineseLineReview':False}
        (AUDIT/'local-verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');print(json.dumps(result,ensure_ascii=False))
    finally:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
        log.close()
if __name__=='__main__':main()
