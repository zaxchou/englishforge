"""Render local PDF handouts into reproducible reader images; never edit source files.
Run while the local read-only media service is running: --base http://localhost:8028
"""
import argparse,hashlib,json,urllib.request,urllib.parse
from pathlib import Path
import fitz
ROOT=Path(__file__).resolve().parents[1]
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--base',default='http://localhost:8028');args=ap.parse_args()
 cat=json.loads((ROOT/'build/courses/catalog.json').read_text(encoding='utf-8'));manifest=[]
 for series in cat['series']:
  for course in series['courses']:
   if not course.get('lessons'):continue
   files=course.get('handout_pdfs')or[]
   for nid in course.get('notes_ids')or[]:
    nf=ROOT/'build/courses/notes'/(nid+'.json')
    if not nf.exists():continue
    note=json.loads(nf.read_text(encoding='utf-8'));filename=note.get('source_file','')
    if note.get('kind')!='pdf' or filename not in files:continue
    url=args.base+course['lessons'][0]['video'].rsplit('/',1)[0]+'/'+urllib.parse.quote(filename)
    with urllib.request.urlopen(url,timeout=90)as r:raw=r.read()
    target=ROOT/'build/courses/slide_images'/nid;target.mkdir(parents=True,exist_ok=True)
    with fitz.open(stream=raw,filetype='pdf')as doc:
     for ix,page in enumerate(doc):
      dest=target/('p%04d.jpg'%(ix+1));pix=page.get_pixmap(matrix=fitz.Matrix(1.7,1.7),alpha=False);pix.save(str(dest),jpg_quality=84)
     manifest.append(dict(id=nid,source_file=filename,sha256=hashlib.sha256(raw).hexdigest(),pages=len(doc)));print(nid,len(doc),'pages')
 (ROOT/'build/courses/reader-pages.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
if __name__=='__main__':main()
