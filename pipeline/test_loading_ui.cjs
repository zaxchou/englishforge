'use strict';
// 统一加载态回归(2026-11-16): 所有「正在读取…」提示必须共用 .tfl-loading 组件,
// 两套样式体系都要定义 spinner + keyframes + reduced-motion 兜底。
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=f=>fs.readFileSync(path.join(root,f),'utf8');

const MARKUP=['web/index.html','web/course-plan-ui.js','web/lesson-vocab-ui.js',
  'web/root-practice-ui.js','root-universe/public/app.js','root-universe/public/index.html'];

test('every loading prompt uses the shared tfl-loading component',()=>{
  let count=0;
  for(const f of MARKUP){
    const s=read(f);
    const re=/正在读取[^<'`<]*/g;
    let m;
    while((m=re.exec(s))){
      const lineStart=s.lastIndexOf('\n',m.index)+1;
      const lineEnd=s.indexOf('\n',m.index);
      const line=s.slice(lineStart,lineEnd<0?s.length:lineEnd);
      assert.match(line,/tfl-loading/,`${f}: loading prompt without shared class: ${m[0]}`);
      count++;
    }
  }
  assert.ok(count>=20,`expected all loading prompts, found ${count}`);
});

test('both style systems define the component and reduced-motion fallback',()=>{
  for(const f of ['web/desk.css','root-universe/public/style.css']){
    const css=read(f);
    assert.match(css,/\.tfl-loading\{display:inline-flex;align-items:center;gap:9px\}/,f);
    assert.match(css,/\.tfl-loading>i\{[^}]*border-top-color:var\(--/ ,f);
    assert.match(css,/@keyframes tfl-spin\{to\{transform:rotate\(360deg\)\}\}/,f);
    assert.match(css,/prefers-reduced-motion[\s\S]*?\.tfl-loading>i\{animation:none/,f);
  }
});

test('spinner markup is aria-hidden so screen readers keep the status text only',()=>{
  for(const f of MARKUP){
    const s=read(f);
    for(const m of s.matchAll(/<i(?![^>]*aria-hidden="true")[^>]*><\/i>/g)){
      // Only constrain <i> emitted next to a loading prompt.
      const near=s.slice(Math.max(0,m.index-160),m.index+180);
      if(near.includes('正在读取'))assert.fail(`${f}: spinner <i> missing aria-hidden`);
    }
  }
});
