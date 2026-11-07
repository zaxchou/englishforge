'use strict';
// Only acquires bytes. Does not infer etymology, create reviews, or approve facts.
const {execFileSync}=require('node:child_process');
const crypto=require('node:crypto');
const ws=require('../../root-universe/workspace.cjs');
const kit=require('./validate-kit.cjs');
const AUTHOR='dwfrun-304e9fd2-80f7-480f-8b10-0577c4eb52de / hole#a599ab49/actor#1@1 / 词根宇宙框架实现者';
function acquire(packetId,title,capturedBy) {
  if(typeof capturedBy!=='string'||!capturedBy.trim())throw Error('ACTUAL_AUTHOR_ID_REQUIRED');
  const t=ws.task(packetId), allowed=[...t.sense_scope.candidate_headwords,...(t.foundation_additional_headwords||[])];
  if(ws.json(ws.ROOT,`packets/${packetId}/claim.json`).owner!==capturedBy)throw Error('CLAIM_OWNER_MISMATCH');
  if(title!=='@rights'&&!allowed.includes(title))throw Error('ACQUISITION_OUTSIDE_REGISTERED_SCOPE');
  const url=title==='@rights'?'https://en.wiktionary.org/w/api.php?action=query&meta=siteinfo&siprop=rightsinfo&format=json':
    'https://en.wiktionary.org/w/api.php?action=query&prop=revisions&titles='+encodeURIComponent(title)+'&rvprop=ids%7Ctimestamp%7Ccontent&rvslots=main&format=json&formatversion=2';
  const raw=execFileSync('curl',['--fail','--location','--max-time','30','--silent','--show-error',url],{maxBuffer:8*1024*1024,timeout:35000});
  const parsed=JSON.parse(raw), page=parsed.query?.pages?.[0], revision=page?.revisions?.[0];
  if(title!=='@rights' && (!revision?.slots?.main?.content || page.title!==title))throw Error('SOURCE_MISSING_OR_REDIRECT: '+title);
  const rel=`snapshots/${packetId}/${crypto.randomUUID()}`;ws.mkdir(ws.ROOT,rel);
  ws.atomic(ws.ROOT,`${rel}/response.json`,raw);
  const meta={packet_id:packetId,title,url,retrieved_at:ws.now(),response_sha256:kit.sha(raw),source_version:revision?'enwiktionary-revid-'+revision.revid:null,revision_timestamp:revision?.timestamp||null,captured_by:capturedBy,snapshot:rel+'/response.json'};
  ws.atomic(ws.ROOT,`${rel}/capture.json`,meta);
  const listFile=ws.file(ws.ROOT,`packets/${packetId}/captures.json`);
  const list=require('node:fs').existsSync(listFile)?ws.json(ws.ROOT,`packets/${packetId}/captures.json`):[];
  ws.atomic(ws.ROOT,`packets/${packetId}/captures.json`,[...list,meta]);
  return meta;
}
module.exports={acquire,AUTHOR};
if(require.main===module) {
  try { const [id,owner,...titles]=process.argv.slice(2);if(!titles.length)throw Error('USAGE: acquire-source.cjs P0001 ACTUAL_AUTHOR_ID predict ...');
    const captures=titles.map(title=>acquire(id,title,owner));
    process.stdout.write(JSON.stringify({ok:true,captures})+'\n');
  } catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message})+'\n');process.exitCode=1;}
}
