'use strict';
const kit=require('../pipeline/root-universe/validate-kit.cjs');
const SYMMETRIC=new Set(['cognate_with','synonym_of','antonym_of']);
function stable(value) {
  if(Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stable(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
const hash = value=>kit.sha(Buffer.from(stable(value)));
function semanticNode(n,type,evidence) {
  const source=id=>{
    const e=evidence.get(id); if(!e) throw Error('REFERENCE_EVIDENCE_MISSING: '+id);
    return Object.fromEntries(['source_family','url','entry','locator','source_version','license','attribution','excerpt_sha256','original_text','translation_zh'].map(k=>[k,e[k]]));
  };
  const out=Object.fromEntries(kit.PUBLISH_FIELDS[type].map(k=>[k,n[k]]));
  if(type==='etymologies') out.source_locators=n.source_locators.map(l=>({...l,evidence_id:source(l.evidence_id)}));
  if(type==='morphemes') out.forms=n.forms.map(f=>({...f,evidence_ids:f.evidence_ids.map(source)}));
  if(type==='headwords'||type==='senses') out.evidence=n.evidence_ids.map(source);
  return stable(out);
}
function project(bundle,{allowSynthetic=false}={}) {
  const {p,raw,r}=bundle, errors=kit.validatePacket(p,raw,r,'verified',kit.loadSchema(),{allowSynthetic});
  if(errors.length) {const e=Error('VERIFIED_REQUIRED');e.errors=errors;throw e;}
  if(p.redirects.length) throw Error('UNSUPPORTED_REDIRECT: integration task F-redirects required');
  const plan=kit.publicationPlan(p), nodes=[];
  for(const id of plan.node_ids) {
    const {type,node:n}=plan.nodeMap.get(id);
    nodes.push({id:n.id,origin_packet:n.origin_packet,type,...Object.fromEntries(kit.PUBLISH_FIELDS[type].map(k=>[k,n[k]])),evidence_ids:plan.nodeEvidence.get(id)});
  }
  return {packet_id:p.packet_id,packet_sha256:kit.sha(raw),synthetic:p.synthetic,nodes,
    facts:[...p.analyses,...p.relations].filter(f=>p.publish_fact_ids.includes(f.id)).map(f=>({...f,status:'independent_verified'})),
    evidence:p.evidence.filter(e=>plan.evidence_ids.includes(e.id)),coverage:kit.directCoverageProjection(p)};
}
function relationKey(r) {
  const pair=SYMMETRIC.has(r.type)?[r.from_id,r.to_id].sort():[r.from_id,r.to_id];
  return stable([r.type,r.layer,...pair]);
}
// resolveRegistry must read a verified immutable snapshot, never an author supplied registry object.
function compile(bundles,{allowSynthetic=false,resolveRegistry=()=>{throw Error('REFERENCE_REGISTRY_UNAVAILABLE');}}={}) {
  const packets=new Map(), identities=new Map(), nodes=new Map(), facts=new Map(), evidence=new Map();
  const semantics=new Map(), auxiliary=new Map(), analysisKeys=new Set();
  for(const b of [...bundles].sort((a,b)=>a.p.packet_id.localeCompare(b.p.packet_id))) {
    const digest=kit.sha(b.raw), prior=packets.get(b.p.packet_id);
    if(prior) {if(prior!==digest) throw Error('PACKET_HASH_CONFLICT');continue;}
    const projected=project(b,{allowSynthetic}); packets.set(b.p.packet_id,digest);
    const ev=new Map(b.p.evidence.map(e=>[e.id,e]));
    for(const field of kit.FIELDS) for(const n of b.p[field]) {
      if(n.record_role==='reference') {
        const reg=resolveRegistry(n.registry_version,n.registry_sha256), registered=reg.nodes.find(x=>x.id===n.id);
        if(!registered || registered.type!==field || registered.origin_packet!==n.origin_packet || semanticNode(n,field,ev)!==semanticNode(registered,field,new Map(reg.evidence.map(e=>[e.id,e])))) throw Error('REFERENCE_SEMANTIC_CONFLICT: '+n.id);
      } else {
        if(identities.has(n.id)) throw Error('GLOBAL_ID_CONFLICT: '+n.id);
        identities.set(n.id,field);
      }
    }
    for(const n of projected.nodes) {
      if(nodes.has(n.id)) {
        const old=nodes.get(n.id);
        if(old.type!==n.type || semanticNode(old,old.type,evidence)!==semanticNode(n,n.type,ev)) throw Error('GLOBAL_NODE_CONFLICT: '+n.id);
      } else nodes.set(n.id,n);
    }
    for(const e of projected.evidence) {if(evidence.has(e.id) && stable(evidence.get(e.id))!==stable(e)) throw Error('GLOBAL_EVIDENCE_CONFLICT');evidence.set(e.id,e);}
    for(const f of projected.facts) {
      if(f.from_id) {
        const key=relationKey(f);
        if(semantics.has(key)) throw Error((semantics.get(key).assertion===f.assertion?'DUPLICATE_GLOBAL_RELATION':'GLOBAL_RELATION_CONFLICT')+': '+f.id);
        semantics.set(key,f);
        if(f.layer==='auxiliary' && f.assertion==='positive') {
          const pair=stable([f.from_id,f.to_id].sort());
          if(auxiliary.has(pair) && auxiliary.get(pair)!==f.type) throw Error('GLOBAL_AUXILIARY_CONFLICT'); auxiliary.set(pair,f.type);
        }
      } else {
        const key=stable([f.sense_id,f.components]); if(analysisKeys.has(key)) throw Error('DUPLICATE_GLOBAL_ANALYSIS'); analysisKeys.add(key);
      }
      if(facts.has(f.id)) throw Error('GLOBAL_FACT_ID_CONFLICT');facts.set(f.id,f);
    }
  }
  for(const f of facts.values()) for(const id of f.from_id?[f.from_id,f.to_id]:[f.sense_id,...f.components.map(c=>c.node_id)]) if(!nodes.has(id)) throw Error('GLOBAL_DANGLING: '+id);
  const sort=m=>[...m.values()].sort((a,b)=>a.id.localeCompare(b.id));
  const allFacts=sort(facts), senses=sort(nodes).filter(n=>n.type==='senses');
  const coverage={modern_sense_ids:[],historical_sense_ids:[]};
  for(const s of senses) for(const layer of ['modern','historical']) if(allFacts.some(f=>f.layer===layer && (f.sense_id===s.id || f.assertion==='positive' && [f.from_id,f.to_id].includes(s.id)))) coverage[layer+'_sense_ids'].push(s.id);
  return {schema_version:'1.1.0',synthetic:allowSynthetic,packets:[...packets].map(([packet_id,packet_sha256])=>({packet_id,packet_sha256})),nodes:sort(nodes),facts:allFacts,evidence:sort(evidence),coverage};
}
function inputText(value,max=120) {if(typeof value!=='string' || [...value].length>max || /[\u0000-\u001f]/u.test(value)) throw Error('INPUT_LIMIT');return value;}
function limit(value,fallback,max) {if(value===undefined) return fallback;if(!Number.isInteger(value)||value<1||value>max) throw Error('QUERY_LIMIT');return value;}
function search(index,query,{max=30}={}) {
  inputText(query);max=limit(max,30,50);const key=kit.normalized(query);
  if(!key) return {results:[],truncated:false};
  const heads=index.nodes.filter(n=>n.type==='headwords' && [n.lookup_key,...n.aliases.map(kit.normalized)].some(k=>k.includes(key))).sort((a,b)=>(a.lookup_key===key?0:1)-(b.lookup_key===key?0:1)||a.id.localeCompare(b.id));
  return {results:heads.slice(0,max).map(h=>({...h,senses:index.nodes.filter(s=>s.type==='senses'&&s.headword_id===h.id),etymologies:index.nodes.filter(e=>e.type==='etymologies'&&e.headword_id===h.id)})),truncated:heads.length>max};
}
function detail(index,id) {
  inputText(id,80);const n=index.nodes.find(n=>n.id===id);if(!n)return null;
  const ids=new Set([id]);if(n.type==='headwords') index.nodes.filter(s=>s.headword_id===id).forEach(s=>ids.add(s.id));
  if(n.headword_id) ids.add(n.headword_id);if(n.etymology_id) ids.add(n.etymology_id);
  return {node:n,identities:index.nodes.filter(x=>ids.has(x.id))};
}
function neighbors(index,id,{depth=1,maxNodes=40,maxEdges=80,layer='all',type='all',direction='both'}={}) {
  inputText(id,80);depth=limit(depth,1,2);maxNodes=limit(maxNodes,40,100);maxEdges=limit(maxEdges,80,200);
  if(!['all','modern','historical','auxiliary'].includes(layer)||!['both','out','in'].includes(direction)) throw Error('QUERY_FILTER');
  const types=new Set(['modern_derived_from','modern_compound_of','borrowed_from','inherited_from','cognate_with','historical_derived_from','historical_compound_of','allomorph_of','synonym_of','antonym_of','analysis_component']);
  if(type!=='all'&&!types.has(type)) throw Error('QUERY_FILTER');
  if(!index.nodes.some(n=>n.id===id)) return {found:false,nodes:[],edges:[],truncated:false};
  const edges=index.facts.flatMap(f=>f.from_id?[{...f,symmetric:SYMMETRIC.has(f.type),fact_id:f.id}]:f.components.map(c=>({id:f.id+':'+c.position,fact_id:f.id,from_id:f.sense_id,to_id:c.node_id,type:'analysis_component',layer:'modern',assertion:'positive',evidence_ids:f.evidence_ids,symmetric:false}))).filter(e=>(layer==='all'||e.layer===layer)&&(type==='all'||type===e.type));
  const ids=new Set([id]), selected=new Map();let frontier=[id],truncated=false;
  for(let d=0;d<depth;d++) {
    const next=[];
    for(const cur of frontier) for(const e of edges) {
      const outgoing=e.from_id===cur && (direction!=='in'||e.symmetric), incoming=e.to_id===cur && (direction!=='out'||e.symmetric);
      if(!outgoing&&!incoming)continue; const other=outgoing?e.to_id:e.from_id;
      if(selected.has(e.id))continue;
      if(selected.size>=maxEdges||!ids.has(other)&&ids.size>=maxNodes){truncated=true;continue;}
      selected.set(e.id,e);if(!ids.has(other)){ids.add(other);next.push(other);}
    }
    frontier=next;
  }
  return {found:true,depth,nodes:index.nodes.filter(n=>ids.has(n.id)).map(n=>({...n,label:n.display||index.nodes.find(h=>h.type==='headwords'&&h.id===n.headword_id)?.display||n.forms?.map(f=>f.form).join(' / ')||n.identity_note})),edges:[...selected.values()],truncated,limits:{maxNodes,maxEdges}};
}
// Read-only whole-graph view for the local preview: nodes, edges and connected families.
// Families join fact edges AND the headword/sense/etymology hierarchy, so a family is one component.
function graph(index) {
  const byId=new Map(index.nodes.map(n=>[n.id,n]));
  const labelOf=n=>n.display||(n.forms||[]).map(f=>f.form).join(' / ')||(n.headword_id?byId.get(n.headword_id)?.display:null)||n.identity_note||null;
  const nodes=index.nodes.map(n=>({id:n.id,type:n.type,label:labelOf(n),zh:n.definition_zh||null,pos:n.pos||null,language:n.language||(n.headword_id?byId.get(n.headword_id)?.language:null)||null,headword_id:n.headword_id||null,etymology_id:n.etymology_id||null,identity_note:n.identity_note||null,definition_original:n.definition_original||null,course_member:n.course_member===true,evidence_ids:n.evidence_ids||[]}));
  const edges=index.facts.filter(f=>f.from_id).map(f=>({id:f.id,from_id:f.from_id,to_id:f.to_id,type:f.type,layer:f.layer,assertion:f.assertion,symmetric:SYMMETRIC.has(f.type)}));
  const parent=new Map(nodes.map(n=>[n.id,n.id]));
  const find=x=>{while(parent.get(x)!==x){parent.set(x,parent.get(parent.get(x)));x=parent.get(x);}return x;};
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a,b);};
  for(const e of edges)union(e.from_id,e.to_id);
  for(const n of index.nodes){
    if(n.headword_id&&byId.has(n.headword_id))union(n.id,n.headword_id);
    if(n.etymology_id&&byId.has(n.etymology_id))union(n.id,n.etymology_id);
  }
  const groups=new Map();
  for(const n of nodes){const r=find(n.id);if(!groups.has(r))groups.set(r,[]);groups.get(r).push(n.id);}
  const families=[...groups.values()].map(ids=>{
    ids.sort();
    const heads=ids.map(id=>byId.get(id)).filter(n=>n.type==='headwords'&&n.language==='en');
    const score=h=>heads.filter(o=>o.display!==h.display&&o.display.includes(h.display)).length;
    heads.sort((a,b)=>score(b)-score(a)||a.display.length-b.display.length||a.display.localeCompare(b.display));
    const fallback=ids.map(id=>byId.get(id)).find(n=>n.type==='senses'&&n.language==='en');
    const base=heads[0]?heads[0].display:(fallback?labelOf(fallback):ids[0]);
    return {id:heads[0]?heads[0].id:(fallback?fallback.headword_id||fallback.id:ids[0]),label:base+' 词族',member_ids:ids};
  }).sort((a,b)=>a.label.localeCompare(b.label));
  return {nodes,edges,families};
}
module.exports={stable,hash,semanticNode,project,compile,relationKey,search,detail,neighbors,graph,inputText};
