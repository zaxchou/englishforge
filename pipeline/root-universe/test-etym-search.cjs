const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSources, licenseOf, domainOf, BLOCKED } = require('../../root-universe/etym-search.cjs');

test('pickSources dedupes by domain, ranks by rerank+authority, and blocks OED by licensing rule', () => {
  const results = [
    { url: 'https://www.etymonline.com/word/port', title: 'port | etymonline', rerank_score: 2.2, authority: 3 },
    { url: 'https://etymonline.com/word/port', title: 'port | etymonline (same domain)', rerank_score: 3.0, authority: 3 },
    { url: 'https://www.oed.com/dictionary/port', title: 'port | OED', rerank_score: 3.0, authority: 4 },
    { url: 'https://en.wiktionary.org/wiki/port', title: 'port - Wiktionary', rerank_score: 1.9, authority: 2 },
    { url: 'https://randomblog.example.net/post', title: 'blog', rerank_score: 1.2, authority: 0 },
    { url: 'https://www.etymonline.com/search?q=port#1', title: 'etymonline search page', rerank_score: 2.8, authority: 3 },
    { url: 'https://example.org/thesis.pdf', title: 'pdf', rerank_score: 2.5, authority: 3 },
  ];
  const picked = pickSources(results, 6);
  assert.equal(picked.length, 3, 'search pages and PDFs are dropped, fragments stripped');
  assert.ok(picked.every(p => !p.url.includes('#') && !/\/search\?|\.pdf/.test(p.url)));
  assert.ok(!picked.some(p => p.url.includes('oed.com')), 'OED must never be picked (语料许可边界)');
  assert.equal(new Set(picked.map(p => p.dom)).size, picked.length, 'one page per domain');
  assert.equal(picked[0].dom, 'etymonline.com', 'preferred domain + authority wins');
  assert.equal(picked[1].dom, 'en.wiktionary.org');
});
test('license notes separate reusable sources from verify-only captures', () => {
  assert.match(licenseOf('https://en.wiktionary.org/wiki/port'), /CC BY-SA/);
  assert.match(licenseOf('https://www.etymonline.com/word/port'), /不得原文进产品/);
  assert.equal(licenseOf('https://some-forum.example.com/thread'), 'unknown-verify-only');
  assert.equal(domainOf('https://www.etymonline.com/word/x'), 'etymonline.com');
  assert.ok(BLOCKED.includes('oed.com'));
});

test('planSources prefers rich preferred-domain summaries before spending any fetch',()=>{
  const {planSources}=require('../../root-universe/etym-search.cjs');
  const results=[
    {url:'https://www.etymonline.com/word/visible#1',title:'visible',rerank_score:2.5,authority:3,summary:'from Latin visibilis...'.repeat(12)},
    {url:'https://random.example.com/x',title:'x',rerank_score:1.0,authority:0,summary:'short'}
  ];
  const plan=planSources(results,{snippetFirst:true});
  assert.equal(plan.mode,'summaries','long preferred-domain summary means zero fetch calls');
  assert.equal(plan.pages[0].url,'https://www.etymonline.com/word/visible');
  const thin=planSources([{url:'https://www.etymonline.com/word/visible',title:'v',rerank_score:2.5,authority:3,summary:'too short'}],{snippetFirst:true});
  assert.equal(thin.mode,'fetch','thin summaries fall back to fetching pages');
  assert.equal(thin.picks[0].url,'https://www.etymonline.com/word/visible');
});
test('spendGuard enforces the daily call cap and resets by UTC day',()=>{
  const {spendGuard}=require('../../root-universe/etym-search.cjs');
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'etym-spend-'));
  const g=spendGuard(dir,3);g.add(3);
  assert.throws(()=>spendGuard(dir,3),/上限/,'over-budget lookups are refused');
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'_spend.json'),'utf8'));
  assert.equal(saved.calls,3);
  saved.day='2000-01-01';fs.writeFileSync(path.join(dir,'_spend.json'),JSON.stringify(saved));
  const g2=spendGuard(dir,3);g2.add(1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'_spend.json'),'utf8')).day,new Date().toISOString().slice(0,10));
});
