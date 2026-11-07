'use strict';
// packet/review契约1.1.0，任务登记格式仍为1.0.0。只检查字节、引用和声明。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PROJECT = path.resolve(__dirname, '../..');
const KIT = path.join(PROJECT, 'docs', 'word-root-universe');
const PID = /^P[0-9]{4}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));
const own = (x, k) => Object.prototype.hasOwnProperty.call(x, k);
const normalized = s => s.normalize('NFC').trim().replace(/\s+/gu, ' ').replace(/[\u2010\u2011]/gu, '-').toLowerCase();
const FIELDS = ['headwords', 'etymologies', 'senses', 'morphemes', 'evidence', 'analyses', 'relations', 'homograph_groups', 'redirects'];
const NODE_FIELDS = ['headwords', 'etymologies', 'senses', 'morphemes'];
const SUPPORTED = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'additionalProperties', 'required', 'properties', 'const', 'enum', 'pattern', 'minLength', 'minimum', 'minItems', 'uniqueItems', 'items']);

function safeFile(base, rel) {
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error('PATH_ESCAPE: ' + rel);
  let cursor = base;
  const rejectLink = f => {
    try { if (fs.lstatSync(f).isSymbolicLink()) throw new Error('PATH_LINK: ' + f); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  };
  rejectLink(base);
  for (const part of path.relative(base, dest).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    rejectLink(cursor);
  }
  return dest;
}
function readFile(rel) {
  // 从项目根逐级拒绝符号链接/Windows junction，再读取。
  const f = safeFile(PROJECT, rel);
  const st = fs.statSync(f);
  if (!st.isFile() || st.size === 0) throw new Error('FILE_EMPTY_OR_NOT_FILE: ' + rel);
  return fs.readFileSync(f);
}
function jsonFile(rel) { return JSON.parse(readFile(rel).toString('utf8')); }
function kitRel(rel) { return path.join('docs', 'word-root-universe', rel); }
function issue(errors, code, where, detail) { errors.push({code, where, detail}); }

// 完整实现本schema使用的关键字；遇到新增但尚未实现的关键字，self-test必须失败。
function schemaLint(s, root, errors, at = '#') {
  if (!s || typeof s !== 'object' || Array.isArray(s)) { issue(errors, 'SCHEMA_DEFINITION', at, 'schema必须是对象'); return; }
  for (const key of Object.keys(s)) if (!SUPPORTED.has(key)) issue(errors, 'SCHEMA_UNSUPPORTED', at, key);
  if (s.$ref) {
    const name = s.$ref.startsWith('#/$defs/') ? s.$ref.slice(8) : '';
    if (!name || !own(root.$defs || {}, name)) issue(errors, 'SCHEMA_REF', at, s.$ref);
  }
  for (const [name, sub] of Object.entries(s.properties || {})) schemaLint(sub, root, errors, at + '/properties/' + name);
  for (const [name, sub] of Object.entries(s.$defs || {})) schemaLint(sub, root, errors, at + '/$defs/' + name);
  if (s.items) schemaLint(s.items, root, errors, at + '/items');
}
function shape(value, s, root, errors, at = '$') {
  if (s.$ref) return shape(value, root.$defs[s.$ref.slice(8)], root, errors, at);
  if (own(s, 'const') && value !== s.const) issue(errors, 'SCHEMA_CONST', at, String(s.const));
  if (s.enum && !s.enum.includes(value)) issue(errors, 'SCHEMA_ENUM', at, '枚举值不允许');
  if (s.type) {
    const valid = s.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : s.type === 'array' ? Array.isArray(value)
      : s.type === 'integer' ? Number.isInteger(value)
      : typeof value === s.type;
    if (!valid) { issue(errors, 'SCHEMA_TYPE', at, s.type); return; }
  }
  if (typeof value === 'string') {
    if (s.minLength && [...value].length < s.minLength) issue(errors, 'SCHEMA_LENGTH', at, '字符串过短');
    if (s.pattern && !new RegExp(s.pattern, 'u').test(value)) issue(errors, 'SCHEMA_PATTERN', at, s.pattern);
  }
  if (typeof value === 'number' && own(s, 'minimum') && value < s.minimum) issue(errors, 'SCHEMA_MINIMUM', at, String(s.minimum));
  if (Array.isArray(value)) {
    if (s.minItems && value.length < s.minItems) issue(errors, 'SCHEMA_ITEMS', at, '数组过短');
    if (s.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) issue(errors, 'SCHEMA_UNIQUE', at, '重复项');
    if (s.items) value.forEach((x, i) => shape(x, s.items, root, errors, `${at}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const k of s.required || []) if (!own(value, k)) issue(errors, 'SCHEMA_REQUIRED', at, k);
    if (s.additionalProperties === false) for (const k of Object.keys(value)) if (!own(s.properties || {}, k)) issue(errors, 'SCHEMA_EXTRA', at, k);
    for (const [k, sub] of Object.entries(s.properties || {})) if (own(value, k)) shape(value[k], sub, root, errors, at + '.' + k);
  }
}

// 节点只发布这些语义字段；ID/来源包和证据引用为溯源元数据。
const PUBLISH_FIELDS = {
  headwords: ['language', 'display', 'lookup_key', 'aliases', 'course_member'],
  etymologies: ['headword_id', 'identity_note', 'source_locators'],
  senses: ['headword_id', 'etymology_id', 'pos', 'sense_key', 'definition_original', 'definition_zh'],
  morphemes: ['language', 'kind', 'forms']
};
const setEqual = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
function publicationPlan(p) {
  const nodeMap = new Map();
  for (const type of NODE_FIELDS) for (const n of p[type]) nodeMap.set(n.id, {type, node:n});
  const factMap = new Map([...p.analyses, ...p.relations].map(f => [f.id, f]));
  const nodeIds = new Set(), evidenceIds = new Set(), nodeEvidence = new Map();
  for (const id of p.publish_fact_ids) {
    const f = factMap.get(id);
    if (!f) continue;
    for (const eid of f.evidence_ids) evidenceIds.add(eid);
    if (own(f, 'sense_id')) { nodeIds.add(f.sense_id); for (const c of f.components) nodeIds.add(c.node_id); }
    else { nodeIds.add(f.from_id); nodeIds.add(f.to_id); }
  }
  // Set迭代会继续访问追加的父身份；只沿身份引用，不沿其他候选边展开。
  for (const id of nodeIds) {
    const found = nodeMap.get(id);
    if (!found) continue;
    const {type, node:n} = found;
    if (type === 'senses') { nodeIds.add(n.headword_id); nodeIds.add(n.etymology_id); }
    if (type === 'etymologies') nodeIds.add(n.headword_id);
    const direct = type === 'etymologies' ? n.source_locators.map(l => l.evidence_id)
      : type === 'morphemes' ? n.forms.flatMap(f => f.evidence_ids) : n.evidence_ids;
    nodeEvidence.set(id, [...new Set(direct)].sort());
    for (const eid of direct) evidenceIds.add(eid);
  }
  return {node_ids:[...nodeIds].sort(), evidence_ids:[...evidenceIds].sort(), nodeMap, nodeEvidence};
}
function nodeNeedsTranslation(n, type, evidenceIds, evidence) {
  const displayed = Object.fromEntries(PUBLISH_FIELDS[type].map(k => [k, n[k]]));
  return !!n.definition_zh || /\p{Script=Han}/u.test(JSON.stringify(displayed))
    || evidenceIds.some(id => !!evidence.get(id)?.translation_zh);
}
// 只供已通过门禁的投影使用：不把词源节点的边扩散为它下面全部词义的覆盖。
function directCoverageProjection(p) {
  const modern = new Set(), historical = new Set(), wanted = new Set(p.publish_fact_ids);
  const senses = new Set(p.senses.map(s => s.id));
  for (const a of p.analyses) if (wanted.has(a.id)) modern.add(a.sense_id);
  for (const r of p.relations) if (wanted.has(r.id) && r.assertion === 'positive' && r.layer !== 'auxiliary') {
    for (const id of [r.from_id, r.to_id]) if (senses.has(id)) (r.layer === 'modern' ? modern : historical).add(id);
  }
  return {modern_sense_ids:[...modern].sort(), historical_sense_ids:[...historical].sort()};
}

function validatePacket(p, raw, review, stage, schema, options = {}) {
  const errors = [];
  const err = (c, w, d) => issue(errors, c, w, d);
  if (!['candidate', 'verified'].includes(stage)) return [{code:'STAGE_INVALID',where:'stage',detail:String(stage)}];
  shape(p, schema, schema, errors);
  if (errors.length) return errors;
  if (p.synthetic && !options.allowSynthetic) err('SYNTHETIC_FORBIDDEN', '$.synthetic', '合成夹具不能进入真实staging');
  if (!p.synthetic && options.allowSynthetic) err('FIXTURE_LABEL', '$.synthetic', 'self-test必须明确合成');
  const ids = new Map();
  const nodes = new Map();
  const evidence = new Map(p.evidence.map(e => [e.id, e]));
  for (const field of FIELDS) for (const row of p[field]) {
    if (ids.has(row.id)) err('DUPLICATE_ID', field, row.id);
    ids.set(row.id, field);
    if (NODE_FIELDS.includes(field)) nodes.set(row.id, row);
    else if (!row.id.startsWith(p.packet_id + ':')) err('ID_OWNERSHIP', field, row.id);
  }
  for (const field of NODE_FIELDS) for (const n of p[field]) {
    if (!n.id.startsWith(n.origin_packet + ':')) err('ID_ORIGIN', n.id, n.origin_packet);
    if (n.record_role === 'owned' && n.origin_packet !== p.packet_id) err('ID_OWNERSHIP', n.id, 'owned必须为本包');
    if (n.record_role === 'reference' && (!n.registry_version || !n.registry_sha256)) err('REFERENCE_PROOF', n.id, '缺注册表版本及hash');
    if (n.record_role === 'reference' && n.origin_packet === p.packet_id) err('REFERENCE_SELF', n.id, '本包身份不能伪装外部引用');
  }
  const ref = (id, types, where) => {
    if (!ids.has(id)) err('DANGLING_ID', where, id);
    else if (!types.includes(ids.get(id))) err('REFERENCE_TYPE', where, `${id}: ${ids.get(id)}`);
  };
  const evrefs = (list, where, required = true) => {
    if (required && list.length === 0) err('FACT_EVIDENCE_REQUIRED', where, '缺少事实证据');
    for (const id of list) ref(id, ['evidence'], where);
  };
  for (const h of p.headwords) {
    if (h.lookup_key !== normalized(h.display)) err('LOOKUP_NORMALIZATION', h.id, 'lookup_key与规定算法不符');
    evrefs(h.evidence_ids, h.id, false);
  }
  for (const e of p.etymologies) {
    ref(e.headword_id, ['headwords'], e.id);
    for (const loc of e.source_locators) {
      ref(loc.evidence_id, ['evidence'], e.id);
      if (evidence.has(loc.evidence_id) && loc.source_version !== evidence.get(loc.evidence_id).source_version) err('SOURCE_VERSION', e.id, '定位与证据版本不同');
    }
  }
  const senseKeys = new Set();
  for (const s of p.senses) {
    ref(s.headword_id, ['headwords'], s.id);
    ref(s.etymology_id, ['etymologies'], s.id);
    const et = nodes.get(s.etymology_id);
    if (et && et.headword_id !== s.headword_id) err('SENSE_ETYMOLOGY_HEAD', s.id, '词义跨词头混入词源身份');
    const k = [s.headword_id, s.etymology_id, s.pos, s.sense_key].join('|');
    if (senseKeys.has(k)) err('DUPLICATE_SENSE', s.id, k);
    senseKeys.add(k);
    evrefs(s.evidence_ids, s.id, !!(s.definition_original || s.definition_zh));
    if (Object.values(s.coverage).includes('verified')) err('AUTHOR_VERIFIED_COVERAGE', s.id, '覆盖必须由独立批准投影计算');
  }
  for (const m of p.morphemes) for (const f of m.forms) evrefs(f.evidence_ids, m.id);
  for (const e of p.evidence) {
    if (sha(Buffer.from(e.original_text, 'utf8')) !== e.excerpt_sha256) err('EXCERPT_HASH', e.id, '原文片段hash不符');
    if (!p.authors.includes(e.captured_by)) err('UNDECLARED_AUTHOR', e.id, e.captured_by);
    if (!Number.isFinite(Date.parse(e.retrieved_at))) err('DATE_VALUE', e.id, e.retrieved_at);
    if (/^(latest|unknown|unconfirmed)$/iu.test(e.source_version.trim())) err('SOURCE_VERSION', e.id, '需要具体版本');
    let url;
    try { url = new URL(e.url); } catch { err('SOURCE_URL', e.id, '非法URL'); continue; }
    if (url.username || url.password || url.protocol !== 'https:') err('SOURCE_URL', e.id, '仅允许无凭据HTTPS');
    const policies = {
      enwiktionary: {hosts: ['en.wiktionary.org', 'kaikki.org'], licenses: ['CC-BY-SA-4.0']},
      morphynet: {hosts: ['raw.githubusercontent.com', 'github.com'], licenses: ['CC-BY-SA-3.0']},
      synthetic: {hosts: ['example.invalid'], licenses: ['CC0-1.0']}
    };
    const policy = policies[e.source_family];
    if (!policy.hosts.includes(url.hostname) || (e.source_family === 'synthetic' && !options.allowSynthetic)) err('SOURCE_POLICY', e.id, '来源族/域名不允许');
    if (e.license !== 'unconfirmed' && !policy.licenses.includes(e.license)) err('LICENSE_POLICY', e.id, '来源许可不在策略中');
  }
  const facts = [...p.analyses, ...p.relations];
  const factMap = new Map(facts.map(f => [f.id, f]));
  for (const f of facts) {
    evrefs(f.evidence_ids, f.id);
    if (!p.authors.includes(f.author)) err('UNDECLARED_AUTHOR', f.id, f.author);
    if (f.status === 'independent_verified') err('AUTHOR_VERIFIED', f.id, '作者包不得自写独立通过');
  }
  const analysisKeys = new Set();
  for (const a of p.analyses) {
    ref(a.sense_id, ['senses'], a.id);
    a.components.forEach((c, i) => {
      ref(c.node_id, ['senses', 'morphemes'], a.id);
      if (c.position !== i) err('COMPONENT_ORDER', a.id, 'position须从0连续');
    });
    const k = JSON.stringify([a.sense_id, a.components]);
    if (analysisKeys.has(k)) err('DUPLICATE_ANALYSIS', a.id, '同一分析重复');
    analysisKeys.add(k);
  }
  const symmetric = new Set(['cognate_with', 'synonym_of', 'antonym_of']);
  const relKeys = new Map();
  const semanticPairs = new Map();
  for (const r of p.relations) {
    const expected = r.type.startsWith('modern_') ? 'modern' : ['synonym_of', 'antonym_of'].includes(r.type) ? 'auxiliary' : 'historical';
    if (r.layer !== expected) err('LAYER_TYPE', r.id, `${r.type}须在${expected}层`);
    const allowed = r.layer === 'auxiliary' ? ['senses'] : r.type === 'allomorph_of' ? ['morphemes'] : ['senses', 'etymologies', 'morphemes'];
    if (r.type.startsWith('modern_')) {
      ref(r.from_id, ['senses'], r.id); ref(r.to_id, ['senses', 'morphemes'], r.id);
    } else { ref(r.from_id, allowed, r.id); ref(r.to_id, allowed, r.id); }
    if (r.from_id === r.to_id) err('SELF_RELATION', r.id, '不接受自关系');
    const pair = symmetric.has(r.type) ? [r.from_id, r.to_id].sort() : [r.from_id, r.to_id];
    const key = JSON.stringify([r.type, r.layer, ...pair]);
    if (relKeys.has(key)) {
      const prior = relKeys.get(key);
      err(prior.assertion === r.assertion ? 'DUPLICATE_RELATION' : 'CONFLICT_RELATION', r.id, prior.id);
    }
    relKeys.set(key, r);
    if (r.layer === 'auxiliary' && r.assertion === 'positive') {
      const pk = JSON.stringify(pair);
      if (semanticPairs.has(pk) && semanticPairs.get(pk) !== r.type) err('CONFLICT_AUXILIARY', r.id, '同一词义对不能同时正向近义和反义');
      semanticPairs.set(pk, r.type);
    }
  }
  const redirects = new Map();
  for (const r of p.redirects) {
    ref(r.from_id, NODE_FIELDS, r.id);
    for (const to of r.to_ids) ref(to, NODE_FIELDS, r.id);
    evrefs(r.evidence_ids, r.id);
    if (redirects.has(r.from_id)) err('DUPLICATE_REDIRECT', r.id, r.from_id);
    if ((r.action === 'split' && r.to_ids.length < 2) || (r.action !== 'split' && r.to_ids.length !== 1)) err('REDIRECT_ARITY', r.id, r.action);
    for (const to of r.to_ids) if (ids.get(to) !== ids.get(r.from_id)) err('REDIRECT_TYPE', r.id, '不能跨节点类型重定向');
    redirects.set(r.from_id, r.to_ids);
  }
  function reach(id, stack = new Set()) {
    if (stack.has(id)) { err('REDIRECT_CYCLE', id, '重定向成环'); return new Set(); }
    const all = new Set([id]);
    const next = new Set(stack); next.add(id);
    for (const to of redirects.get(id) || []) for (const k of reach(to, next)) all.add(k);
    return all;
  }
  for (const id of redirects.keys()) reach(id);
  for (const g of p.homograph_groups) {
    ref(g.headword_id, ['headwords'], g.id);
    const seen = new Set();
    for (const id of g.etymology_ids) {
      ref(id, ['etymologies'], g.id);
      if (nodes.get(id)?.headword_id !== g.headword_id) err('HOMOGRAPH_HEAD', g.id, id);
      for (const x of reach(id)) {
        if (seen.has(x)) err('HOMOGRAPH_MERGE', g.id, x);
        seen.add(x);
      }
    }
  }
  const plan = publicationPlan(p);
  if (!setEqual(p.publish_node_ids, plan.node_ids)) err('PUBLISH_NODE_SET', '$.publish_node_ids', '必须恰好等于拟发布事实的端点及身份父节点闭包');
  for (const id of p.publish_node_ids) ref(id, NODE_FIELDS, '$.publish_node_ids');
  for (const id of plan.node_ids) if (!(plan.nodeEvidence.get(id) || []).length) err('NODE_EVIDENCE_REQUIRED', id, '拟发布节点必须有自身文案/身份或forms的证据');
  for (const id of p.publish_fact_ids) {
    if (!factMap.has(id)) { err('PUBLISH_FACT_ID', id, '不是事实ID'); continue; }
    const f = factMap.get(id);
    if (f.status !== 'source_verified') err('CANDIDATE_PUBLISHED', id, f.status);
  }
  // 许可和来源策略覆盖正式投影全部证据，而非仅边本身。
  for (const eid of plan.evidence_ids) {
    const e = evidence.get(eid);
    if (!e) continue;
    if (e.license === 'unconfirmed') err('LICENSE_UNCONFIRMED', eid, '拟发布事实及节点必须许可明确');
    if (!['enwiktionary', ...(options.allowSynthetic ? ['synthetic'] : [])].includes(e.source_family)) err('PUBLISH_SOURCE', eid, 'MorphyNet只支持候选，不可支持发布投影');
  }
  if (stage === 'verified') {
    if (!review) { err('REVIEW_REQUIRED', 'review.json', '缺独立审查'); return errors; }
    const before = errors.length;
    shape(review, schema.$defs.review, schema, errors, '$review');
    if (errors.length !== before) return errors;
    if (p.publish_fact_ids.length === 0) err('EMPTY_PUBLICATION', '$.publish_fact_ids', '首包至少一条独立通过事实');
    if (review.packet_id !== p.packet_id || review.synthetic !== p.synthetic) err('REVIEW_PACKET', '$review', '包身份不符');
    if (review.packet_sha256 !== sha(raw)) err('REVIEW_HASH', '$review.packet_sha256', '审查不对应当前文件字节');
    const authors = new Set(p.authors.map(x => x.normalize('NFC').trim().toLowerCase()));
    for (const role of ['reviewer', 'translation_reviewer']) if (authors.has(review[role].normalize('NFC').trim().toLowerCase())) err('SELF_REVIEW', '$review.' + role, review[role]);
    if (!Number.isFinite(Date.parse(review.reviewed_at))) err('DATE_VALUE', '$review.reviewed_at', '非法日期');
    if (review.decision !== 'ready_for_merge' || review.blockers.length) err('REVIEW_BLOCKED', '$review', '有阻断或尚未批准');
    const sourceChecks = new Map();
    for (const c of review.source_checks) {
      ref(c.evidence_id, ['evidence'], '$review.source_checks');
      if (sourceChecks.has(c.evidence_id)) err('DUPLICATE_SOURCE_CHECK', c.evidence_id, '重复');
      sourceChecks.set(c.evidence_id, c);
      if (evidence.has(c.evidence_id) && c.excerpt_sha256 !== evidence.get(c.evidence_id).excerpt_sha256) err('REVIEW_EXCERPT_HASH', c.evidence_id, '源核验绑定的片段不同');
    }
    const factChecks = new Map();
    for (const c of review.fact_checks) {
      if (!factMap.has(c.fact_id)) err('REVIEW_FACT_ID', c.fact_id, '未知事实');
      if (factChecks.has(c.fact_id)) err('DUPLICATE_FACT_CHECK', c.fact_id, '重复');
      factChecks.set(c.fact_id, c);
      for (const eid of c.checked_evidence_ids) ref(eid, ['evidence'], '$review.fact_checks');
    }
    const actuallyApproved = review.fact_checks.filter(c => c.verdict === 'approved').map(c => c.fact_id);
    if (!setEqual(review.approved_fact_ids, actuallyApproved) || !setEqual(review.approved_fact_ids, p.publish_fact_ids)) err('APPROVAL_SET', '$review.approved_fact_ids', '批准、逐项审查和拟发布集合须完全一致');
    for (const id of p.publish_fact_ids) {
      const f = factMap.get(id), check = factChecks.get(id);
      if (!f) continue;
      if (!check || check.verdict !== 'approved') { err('FACT_NOT_APPROVED', id, '缺逐项批准'); continue; }
      if (!setEqual(check.checked_evidence_ids, f.evidence_ids)) err('FACT_REVIEW_EVIDENCE', id, '审查证据集不完整');
      const hasChinese = /\p{Script=Han}/u.test(f.note) || f.evidence_ids.some(eid => !!evidence.get(eid)?.translation_zh);
      if (check.translation_verdict === 'rejected' || (hasChinese && check.translation_verdict !== 'approved')) err('TRANSLATION_NOT_APPROVED', id, '事实中文说明或译文未通过');
    }
    const nodeChecks = new Map();
    for (const c of review.node_checks) {
      ref(c.node_id, NODE_FIELDS, '$review.node_checks');
      if (nodeChecks.has(c.node_id)) err('DUPLICATE_NODE_CHECK', c.node_id, '重复节点审查');
      nodeChecks.set(c.node_id, c);
      for (const eid of c.checked_evidence_ids) ref(eid, ['evidence'], '$review.node_checks');
    }
    const approvedNodes = review.node_checks.filter(c => c.verdict === 'approved').map(c => c.node_id);
    if (!setEqual(review.approved_node_ids, approvedNodes) || !setEqual(review.approved_node_ids, plan.node_ids)) err('NODE_APPROVAL_SET', '$review.approved_node_ids', '节点批准、逐项检查与正式闭包须完全一致');
    for (const id of plan.node_ids) {
      const found = plan.nodeMap.get(id), c = nodeChecks.get(id);
      if (!found) continue;
      if (!c || c.verdict !== 'approved') { err('NODE_NOT_APPROVED', id, '缺结构化节点批准'); continue; }
      const needed = plan.nodeEvidence.get(id) || [];
      if (!setEqual(c.checked_fields, PUBLISH_FIELDS[found.type])) err('NODE_FIELDS_NOT_REVIEWED', id, '允许展示的全部语义字段须明确核对');
      if (!setEqual(c.checked_evidence_ids, needed)) err('NODE_REVIEW_EVIDENCE', id, '节点定义/身份/forms证据未完整审查');
      if (c.translation_verdict === 'rejected' || (nodeNeedsTranslation(found.node, found.type, needed, evidence) && c.translation_verdict !== 'approved')) err('NODE_TRANSLATION_NOT_APPROVED', id, '节点中文文案或关联译文未批准');
    }
    for (const eid of plan.evidence_ids) {
      const c = sourceChecks.get(eid);
      if (!c || !c.actual_source_checked || !c.license_checked || !c.attribution_checked) err('SOURCE_NOT_REVIEWED', eid, '闭包证据缺实际来源/许可/归属核验');
    }
  }
  return errors;
}

function taskCheck(id, errors, {dependencyMerged} = {}) {
  const err = (c, w, d) => issue(errors, c, w, d);
  const index = jsonFile(kitRel('tasks/index.json'));
  if (index.schema_version !== '1.0.0' || index.execution_policy !== 'sequential_one_agent' || !Array.isArray(index.tasks)) throw new Error('TASK_INDEX_FORMAT');
  const ids = new Set();
  for (const row of index.tasks) {
    if (!PID.test(row.id) || ids.has(row.id)) err('TASK_INDEX_ID', 'tasks/index.json', String(row.id));
    ids.add(row.id);
    if (row.file !== `tasks/${row.id}.json`) err('TASK_FILE_PATH', row.id, String(row.file));
  }
  const record = index.tasks.find(x => x.id === id);
  if (!record) throw new Error('TASK_NOT_REGISTERED: ' + id);
  const t = jsonFile(kitRel(`tasks/${id}.json`));
  if (t.id !== id || t.schema_version !== '1.0.0') err('TASK_ID_VERSION', id, '任务号或版本错误');
  for (const key of ['owner', 'status', 'dependencies', 'sense_scope', 'allowed_sources', 'output_dir', 'outputs', 'acceptance', 'return_limit']) if (!own(t, key)) err('TASK_REQUIRED', id, key);
  if (t.owner !== null && typeof t.owner !== 'string') err('TASK_OWNER', id, 'owner须为空或身份字符串');
  if (record.status !== t.status || record.owner !== t.owner || JSON.stringify(record.dependencies) !== JSON.stringify(t.dependencies)) err('TASK_INDEX_MISMATCH', id, '索引与任务字段不一致');
  if (!['ready', 'in_progress', 'ready_for_review', 'ready_for_merge', 'merged', 'blocked'].includes(t.status)) err('TASK_STATUS', id, String(t.status));
  if (t.output_dir !== `toefl-lab/docs/word-root-universe/staging/${id}`) err('TASK_OUTPUT_PATH', id, String(t.output_dir));
  if (!Array.isArray(t.dependencies) || t.dependencies.some(x => !PID.test(x) || !ids.has(x) || x === id)) err('TASK_DEPENDENCIES', id, '依赖须指向已登记其他任务');
  for (const file of ['packet.json', 'review.json', 'review.md', 'handoff.md']) if (!t.outputs?.includes(file)) err('TASK_OUTPUT_REQUIRED', id, file);
  if (t.return_limit !== 2 || !t.acceptance?.length || !t.allowed_sources?.length || !Array.isArray(t.sense_scope?.candidate_headwords) || !t.sense_scope.candidate_headwords.length) err('TASK_CONTRACT', id, '缺范围/来源/验收或返工上限');
  for (const dep of t.dependencies || []) {
    const d = index.tasks.find(x => x.id === dep);
    if (d && !(dependencyMerged ? dependencyMerged(dep) : d.status === 'merged')) err('TASK_DEPENDENCY_PENDING', id, dep);
  }
  return t;
}

function fixture() {
  // 全部为合成标识与合成事实，无真实词源；永远只在内存，不写staging。
  const packetId = 'P9999';
  const id = n => packetId + ':' + n;
  const node = n => ({id: id(n), origin_packet: packetId, record_role: 'owned'});
  const e = {id:id('e1'),source_family:'synthetic',url:'https://example.invalid/synthetic',entry:'SYNTHETIC',locator:'synthetic line 1',source_version:'synthetic-v1',retrieved_at:'2026-11-06T00:00:00Z',license:'CC0-1.0',attribution:'合成夹具，无真实来源',original_text:'SYNTHETIC ONLY: invented test assertion.',excerpt_sha256:'',translation_zh:'仅测试：此句为合成断言。',translation_note:'合成译文，不可发布',captured_by:'synthetic-author'};
  e.excerpt_sha256 = sha(Buffer.from(e.original_text, 'utf8'));
  const p = {schema_version:'1.1.0',packet_id:packetId,synthetic:true,authors:['synthetic-author'],created_at:'2026-11-06T00:00:00Z',scope:'合成测试，不是真实词源',
    headwords:[{...node('h1'),language:'x-synthetic',display:'SyntheticA',lookup_key:'synthetica',aliases:[],course_member:false,evidence_ids:[id('e1')]}],
    etymologies:[{...node('t1'),headword_id:id('h1'),identity_note:'合成来源身份A',source_locators:[{evidence_id:id('e1'),source_version:'synthetic-v1',etymology_number:'1',location:'synthetic A'}]},{...node('t2'),headword_id:id('h1'),identity_note:'合成同形来源身份B',source_locators:[]}],
    senses:[{...node('s1'),headword_id:id('h1'),etymology_id:id('t1'),pos:'noun',sense_key:'synthetic-one',definition_original:'Synthetic definition',definition_zh:'合成定义',evidence_ids:[id('e1')],coverage:{modern:'pending',historical:'pending',family:'pending'},coverage_notes:'合成，未实测'}],
    morphemes:[{...node('m1'),language:'x-synthetic',kind:'root',forms:[{form:'synthetic',kind:'lemma',evidence_ids:[id('e1')]}]}],
    evidence:[e],analyses:[],relations:[{id:id('r1'),from_id:id('s1'),to_id:id('m1'),type:'historical_derived_from',layer:'historical',assertion:'positive',evidence_ids:[id('e1')],status:'source_verified',author:'synthetic-author',note:'合成关系，无事实主张'}],
    homograph_groups:[{id:id('g1'),headword_id:id('h1'),etymology_ids:[id('t1'),id('t2')],note:'合成隔离约束'}],redirects:[],publish_fact_ids:[id('r1')],publish_node_ids:[id('h1'),id('t1'),id('s1'),id('m1')]};
  const raw = Buffer.from(JSON.stringify(p, null, 2) + '\n');
  const r = {schema_version:'1.1.0',packet_id:packetId,synthetic:true,packet_sha256:sha(raw),reviewer:'synthetic-reviewer',translation_reviewer:'synthetic-translator',review_run_id:'synthetic-review-run',translation_run_id:'synthetic-translation-run',reviewed_at:'2026-11-06T00:00:00Z',decision:'ready_for_merge',approved_fact_ids:[id('r1')],source_checks:[{evidence_id:id('e1'),excerpt_sha256:e.excerpt_sha256,actual_source_checked:true,license_checked:true,attribution_checked:true,notes:'仅合成签署，无网络核验'}],fact_checks:[{fact_id:id('r1'),verdict:'approved',checked_evidence_ids:[id('e1')],translation_verdict:'approved',notes:'合成节点及译文检查'}],blockers:[]};
  const plan = publicationPlan(p);
  r.approved_node_ids = [...plan.node_ids];
  r.node_checks = plan.node_ids.map(nid => ({node_id:nid,verdict:'approved',checked_fields:[...PUBLISH_FIELDS[plan.nodeMap.get(nid).type]],checked_evidence_ids:[...plan.nodeEvidence.get(nid)],translation_verdict:'approved',notes:'仅合成节点结构化签署'}));
  return {p,r,raw};
}

function selfTest(schema) {
  const errors = [], checks = [];
  const required = ['00-项目任务书.md','README.md','01-目标与阶段计划.md','02-数据与合并契约.md','03-子agent操作手册.md','04-workflow与验收.md','05-首段框架任务书.md','root-universe.workflow.ts','schema/packet.schema.json','tasks/index.json','tasks/P0001.json','prompts/01-规划者.md','prompts/02-资料获取者.md','prompts/03-词族整理者.md','prompts/04-独立来源复核者.md','prompts/05-中文译文复核者.md','prompts/06-整合者.md'];
  for (const rel of required) {
    try { readFile(kitRel(rel)); checks.push({name:'readable:' + rel,ok:true}); }
    catch (e) { issue(errors, 'KIT_READABLE', rel, e.message); }
  }
  try { readFile(path.join('pipeline','root-universe','validate-kit.cjs')); checks.push({name:'readable:validator',ok:true}); }
  catch (e) { issue(errors, 'KIT_READABLE', 'validator', e.message); }
  schemaLint(schema, schema, errors);
  try {
    const index = jsonFile(kitRel('tasks/index.json'));
    for (const t of index.tasks || []) taskCheck(t.id, errors);
    checks.push({name:'task-manifest',ok:!errors.some(e => e.code.startsWith('TASK'))});
  } catch (e) { issue(errors, 'TASK_MANIFEST', 'tasks', e.message); }
  const run = (name, mutate, code, stage='verified', allowSynthetic=true) => {
    const f = fixture();
    if (mutate) mutate(f);
    // hash反例以外，变异后按新内容绑定，确保拒绝点不是偶然的旧hash。
    const raw = Buffer.from(JSON.stringify(f.p, null, 2) + '\n');
    if (code !== 'REVIEW_HASH' && f.r) f.r.packet_sha256 = sha(raw);
    const found = validatePacket(f.p, raw, f.r, stage, schema, {allowSynthetic});
    const ok = code ? found.some(e => e.code === code) : found.length === 0;
    checks.push({name,ok,expected:code || 'accept',actual_codes:[...new Set(found.map(e => e.code))]});
    if (!ok) issue(errors, 'SELF_TEST_CASE', name, JSON.stringify(found));
  };
  if (!errors.some(e => e.code.startsWith('SCHEMA_'))) {
    run('有效合成包通过', null, null);
    run('候选包无审查可通过', f => { f.p.publish_fact_ids=[]; f.p.publish_node_ids=[]; f.p.relations[0].status='candidate'; f.r=null; }, null, 'candidate');
    run('拒绝悬空ID', f => {f.p.relations[0].to_id='P9999:missing';}, 'DANGLING_ID');
    run('拒绝未许可来源', f => {f.p.evidence[0].license='unconfirmed';}, 'LICENSE_UNCONFIRMED');
    run('拒绝来源许可错配', f => {f.p.evidence[0].license='CC-BY-SA-3.0';}, 'LICENSE_POLICY');
    run('拒绝无事实证据', f => {f.p.relations[0].evidence_ids=[];}, 'FACT_EVIDENCE_REQUIRED');
    run('拒绝作者自审', f => {f.r.reviewer='synthetic-author';}, 'SELF_REVIEW');
    run('拒绝作者自审译文', f => {f.r.translation_reviewer='synthetic-author';}, 'SELF_REVIEW');
    run('拒绝旧内容hash', f => {f.p.scope += ' changed';}, 'REVIEW_HASH');
    run('拒绝片段hash不符', f => {f.p.evidence[0].original_text+=' changed';}, 'EXCERPT_HASH');
    run('拒绝candidate当正式边', f => {f.p.relations[0].status='candidate';}, 'CANDIDATE_PUBLISHED');
    run('拒绝自填独立通过', f => {f.p.relations[0].status='independent_verified';}, 'AUTHOR_VERIFIED');
    run('拒绝缺独立来源核验', f => {f.r.source_checks=[];}, 'SOURCE_NOT_REVIEWED');
    run('拒绝缺译文批准', f => {f.r.fact_checks[0].translation_verdict='not_applicable';}, 'TRANSLATION_NOT_APPROVED');
    run('拒绝批准集合不一致', f => {f.r.approved_fact_ids=[];}, 'APPROVAL_SET');
    run('拒绝同形异源混并', f => {f.p.redirects.push({id:'P9999:d1',action:'merge',from_id:'P9999:t1',to_ids:['P9999:t2'],reason:'合成错误合并',evidence_ids:['P9999:e1']});}, 'HOMOGRAPH_MERGE');
    run('拒绝重复关系', f => {f.p.relations.push({...f.p.relations[0],id:'P9999:r2'});}, 'DUPLICATE_RELATION');
    run('拒绝冲突关系', f => {f.p.relations.push({...f.p.relations[0],id:'P9999:r2',assertion:'negative'});}, 'CONFLICT_RELATION');
    run('拒绝现代历史层混淆', f => {f.p.relations[0].layer='modern';}, 'LAYER_TYPE');
    const nodeEvidence = (f, license='CC0-1.0') => {
      const e = {...f.p.evidence[0],id:'P9999:e2',license,original_text:'SYNTHETIC ONLY: node evidence.'};
      e.excerpt_sha256=sha(Buffer.from(e.original_text,'utf8'));
      f.p.evidence.push(e);
      f.p.senses[0].evidence_ids=[e.id]; f.p.morphemes[0].forms[0].evidence_ids=[e.id];
      for (const c of f.r.node_checks) if (['P9999:s1','P9999:m1'].includes(c.node_id)) c.checked_evidence_ids=[e.id];
    };
    run('拒绝节点定义及forms未许可证据', f => nodeEvidence(f,'unconfirmed'), 'LICENSE_UNCONFIRMED');
    run('拒绝节点闭包缺独立来源审查', f => nodeEvidence(f), 'SOURCE_NOT_REVIEWED');
    run('拒绝节点闭包使用候选来源', f => {
      nodeEvidence(f,'CC-BY-SA-3.0'); const e=f.p.evidence[1]; e.source_family='morphynet'; e.url='https://github.com/kbatsuren/MorphyNet';
    }, 'PUBLISH_SOURCE');
    run('拒绝只有节点中文却标译文不适用', f => {
      f.p.evidence[0].translation_zh=''; f.p.relations[0].note='Synthetic assertion';
      f.r.fact_checks[0].translation_verdict='not_applicable';
      f.r.node_checks.find(c=>c.node_id==='P9999:s1').translation_verdict='not_applicable';
    }, 'NODE_TRANSLATION_NOT_APPROVED');
    run('拒绝节点字段未结构化批准', f => {f.r.node_checks[0].checked_fields=[];}, 'SCHEMA_ITEMS');
    run('拒绝节点字段批准不全', f => {f.r.node_checks[0].checked_fields=['display'];}, 'NODE_FIELDS_NOT_REVIEWED');
    run('拒绝节点审查证据遗漏', f => {f.r.node_checks.find(c=>c.node_id==='P9999:m1').checked_evidence_ids=[];}, 'NODE_REVIEW_EVIDENCE');
    run('拒绝只有边批准没有节点批准', f => {f.r.node_checks=[];f.r.approved_node_ids=[];}, 'NODE_APPROVAL_SET');
    run('拒绝漏报正式节点闭包', f => {f.p.publish_node_ids=['P9999:s1'];}, 'PUBLISH_NODE_SET');
    run('拒绝正式词头无证据', f => {f.p.headwords[0].evidence_ids=[];}, 'NODE_EVIDENCE_REQUIRED');
    run('拒绝现代派生使用纯词源端点', f => {
      Object.assign(f.p.relations[0],{type:'modern_derived_from',layer:'modern',from_id:'P9999:t1',to_id:'P9999:t2'});
    }, 'REFERENCE_TYPE');
    run('无关未许可候选可留staging', f => {
      const e={...f.p.evidence[0],id:'P9999:e2',license:'unconfirmed'}; f.p.evidence.push(e);
      f.p.morphemes.push({...clone(f.p.morphemes[0]),id:'P9999:m2',forms:[{form:'unresolved-synthetic',kind:'lemma',evidence_ids:[e.id]}]});
    }, null);
    run('单条disputed记录保留正反证据可通过候选', f => {
      f.p.publish_fact_ids=[];f.p.publish_node_ids=[];f.p.relations[0].status='disputed';
      const e={...f.p.evidence[0],id:'P9999:e2',original_text:'SYNTHETIC counter evidence.'};e.excerpt_sha256=sha(Buffer.from(e.original_text,'utf8'));f.p.evidence.push(e);
      f.p.relations[0].evidence_ids.push(e.id);f.p.relations[0].note='合成争议：保留正反主张及全部证据，未裁决。';
    }, null, 'candidate');
    const coverageFixture=fixture();
    Object.assign(coverageFixture.p.relations[0],{from_id:'P9999:t1',to_id:'P9999:t2'});
    const coverage=directCoverageProjection(coverageFixture.p);
    const noExpansion=coverage.modern_sense_ids.length===0&&coverage.historical_sense_ids.length===0;
    checks.push({name:'纯词源身份边不扩算全部词义覆盖',ok:noExpansion,actual:coverage});
    if(!noExpansion) issue(errors,'SELF_TEST_COVERAGE','directCoverageProjection','错误扩算词义');
    run('拒绝合成进入真实门禁', null, 'SYNTHETIC_FORBIDDEN', 'verified', false);
  }
  // CLI参数路径保护不写文件。
  const badIds = ['../P0001','P0001/../../x','p0001','P001','P00001','P0001\\x'];
  const guarded = badIds.every(x => !PID.test(x));
  checks.push({name:'任务号拒绝越界格式',ok:guarded});
  if (!guarded) issue(errors, 'SELF_TEST_PATH', 'packet_id', '非法任务号被接受');
  return {ok:errors.length===0,mode:'self-test',schema_version:'1.1.0',checks,errors,limits:['仅检查本地结构/引用/字节与审查声明；不认证真实来源或语言学事实','合成夹具只在内存，不写真实staging','未执行真实batch、应用测试或产品发布']};
}

function argsOf(argv) {
  if (argv.length === 1 && argv[0] === '--self-test') return {selfTest:true};
  if (argv.length !== 4) throw new Error('USAGE: --self-test 或 --packet P0001 --stage candidate|verified');
  const pairs = {};
  for (let i=0;i<argv.length;i+=2) {
    const key = argv[i];
    if (!['--packet','--stage'].includes(key) || own(pairs,key)) throw new Error('ARGUMENT_INVALID: ' + key);
    pairs[key]=argv[i+1];
  }
  if (!PID.test(pairs['--packet'] || '') || !['candidate','verified'].includes(pairs['--stage'])) throw new Error('ARGUMENT_INVALID: 任务号或阶段');
  return {packet:pairs['--packet'],stage:pairs['--stage']};
}
function main() {
  const args = argsOf(process.argv.slice(2));
  const schema = jsonFile(kitRel('schema/packet.schema.json'));
  if (args.selfTest) return selfTest(schema);
  const errors = [];
  schemaLint(schema, schema, errors);
  if (errors.length) return {ok:false,mode:args.stage,errors};
  const task = taskCheck(args.packet, errors);
  const base = `staging/${args.packet}`;
  const raw = readFile(kitRel(`${base}/packet.json`));
  const packet = JSON.parse(raw.toString('utf8'));
  if (packet.packet_id !== args.packet) issue(errors,'PACKET_ID_MISMATCH',base,'包ID与目录不同');
  let review = null;
  if (args.stage === 'verified') {
    review = jsonFile(kitRel(`${base}/review.json`));
    readFile(kitRel(`${base}/review.md`));
  }
  readFile(kitRel(`${base}/handoff.md`));
  errors.push(...validatePacket(packet,raw,review,args.stage,schema));
  if (Array.isArray(packet.headwords) && Array.isArray(packet.senses)) for (const word of task.sense_scope?.candidate_headwords || []) {
    const matches = packet.headwords.filter(h => h.lookup_key === normalized(word) && h.course_member);
    if (!matches.length || !matches.some(h => packet.senses.some(s => s.headword_id===h.id))) issue(errors,'TASK_SCOPE_MISSING',word,'需课程词头及词义或显式未决身份');
  }
  if (Array.isArray(packet.evidence)) {
    const allowed = new Set((task.allowed_sources || []).map(x => x.family));
    for (const e of packet.evidence) if (!allowed.has(e.source_family)) issue(errors,'TASK_SOURCE_FORBIDDEN',e.id,e.source_family);
  }
  return {ok:errors.length===0,mode:args.stage,packet:args.packet,packet_sha256:sha(raw),checks:[{name:'task/schema/references/evidence/review',ok:errors.length===0}],errors,limits:['未认证来源事实、许可实际授权或agent身份；仍需独立来源复核及全局整合']};
}
module.exports = {validatePacket, taskCheck, publicationPlan, directCoverageProjection, PUBLISH_FIELDS, NODE_FIELDS, FIELDS, normalized, sha, safeFile, schemaLint, shape, fixture, selfTest,
  loadSchema: () => jsonFile(kitRel('schema/packet.schema.json'))};
if (require.main === module) {
  try {
    const result = main();
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(JSON.stringify({ok:false,errors:[{code:'IO_OR_ARGUMENT_ERROR',detail:e.message}]}) + '\n');
    process.exitCode = 1;
  }
}
