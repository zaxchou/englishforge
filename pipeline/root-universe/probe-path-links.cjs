'use strict';
// Temporary synthetic link fixture: local OS temp avoids mapped-drive reparse limitations.
// This does not extend workspace.cjs control roots. Durable evidence stays in QA.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const kit=require('./validate-kit.cjs');
const ws=require('../../root-universe/workspace.cjs');
function probePathLinks(artifactBase) {
  artifactBase=ws.controlled(artifactBase);
  if(artifactBase!==ws.QA&&!artifactBase.startsWith(ws.QA+path.sep))throw Error('QA_ARTIFACT_REQUIRED');
  const evidence={synthetic:true,ok:false,fixture_root:null,creation_attempts:[],checks:[],cleanup:{link_removed:false,fixture_removed:false},errors:[]};
  let root,link;
  const verify=(name,fn)=>{fn();evidence.checks.push({name,ok:true});};
  try {
    root=fs.mkdtempSync(path.join(os.tmpdir(),'toefl-root-universe-link-'));
    evidence.fixture_root=root;
    const guard=path.join(root,'guard'),target=path.join(root,'target');
    fs.mkdirSync(guard);fs.mkdirSync(target);
    fs.writeFileSync(path.join(target,'marker.txt'),'SYNTHETIC ONLY: local link fixture.\n',{flag:'wx'});
    link=path.join(guard,'escape');
    let created=false;
    for(const type of process.platform==='win32'?['junction','dir']:['dir']) {
      try {fs.symlinkSync(target,link,type);created=true;evidence.creation_attempts.push({type,created:true});break;}
      catch(e) {evidence.creation_attempts.push({type,created:false,code:e.code,message:e.message});}
    }
    if(!created)throw Error('LINK_FIXTURE_UNAVAILABLE: '+JSON.stringify(evidence.creation_attempts));
    verify('fixture is an actual filesystem link',()=>assert(fs.lstatSync(link).isSymbolicLink()));
    verify('actual link resolves to the synthetic target outside guard',()=>assert.equal(fs.readFileSync(path.join(link,'marker.txt'),'utf8'),'SYNTHETIC ONLY: local link fixture.\n'));
    verify('same production safeFile rejects traversal through actual link',()=>assert.throws(()=>kit.safeFile(guard,'escape/marker.txt'),/PATH_LINK/));
    verify('same production safeFile rejects a linked base',()=>assert.throws(()=>kit.safeFile(link,'marker.txt'),/PATH_LINK/));
    verify('same production safeFile rejects lexical escape',()=>assert.throws(()=>kit.safeFile(guard,'../target/marker.txt'),/PATH_ESCAPE/));
    verify('workspace does not accept temporary fixture as a data root',()=>assert.throws(()=>ws.controlled(root),/CONTROL_ROOT_REQUIRED/));
    verify('workspace does not accept an absolute temporary destination',()=>assert.throws(()=>ws.file(ws.ROOT,path.join(root,'marker.txt')),/PATH_ESCAPE/));
    evidence.ok=true;
  } catch(e) {
    evidence.errors.push({message:e.message,code:e.code||null,stack:e.stack});throw e;
  } finally {
    let cleanupError;
    // Remove only our link itself before recursively removing our unique fixture root.
    if(link) {
      try {
        const st=fs.lstatSync(link);
        if(!st.isSymbolicLink())throw Error('LINK_CLEANUP_UNEXPECTED_TYPE');
        fs.unlinkSync(link);evidence.cleanup.link_removed=true;
      } catch(e) {
        if(e.code==='ENOENT')evidence.cleanup.link_removed=true;
        else {cleanupError=e;evidence.errors.push({cleanup:'link',message:e.message,code:e.code||null});}
      }
    }
    if(root&&!cleanupError) {
      try {fs.rmSync(root,{recursive:true,force:true});evidence.cleanup.fixture_removed=true;}
      catch(e){cleanupError=e;evidence.errors.push({cleanup:'fixture',message:e.message,code:e.code||null});}
    }
    if(cleanupError)evidence.ok=false;
    evidence.exit_code=evidence.ok?0:1;
    ws.atomic(artifactBase,'link-probe.json',evidence);
    if(cleanupError)throw cleanupError;
  }
  return evidence;
}
module.exports={probePathLinks};
if(require.main===module) {
  try {
    const base=ws.mkdir(ws.QA,'link-probe-'+require('node:crypto').randomUUID());
    const evidence=probePathLinks(base);
    process.stdout.write(JSON.stringify({...evidence,artifact_dir:base})+'\n');
  }catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}
}
