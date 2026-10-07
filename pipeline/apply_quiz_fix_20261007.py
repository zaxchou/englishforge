"""Run only with the toefl-lab container stopped. CAS, backups, atomic replacement."""
import argparse,hashlib,json,os,shutil,datetime
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--records',type=Path,required=True);p.add_argument('--bundle',type=Path,required=True);p.add_argument('--expected',required=True);a=p.parse_args()
r=a.records.resolve();b=a.bundle.resolve();target=r/'generated-quizzes.json';raw=target.read_bytes()
if hashlib.sha256(raw).hexdigest()!=a.expected:raise SystemExit('Production quiz drift: no writes performed')
corrected=json.loads((b/'corrected-quizzes.json').read_text(encoding='utf-8'));manifest=json.loads((b/'patch-manifest.json').read_text(encoding='utf-8'));assert len(manifest)==83
before=json.loads(raw.decode('utf-8-sig'));fixed={}
for m in manifest:fixed.setdefault(m['lesson'],set()).add(m['id'])
for lesson,ids in fixed.items():corrected['items'][lesson]['bad']=[q for q in corrected['items'][lesson].get('bad',[]) if q not in ids]
for lesson,v in before['items'].items():
 assert len(v['questions'])==len(corrected['items'][lesson]['questions'])
 for old,new in zip(v['questions'],corrected['items'][lesson]['questions']):
  assert old['id']==new['id']
  if old['id'] not in fixed.get(lesson,set()):assert old==new
stamp=datetime.datetime.now().strftime('%Y%m%d-%H%M%S');backup=r/'backups'/('quiz-fix-83-'+stamp);backup.mkdir(parents=True,exist_ok=False)
shutil.copy2(target,backup/target.name);shutil.copy2(b/'patch-manifest.json',backup/'patch-manifest.json')
records=r/'records.json';records_hash=hashlib.sha256(records.read_bytes()).hexdigest() if records.exists() else None
if records.exists():shutil.copy2(records,backup/records.name)
def atomic(path,data):
 tmp=path.with_name(path.name+'.quiz-fix.tmp')
 with tmp.open('w',encoding='utf-8') as f:json.dump(data,f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
 os.replace(tmp,path)
# Cache first: if replacement fails, cache loss is harmless and quizzes remain old.
cache=r/'ai-explanations.json';removed=0
if cache.exists():
 shutil.copy2(cache,backup/cache.name);data=json.loads(cache.read_text(encoding='utf-8-sig'));ids={m['recordId'] for m in manifest}
 for key in ids:
  if key in data.get('items',{}):del data['items'][key];removed+=1
 atomic(cache,data)
atomic(target,corrected)
assert records_hash==(hashlib.sha256(records.read_bytes()).hexdigest() if records.exists() else None)
print(json.dumps({'backup':str(backup),'changedQuestions':83,'removedStaleAICache':removed,'recordsUntouched':True,'productionSha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
