const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tfl-retention-'));
try{
 const deploy=path.join(tmp,'deploy'),releases=path.join(tmp,'releases');fs.mkdirSync(deploy);fs.mkdirSync(releases);
 fs.copyFileSync(path.join(__dirname,'../deploy/clean-project-releases.sh'),path.join(deploy,'clean-project-releases.sh'));
 const release=tag=>{const d=path.join(releases,tag);fs.mkdirSync(d);fs.writeFileSync(path.join(d,'VERSION'),tag+'\n');fs.writeFileSync(path.join(d,'manifest.release.json'),JSON.stringify({version:tag}));fs.writeFileSync(path.join(d,'server.mjs'),'');for(const n of ['web','data','build'])fs.mkdirSync(path.join(d,n));};
 for(const tag of ['2026-10-26.r2','2026-10-26.r9','2026-10-26.r10','2026-10-26.r32','2026-10-26.r33','2026-10-26.r34','2026-10-26.r35'])release(tag);
 fs.mkdirSync(path.join(releases,'notes'));fs.writeFileSync(path.join(releases,'notes','keep'),'x');fs.mkdirSync(path.join(releases,'2026-10-26.r1'));
 const run=(cur,prev,...refs)=>spawnSync('C:/Program Files/Git/bin/bash.exe',[path.join(deploy,'clean-project-releases.sh'),cur,prev,...refs],{encoding:'utf8'});
 let r=run('2026-10-26.r34','2026-10-26.r99');assert.notEqual(r.status,0);assert.ok(fs.existsSync(path.join(releases,'2026-10-26.r2')),'no delete on missing rollback');
 r=run('2026-10-26.r34','2026-10-26.r33','2026-10-26.r10');assert.equal(r.status,0,r.stdout+r.stderr);
 assert.deepEqual(fs.readdirSync(releases).sort(),['2026-10-26.r1','2026-10-26.r10','2026-10-26.r33','2026-10-26.r34','2026-10-26.r35','notes']);
 r=run('2026-10-26.r34','2026-10-26.r33','2026-10-26.r10');assert.equal(r.status,0);console.log('PASS release retention: numeric revisions, actual rollback and referenced tag retained, future/incomplete/unrelated retained, missing rollback aborts before deletion, idempotent');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
