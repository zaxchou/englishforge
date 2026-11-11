'use strict';
// Discover published learning identities without merging roots by spelling or adding fact edges.
const core=require('./core.cjs');
const learning=require('./learning.cjs');
const normalize=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().trim().replace(/^[\s*‐‑–—-]+|[\s‐‑–—-]+$/g,'');
// Search vocabulary only: each target remains a separate, source-bound root identity.
const searchAliases={RpedFoot:['ped','pod'],RpedChild:['ped','paed'],Rair:['air','aer'],Rspace:['space'],Rbase:['base'],Rpsycho:['psych','psycho'],Rsoci:['soci'],Rchem:['chem'],Rbio:['bio'],Rmetron:['meter','metr'],Rlife:['life','live']};
function catalog(index,options={}){
  return learning.load(index,options).entries.flatMap(e=>e.roots.map(r=>{
    const members=e.words.filter(w=>w.root_ids.includes(r.id));
    const forms=[...new Set([r.label.split('「')[0],...r.label.split('「')[0].split('/'),...members.flatMap(w=>w.parts.filter(p=>p.root_id===r.id).map(p=>p.label)),...(e.id.startsWith('cfcm-')?searchAliases[r.id]||[]:[])].map(normalize).filter(Boolean))];
    return {id:e.id+':'+r.id,root_id:r.id,entry_id:e.id,title:e.alliance?.title||e.id,label:r.label,meaning:r.meaning,origin:r.origin||'',forms_note:r.forms_note||'',forms,
      members:members.map(w=>({id:w.query_id||w.sense_id,word:w.word,meaning:w.meaning,relation_kind:w.relation_kind||'close',lesson:w.lesson||null,
        branch:e.alliance?.branches.find(b=>b.words.some(x=>x.id===w.id))?.title||''}))};
  }));
}
const summary=r=>{const {members,...rest}=r;return {...rest,count:members.length};};
function roots(index,q='',options={}){
  core.inputText(q);const key=normalize(q);
  const all=catalog(index,options);
  const results=all.filter(r=>!key||r.forms.some(f=>f.includes(key))||normalize(r.meaning).includes(key)||normalize(r.label).includes(key));
  results.sort((a,b)=>(b.forms.includes(key)?1:0)-(a.forms.includes(key)?1:0)||a.entry_id.localeCompare(b.entry_id)||a.label.localeCompare(b.label));
  return {results:results.map(summary),total:all.length,truncated:false};
}
function root(index,id,options={}){
  core.inputText(id,120);
  const r=catalog(index,options).find(r=>r.id===id);
  return r?{...summary(r),members:r.members,truncated:false}:null;
}
function graph(index,options={}){
  const g=core.graph(index),ids=new Set(g.nodes.map(n=>n.id));
  for(const e of learning.load(index,options).entries){
    if(e.schema_version!=='1.1.0')continue;
    for(const w of e.words)if(!ids.has(w.query_id)){
      g.nodes.push({id:w.query_id,type:'learning_word',label:w.word,zh:w.meaning,language:'en',course_member:true,evidence_ids:[]});ids.add(w.query_id);
    }
    g.families.push({id:'alliance:'+e.id,label:e.alliance.title,member_ids:e.words.map(w=>w.query_id),learning:true});
  }
  return g;
}
function search(index,q,options={}){
  core.inputText(q);
  const key=normalize(q),raw=core.search(index,key,options),max=options.max===undefined?30:options.max;
  if(!key)return {...raw,roots:[],total:0};
  const heads=new Map(raw.results.map(h=>[h.display.toLowerCase(),h]));
  for(const w of learning.catalog(index,options))if(normalize(w.label).includes(key)&&!heads.has(w.label.toLowerCase()))
    heads.set(w.label.toLowerCase(),{id:w.id,display:w.label,lookup_key:w.label.toLowerCase(),senses:[{id:w.id,definition_zh:w.zh}],etymologies:[]});
  const all=[...heads.values()].sort((a,b)=>(normalize(a.display)===key?0:1)-(normalize(b.display)===key?0:1)||a.display.localeCompare(b.display));
  return {results:all.slice(0,max),roots:roots(index,q,options).results,total:all.length,truncated:raw.truncated||all.length>max};
}
module.exports={graph,search,roots,root};
