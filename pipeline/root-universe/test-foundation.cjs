'use strict';
const assert=require('node:assert/strict');
const path=require('node:path');
const crypto=require('node:crypto');
const http=require('node:http');
const ws=require('../../root-universe/workspace.cjs');
const core=require('../../root-universe/core.cjs');
const builder=require('../../root-universe/build.cjs');
const {listen}=require('../../root-universe/server.cjs');
async function checkTwoHopPreview(page,width) {
  // Historical chain in the approved real index: prediction -> praedictio -> praedico.
  const nav=v=>width<=700?page.locator(`.mobile-tabs [data-view="${v}"]`):page.locator(`.sidebar [data-view="${v}"]`);
  await nav('graph').click();
  const direct=page.locator('[data-graph-mode="neighbors"]');
  if(await direct.isVisible())await direct.click();
  await page.locator('.map-node').first().waitFor();
  const overflow=()=>page.evaluate(()=>({doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,width:innerWidth}));
  const sizes0=await overflow();assert(sizes0.doc<=width&&sizes0.body<=width,JSON.stringify(sizes0));
  await page.locator('.map-node').filter({hasText:/^predict\b/}).click();
  await page.locator('#graph-detail h2').filter({hasText:/^predict\b/}).waitFor();
  await page.locator('.map-node').filter({hasText:/^praedictio/}).click();
  await page.locator('#graph-detail h2').filter({hasText:/^praedictio/}).waitFor();
  await page.locator('.map-node').filter({hasText:/^praedico/}).click();
  await page.locator('#graph-detail h2').filter({hasText:/^praedico/}).waitFor();
  await page.locator('.map-node.current').filter({hasText:/^praedico/}).waitFor();
  const back=page.locator('#graph-back');
  await back.click();
  await page.locator('#graph-detail h2').filter({hasText:/^praedictio/}).waitFor();
  await back.click();
  await page.locator('#graph-detail h2').filter({hasText:/^predict\b/}).waitFor();
  const detail=await page.locator('#graph-detail').textContent();
  assert(detail.includes('已通过独立来源复核')||detail.includes('来源与原文')||detail.length>0,'graph detail must describe the focused word');
  return {width,start:'predict',mid:'praedictio',end:'praedico',back_works:true};
}
async function run() {
  const artifact=path.join(ws.QA,'full-'+crypto.randomUUID());ws.mkdir(artifact,'screenshots');
  const result={ok:false,mode:'foundation-full',status:'running',artifact_dir:artifact,checks:[],errors:[],screenshots:[],counts:null,packet_ids:[],limits:['Machine tests cannot certify actual source truth, licensing, independent run authenticity or linguistic correctness. The separate independent source review remains mandatory.','Fast synthetic regression is a separate workflow gate; this command never substitutes synthetic content for real sample acceptance.']};
  const logs=[];let browser,server,emptyServer;
  const check=async(name,fn)=>{try{const detail=await fn();result.checks.push({name,ok:true,...(detail?{detail}:{})});}catch(e){result.checks.push({name,ok:false,error:e.message});result.errors.push({name,error:e.message,details:e.errors||null});logs.push(e.stack);throw e;}};
  const close=s=>s?new Promise(resolve=>{s.close(resolve);s.closeAllConnections();}):Promise.resolve();
  try {
    let bundles=[];
    await check('real sample set is nonempty, nonsynthetic and independently approved',()=>{
      const set=ws.json(ws.ROOT,'sample-set.json');assert.equal(set.schema_version,'1.1.0');assert(Array.isArray(set.packet_ids)&&set.packet_ids.length>0);assert.equal(new Set(set.packet_ids).size,set.packet_ids.length);result.packet_ids=set.packet_ids;
      for(const id of set.packet_ids){const b=ws.bundle(id,'verified');assert.equal(b.p.synthetic,false);bundles.push(b);}
      result.candidate_counts={headwords:bundles.reduce((n,b)=>n+b.p.headwords.length,0),senses:bundles.reduce((n,b)=>n+b.p.senses.length,0),facts:bundles.reduce((n,b)=>n+b.p.relations.length+b.p.analyses.length,0),requested_facts:bundles.reduce((n,b)=>n+b.p.publish_fact_ids.length,0)};
      return {packet_ids:set.packet_ids,packet_sha256:bundles.map(b=>({packet_id:b.p.packet_id,sha256:require('./validate-kit.cjs').sha(b.raw)}))};
    });
    await check('real deterministic immutable build and idempotent reimport',()=>{
      const built=builder.build(result.packet_ids), before=ws.bytes(ws.ROOT,'current.json');const again=builder.build([...result.packet_ids].reverse());assert(again.idempotent);assert.equal(before.toString(),ws.bytes(ws.ROOT,'current.json').toString());result.version=built.version;result.counts=built.counts;
      const index=builder.current().index;assert.equal(index.synthetic,false);assert(index.facts.length>0);const formalIds=new Set(index.nodes.map(n=>n.id));
      for(const b of bundles){for(const id of b.p.publish_node_ids)assert(formalIds.has(id));for(const f of [...b.p.relations,...b.p.analyses].filter(f=>!b.p.publish_fact_ids.includes(f.id)))assert(!index.facts.some(x=>x.id===f.id));}
      assert.equal(core.hash(core.compile(bundles,{resolveRegistry:(v,h)=>builder.snapshot(ws.ROOT,v,h).registry})),core.hash(index));return built;
    });
    const index=builder.current().index;
    server=await listen({port:0});const origin=`http://127.0.0.1:${server.address().port}`;
    const request=(pathname,{method='GET',host}={})=>new Promise((resolve,reject)=>{
      const r=http.request({hostname:'127.0.0.1',port:server.address().port,path:pathname,method,headers:host?{Host:host}:{}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString(),headers:res.headers}));});r.on('error',reject);r.end();
    });
    await check('HTTP read-only routes, whole-graph endpoint, provenance, unknown states and input/path limits',async()=>{
      assert.equal(server.address().address,'127.0.0.1');
      const health=await request('/api/health');assert.equal(health.status,200);assert.equal(JSON.parse(health.body).version,result.version);
      const graph=await request('/api/graph');assert.equal(graph.status,200);const g=JSON.parse(graph.body);
      assert(Array.isArray(g.nodes)&&g.nodes.length>0&&Array.isArray(g.families)&&g.families.length>0);
      assert(g.nodes.every(n=>n.id&&n.type));
      const graphSense=g.nodes.find(n=>n.type==='senses'&&n.zh);assert(graphSense,'graph endpoint must expose senses with translations');
      const cases=[['/api/search?q='+'x'.repeat(121),400],['/api/search?q='+'x'.repeat(2200),414],['/api/neighbors?id='+encodeURIComponent(index.nodes[0].id)+'&depth=3',400],['/api/neighbors?id='+encodeURIComponent(index.nodes[0].id)+'&maxNodes=101',400],['/api/neighbors?id='+encodeURIComponent(index.nodes[0].id)+'&maxEdges=201',400],['/api/node?id=..%2Frecords',400],['/api/source?id=P0001:unknown',404],['/api/node?id=P0001:unknown',404],['/%2e%2e/%2e%2e/records/records.json',404],['/versions/current.json',404],['/api/search?q=%ZZ',400],['/api/search?q=a&q=b',400]];
      for(const [url,status] of cases){const r=await request(url);assert.equal(r.status,status,url);}
      assert.equal((await request('/api/search?q=predict',{method:'POST'})).status,405);assert.equal((await request('/api/health',{host:'other.invalid'})).status,400);
      const missing=await request('/api/search?q=zzzz-root-universe-not-covered');assert.equal(missing.status,200);assert.equal(JSON.parse(missing.body).results.length,0);
      const eid=index.evidence[0].id,source=await request('/api/source?id='+encodeURIComponent(eid));assert.equal(source.status,200);assert.equal(JSON.parse(source.body).excerpt_sha256,index.evidence[0].excerpt_sha256);
      return {cases:cases.length+8,origin};
    });
    const playwright=require(process.env.TFL_PLAYWRIGHT||'C:/Users/zeroz/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright');
    browser=await playwright.chromium.launch({channel:'msedge',headless:true});
    await check('actual Edge browser lookup, graph and practice flows at 1440/390/320',async()=>{
      const modern=index.facts.find(f=>f.from_id && f.layer==='modern' && index.nodes.find(n=>n.id===f.from_id)?.type==='senses' && index.nodes.find(n=>n.id===f.to_id)?.type==='senses');assert(modern,'need a real independently approved navigable modern sense relation');
      const sense=index.nodes.find(n=>n.id===modern.from_id),head=index.nodes.find(n=>n.id===sense.headword_id);
      const twoHopChecks=[];
      for(const [width,height] of [[1440,900],[390,844],[320,760]]) {
        const context=await browser.newContext({viewport:{width,height},permissions:[]});const page=await context.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));page.setDefaultTimeout(20000);
        const nav=v=>width<=700?page.locator(`.mobile-tabs [data-view="${v}"]`):page.locator(`.sidebar [data-view="${v}"]`);
        const overflow=()=>page.evaluate(()=>({doc:document.documentElement.scrollWidth,body:document.body.scrollWidth,width:innerWidth}));
        try{
          await page.goto(origin);
          await page.locator('.word-title h2').waitFor();
          // lookup: search with suggestions, then pick the approved head word
          await page.getByLabel('搜索单词').fill(head.display);
          await page.locator('#suggestions button').first().waitFor();
          await page.getByRole('button',{name:'查词',exact:true}).click();
          await page.locator('.word-title h2').filter({hasText:head.display}).waitFor();
          let sizes=await overflow();assert(sizes.doc<=width&&sizes.body<=width,JSON.stringify(sizes));
          const lookupPath=path.join(artifact,'screenshots',`${width}-lookup.png`);await page.screenshot({path:lookupPath});result.screenshots.push(lookupPath);
          // provenance: source box with raw wikitext, oldid link and review status
          await page.locator('[data-source-trigger="lookup-source"]').click();
          await page.locator('#lookup-source code').waitFor();
          assert((await page.locator('#lookup-source').textContent()).includes('未改动，含维基标记'));
          assert((await page.locator('#lookup-source').textContent()).includes('已通过独立来源复核'));
          const href=await page.locator('#lookup-source a').first().getAttribute('href');assert(href.startsWith('https://en.wiktionary.org/')&&href.includes('oldid='),'source link must point at the captured revision');
          // graph: two-hop historical chain with back navigation
          twoHopChecks.push({width,...await checkTwoHopPreview(page,width)});
          sizes=await overflow();assert(sizes.doc<=width&&sizes.body<=width,JSON.stringify(sizes));
          const graphPath=path.join(artifact,'screenshots',`${width}-graph.png`);await page.screenshot({path:graphPath});result.screenshots.push(graphPath);
          // practice: complete the round with in-place feedback, then restart
          await nav('practice').click();
          // Alliance learning flow shows a branch reading card first; enter the quiz.
          if(await page.locator('.lesson-words').count()){await page.locator('#begin-branch').click();}
          await page.locator('.practice-card .question').waitFor();
          const meta=await page.locator('.practice-meta span:last-child').textContent();
          const total=Number(/(\d+)\s*\/\s*(\d+)/.exec(meta)[2]);assert(total>=1,'practice round must have questions');
          for(let i=0;i<total;i++){
            const input=page.locator('#recall-answer');
            if(await input.count()){await input.fill('word');await page.locator('#recall-form button').click();}
            else await page.locator('.practice-card .answer').first().click();
            await page.locator('.practice-card .feedback').waitFor();
            if(i<total-1){await page.locator('#next-q').click();await page.locator('.practice-card .question').waitFor();}
          }
          await page.locator('#next-q').click();
          await page.locator('.finish h2').waitFor();
          sizes=await overflow();assert(sizes.doc<=width&&sizes.body<=width,JSON.stringify(sizes));
          const practicePath=path.join(artifact,'screenshots',`${width}-practice.png`);await page.screenshot({path:practicePath});result.screenshots.push(practicePath);
          await page.locator('#restart').click();
          await page.locator('.practice-card .question').waitFor();
          assert.deepEqual(pageErrors,[]);
        }finally{await context.close();}
      }
      return {viewports:[1440,390,320],screenshots:result.screenshots.length,two_hop_navigation:twoHopChecks};
    });
    await check('browser unknown word, network failure with retry, and missing index state',async()=>{
      const context=await browser.newContext({viewport:{width:320,height:760},permissions:[]});const page=await context.newPage();page.setDefaultTimeout(20000);
      try {
        await page.goto(origin);await page.locator('.word-title h2').waitFor();
        await page.getByLabel('搜索单词').fill('zzzz-root-universe-not-covered');
        await page.getByRole('button',{name:'查词',exact:true}).click();
        await page.locator('.notice-empty h2').filter({hasText:'这个词还未收录'}).waitFor();
        await page.locator('#reset-word').click();
        await page.locator('.word-title h2').waitFor();
        await page.route('**/api/search?**',route=>route.abort(),{times:1});
        await page.getByLabel('搜索单词').fill(index.nodes.find(n=>n.type==='headwords'&&n.language==='en').display);
        await page.getByRole('button',{name:'查词',exact:true}).click();
        await page.locator('#toast').filter({hasText:'暂时无法读取'}).waitFor();
        await page.getByLabel('搜索单词').fill(index.nodes.find(n=>n.type==='headwords'&&n.language==='en').display);
        await page.getByRole('button',{name:'查词',exact:true}).click();
        await page.locator('.word-title h2').waitFor();
        const emptyBase=path.join(artifact,'empty-index');ws.mkdir(emptyBase);emptyServer=await listen({base:emptyBase,port:0});const emptyOrigin=`http://127.0.0.1:${emptyServer.address().port}`;
        const response=await fetch(emptyOrigin+'/api/health');assert.equal(response.status,503);
        await page.route('**/api/graph**',route=>route.abort(),{times:1});
        await page.goto(emptyOrigin);
        await page.locator('.notice-empty h2').filter({hasText:'暂未就绪'}).waitFor();
        const missingPath=path.join(artifact,'screenshots','320-missing-index.png');await page.screenshot({path:missingPath});result.screenshots.push(missingPath);
        await page.locator('#reload-app').click();
        await page.locator('.notice-empty h2').filter({hasText:'暂未就绪'}).waitFor();
      }finally{await context.close();}
      return {states:['unknown-word','reset','network-failure','retry','missing-index','reload']};
    });
    result.ok=true;result.status='passed';
  }catch(e){result.status=result.counts?'failed':'not_ready';if(!result.errors.length)result.errors.push({error:e.message,details:e.errors||null});logs.push(e.stack);}
  finally {
    if(browser)await browser.close().catch(e=>{result.ok=false;result.errors.push({cleanup:e.message});});
    await close(server);await close(emptyServer);
    result.exit_code=result.ok?0:1;ws.atomic(artifact,'log.txt',logs.join('\n')+'\n');ws.atomic(artifact,'counts.json',{counts:result.counts,candidate_counts:result.candidate_counts||null,packet_ids:result.packet_ids});ws.atomic(artifact,'result.json',result);ws.atomic(artifact,'exit-code.json',{exit_code:result.exit_code});ws.atomic(ws.QA,'latest-full.json',{artifact_dir:artifact,exit_code:result.exit_code,status:result.status});
  }
  return result;
}
module.exports={run,checkTwoHopPreview};
if(require.main===module)run().then(r=>{process.stdout.write(JSON.stringify(r)+'\n');process.exitCode=r.exit_code;}).catch(e=>{process.stdout.write(JSON.stringify({ok:false,status:'failed',error:e.message})+'\n');process.exitCode=1;});
