'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const ws=require('./workspace.cjs');
const build=require('./build.cjs');
const core=require('./core.cjs');
const learning=require('./learning.cjs');
const discovery=require('./discovery.cjs');
function createServer({base=ws.ROOT,deskUrl=process.env.TFL_DESK_URL??'https://192.168.31.246:8018/#/home'}={}) {
  ws.controlled(base);
  let desk;
  try {desk=new URL(deskUrl);} catch {throw Error('TFL_DESK_URL_INVALID');}
  if(!['http:','https:'].includes(desk.protocol))throw Error('TFL_DESK_URL_INVALID');
  const deskHref=desk.href.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/alliance-ui.js':['alliance-ui.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/brand.png':['brand.png','image/png']};
  const send=(res,status,body,type='application/json; charset=utf-8')=>{
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
    res.end(type.startsWith('application/json')?JSON.stringify(body):body);
  };
  let activeSnapshot=null,activeToken=null;
  const current=()=>{
    const pointer=ws.bytes(base,'current.json'),p=JSON.parse(pointer);
    if(!/^v-[a-f0-9]{64}$/.test(p.version))throw Error('VERSION_INVALID');
    const token=pointer.toString()+['index.json','registry.json','manifest.json'].map(name=>{const st=fs.statSync(ws.file(base,`versions/${p.version}/${name}`));return st.size+':'+st.mtimeMs;}).join('|');
    if(token!==activeToken){const next=build.current(base);activeSnapshot=next;activeToken=token;}
    return activeSnapshot;
  };
  return http.createServer({maxHeaderSize:8192,requestTimeout:5000,headersTimeout:5000},(req,res)=>{
    if(req.method!=='GET') {req.resume();return send(res,405,{error:'READ_ONLY'});}
    if(req.headers.host!==`127.0.0.1:${req.socket.localPort}`)return send(res,400,{error:'HOST_INVALID'});
    if(req.url.length>2048)return send(res,414,{error:'URL_LIMIT'});
    let url;
    try {url=new URL(req.url,'http://127.0.0.1');decodeURIComponent(req.url);}catch{return send(res,400,{error:'URL_INVALID'});}
    if(assets[url.pathname]){
      const [file,type]=assets[url.pathname];
      let body=fs.readFileSync(path.join(__dirname,'public',file));
      if(file==='index.html')body=body.toString('utf8').replace(/href="\/#\/home"(?= data-desk-link)/g,()=>`href="${deskHref}"`);
      return send(res,200,body,type);
    }
    const routes={'/api/health':[],'/api/graph':[],'/api/search':['q','max'],'/api/roots':['q'],'/api/root':['id'],'/api/node':['id'],'/api/neighbors':['id','depth','maxNodes','maxEdges','layer','type','direction'],'/api/source':['id'],'/api/learning':['id']};
    if(!Object.hasOwn(routes,url.pathname))return send(res,404,{error:'NOT_FOUND'});
    for(const key of url.searchParams.keys()) if(!routes[url.pathname].includes(key)||url.searchParams.getAll(key).length!==1)return send(res,400,{error:'PARAMETER_INVALID'});
    let snapshot;
    try {snapshot=current();}catch(e){return send(res,503,{error:e.code==='ENOENT'?'INDEX_MISSING':'INDEX_UNAVAILABLE',message:'词族内容暂未就绪，请稍后重试。'});}
    const index=snapshot.index;
    try {
      const get=k=>url.searchParams.get(k), number=k=>url.searchParams.has(k)?(/^[0-9]+$/.test(get(k))?Number(get(k)):NaN):undefined;
      if(url.pathname==='/api/health')return send(res,200,{ok:true,version:snapshot.manifest.version,counts:snapshot.manifest.counts});
      if(url.pathname==='/api/graph')return send(res,200,discovery.graph(index,{base}));
      if(url.pathname==='/api/search')return send(res,200,discovery.search(index,get('q')||'',{max:number('max'),base}));
      if(url.pathname==='/api/roots')return send(res,200,discovery.roots(index,get('q')||'',{base}));
      if(url.pathname==='/api/root'){const d=discovery.root(index,get('id')||'',{base});return send(res,d?200:404,d||{error:'UNKNOWN_ROOT'});}
      const id=core.inputText(get('id')||'',80);
      if(url.pathname==='/api/learning'){
        let d=learning.query(index,id,{base});
        if(d&&d.status==='unresolved'){
          // Fact sense lacks a profile: fall back to a reviewed learning word with the same spelling.
          const sense=index.nodes.find(n=>n.id===id&&n.type==='senses');
          const head=sense?index.nodes.find(n=>n.id===sense.headword_id):null;
          const alt=head?learning.catalog(index,{base}).find(w=>w.label.toLowerCase()===head.display.toLowerCase()):null;
          if(alt){const altResult=learning.query(index,alt.id,{base});if(altResult&&altResult.status==='reviewed')d=altResult;}
        }
        return send(res,d?200:404,d||{error:'UNKNOWN_NODE'});
      }
      if(!/^P\d{4}:[a-z][a-z0-9_-]*$/.test(id))throw Error('ID_INVALID');
      if(url.pathname==='/api/node') {const d=core.detail(index,id);return send(res,d?200:404,d||{error:'UNKNOWN_NODE'});}
      if(url.pathname==='/api/source') {const e=index.evidence.find(e=>e.id===id);return send(res,e?200:404,e||{error:'UNKNOWN_SOURCE'});}
      if(url.pathname==='/api/learning') {const d=require('./learning.cjs').query(index,id,{base});return send(res,d?200:404,d||{error:'UNKNOWN_NODE'});}
      const result=core.neighbors(index,id,{depth:number('depth'),maxNodes:number('maxNodes'),maxEdges:number('maxEdges'),layer:get('layer')||'all',type:get('type')||'all',direction:get('direction')||'both'});
      return send(res,result.found?200:404,result);
    }catch(e){send(res,400,{error:e.message});}
  });
}
async function listen(options={}) {
  const port=options.port===undefined?8036:options.port;
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('PORT_INVALID');
  const server=createServer(options);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return server;
}
module.exports={createServer,listen};
if(require.main===module) {
  const args=process.argv.slice(2);
  if(args.length && (args.length!==2 || args[0]!=='--port')) {process.stderr.write('USAGE: node server.cjs [--port 8036]\n');process.exitCode=1;}
  else listen({port:args.length?Number(args[1]):8036}).then(s=>{
    process.stdout.write(JSON.stringify({ok:true,url:`http://127.0.0.1:${s.address().port}`})+'\n');
    for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{s.close();s.closeAllConnections();});
  }).catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
}
