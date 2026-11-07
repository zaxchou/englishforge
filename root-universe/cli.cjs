#!/usr/bin/env node
'use strict';
const ws=require('./workspace.cjs');
const build=require('./build.cjs');
const core=require('./core.cjs');
async function run(args) {
  const [command,...rest]=args;
  if(command==='claim'||command==='rework') {if(rest.length!==2)throw Error('USAGE: claim|rework P0001 ACTUAL_OWNER');return ws.claim(rest[0],rest[1],{rework:command==='rework'});}
  if(command==='validate') {
    if(rest.length!==3||rest[1]!=='--stage'||!['candidate','verified'].includes(rest[2]))throw Error('USAGE: validate P0001 --stage candidate|verified');
    const b=ws.bundle(rest[0],rest[2]);return {ok:true,stage:rest[2],packet_id:b.p.packet_id,packet_sha256:require('../pipeline/root-universe/validate-kit.cjs').sha(b.raw)};
  }
  if(command==='build')return build.build(rest);
  if(command==='rollback'){if(rest.length!==1)throw Error('USAGE: rollback VERSION');return build.rollback(rest[0]);}
  if(command==='status') {if(rest.length)throw Error('ARGUMENT_INVALID');const s=build.current();return {ok:true,version:s.manifest.version,counts:s.manifest.counts,packets:s.index.packets};}
  if(command==='search') {if(rest.length!==1)throw Error('USAGE: search WORD');return core.search(build.current().index,rest[0]);}
  if(command==='neighbors') {
    const [id,...pairs]=rest;const options={};
    if(pairs.length%2)throw Error('ARGUMENT_INVALID');
    for(let i=0;i<pairs.length;i+=2){const key=pairs[i].replace(/^--/,'');if(!['depth','layer','type','direction','maxNodes','maxEdges'].includes(key)||Object.hasOwn(options,key))throw Error('ARGUMENT_INVALID');options[key]=['depth','maxNodes','maxEdges'].includes(key)?Number(pairs[i+1]):pairs[i+1];}
    return core.neighbors(build.current().index,id,options);
  }
  if(command==='serve') {
    if(rest.length && (rest.length!==2||rest[0]!=='--port'))throw Error('USAGE: serve [--port 8036]');
    const s=await require('./server.cjs').listen({port:rest.length?Number(rest[1]):8036});
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{s.close();s.closeAllConnections();});
    return {ok:true,url:`http://127.0.0.1:${s.address().port}`};
  }
  throw Error('USAGE: claim|rework|validate|build|status|search|neighbors|serve');
}
module.exports={run};
if(require.main===module)run(process.argv.slice(2)).then(r=>process.stdout.write(JSON.stringify(r)+'\n')).catch(e=>{process.stdout.write(JSON.stringify({ok:false,error:e.message,errors:e.errors||[]})+'\n');process.exitCode=1;});
