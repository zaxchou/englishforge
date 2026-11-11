/* 词根词典 NAS 挂载（2026-11-07）：复用 root-universe 事实索引 + 已发布学习档案，
   只读服务 /dict/ 静态页与 /dict/api/*。与独立 8036 预览同一套核心逻辑。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ASSETS = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'alliance-ui.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'brand.png': 'image/png',
};
export const DICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
export function createRootDict({ project }) {
  const dir = path.join(project, 'root-universe');
  const ws = require(path.join(dir, 'workspace.cjs'));
  const build = require(path.join(dir, 'build.cjs'));
  const core = require(path.join(dir, 'core.cjs'));
  const learning = require(path.join(dir, 'learning.cjs'));
  const discovery = require(path.join(dir, 'discovery.cjs'));
  const base = ws.ROOT;
  ws.controlled(base);
  let snapshot = null, token = null;
  function current() {
    const pointer = ws.bytes(base, 'current.json'), p = JSON.parse(pointer);
    if (!/^v-[a-f0-9]{64}$/.test(p.version)) throw Error('VERSION_INVALID');
    const next = pointer.toString() + ['index.json', 'registry.json', 'manifest.json']
      .map(name => { const st = fs.statSync(ws.file(base, `versions/${p.version}/${name}`)); return st.size + ':' + st.mtimeMs; }).join('|');
    if (next !== token) { snapshot = build.current(base); token = next; }
    return snapshot;
  }
  function learningById(id) {
    const index = current().index;
    let d = learning.query(index, id, { base });
    if (d && d.status === 'unresolved') {
      /* 事实词条尚无学习档案时回退到同拼写已复核学习词（与独立服务一致） */
      const sense = index.nodes.find(n => n.id === id && n.type === 'senses');
      const head = sense ? index.nodes.find(n => n.id === sense.headword_id) : null;
      const alt = head ? learning.catalog(index, { base }).find(w => w.label.toLowerCase() === head.display.toLowerCase()) : null;
      if (alt) { const altResult = learning.query(index, alt.id, { base }); if (altResult && altResult.status === 'reviewed') d = altResult; }
    }
    return d;
  }
  /* 返回 true=已处理。sendJSON 由宿主提供（生产统一头）；静态资源由宿主 sendFile 发送。 */
  function handle(req, res, pathname, url, sendJSON, sendFile) {
    if (pathname === '/dict' || pathname === '/dict/') {
      if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method' }), true;
      if (pathname === '/dict') {
        res.writeHead(308, { Location: '/dict/' + url.search, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      res.setHeader('Content-Security-Policy', DICT_CSP);
      sendFile(req, res, path.join(dir, 'public', 'index.html'));
      return true;
    }
    const asset = /^\/dict\/([\w.\-]+)$/.exec(pathname);
    if (asset) {
      const type = ASSETS[asset[1]];
      if (!type) return sendJSON(res, 404, { error: 'not found' }), true;
      if (req.method !== 'GET') return sendJSON(res, 405, { error: 'method' }), true;
      res.setHeader('Content-Security-Policy', DICT_CSP);
      if (asset[1] === 'index.html') res.setHeader('Cache-Control', 'no-store');
      sendFile(req, res, path.join(dir, 'public', asset[1]));
      return true;
    }
    if (!pathname.startsWith('/dict/api/')) return false;
    if (req.method !== 'GET') return sendJSON(res, 405, { error: 'READ_ONLY' }), true;
    if (url.pathname.length > 2048) return sendJSON(res, 414, { error: 'URL_LIMIT' }), true;
    const routes = {
      '/dict/api/health': [],
      '/dict/api/graph': [],
      '/dict/api/search': ['q', 'max'],
      '/dict/api/roots': ['q'],
      '/dict/api/root': ['id'],
      '/dict/api/node': ['id'],
      '/dict/api/neighbors': ['id', 'depth', 'maxNodes', 'maxEdges', 'layer', 'type', 'direction'],
      '/dict/api/source': ['id'],
      '/dict/api/learning': ['id'],
    };
    const route = routes[pathname];
    if (!route) return sendJSON(res, 404, { error: 'NOT_FOUND' }), true;
    for (const key of url.searchParams.keys()) if (!route.includes(key) || url.searchParams.getAll(key).length !== 1) return sendJSON(res, 400, { error: 'PARAMETER_INVALID' }), true;
    res.setHeader('Cache-Control', 'no-store');
    let snap;
    try { snap = current(); } catch (e) { return sendJSON(res, 503, { error: e.code === 'ENOENT' ? 'INDEX_MISSING' : 'INDEX_UNAVAILABLE', message: '词族内容暂未就绪，请稍后重试。' }), true; }
    const index = snap.index, get = k => url.searchParams.get(k);
    const number = k => url.searchParams.has(k) ? (/^[0-9]+$/.test(get(k)) ? Number(get(k)) : NaN) : undefined;
    try {
      if (pathname === '/dict/api/health') return sendJSON(res, 200, { ok: true, version: snap.manifest.version, counts: snap.manifest.counts }), true;
      if (pathname === '/dict/api/graph') return sendJSON(res, 200, discovery.graph(index, { base })), true;
      if (pathname === '/dict/api/search') return sendJSON(res, 200, discovery.search(index, get('q') || '', { max: number('max'), base })), true;
      if (pathname === '/dict/api/roots') return sendJSON(res, 200, discovery.roots(index, get('q') || '', { base })), true;
      if (pathname === '/dict/api/root') { const d = discovery.root(index, get('id') || '', { base }); return sendJSON(res, d ? 200 : 404, d || { error: 'UNKNOWN_ROOT' }), true; }
      const id = core.inputText(get('id') || '', 80);
      if (pathname === '/dict/api/learning') { const d = learningById(id); return sendJSON(res, d ? 200 : 404, d || { error: 'UNKNOWN_NODE' }), true; }
      if (!/^P\d{4}:[a-z][a-z0-9_-]*$/.test(id)) throw Error('ID_INVALID');
      if (pathname === '/dict/api/node') { const d = core.detail(index, id); return sendJSON(res, d ? 200 : 404, d || { error: 'UNKNOWN_NODE' }), true; }
      if (pathname === '/dict/api/source') { const e = index.evidence.find(e => e.id === id); return sendJSON(res, e ? 200 : 404, e || { error: 'UNKNOWN_SOURCE' }), true; }
      const result = core.neighbors(index, id, { depth: number('depth'), maxNodes: number('maxNodes'), maxEdges: number('maxEdges'), layer: get('layer') || 'all', type: get('type') || 'all', direction: get('direction') || 'both' });
      return sendJSON(res, result.found ? 200 : 404, result), true;
    } catch (e) { return sendJSON(res, 400, { error: e.message }), true; }
  }
  return { handle, current };
}
