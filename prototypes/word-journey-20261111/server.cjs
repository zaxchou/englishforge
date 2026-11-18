'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {createServer}=require('../../root-universe/server.cjs');
const api=createServer();
const assets={'/':['index.html','text/html; charset=utf-8'],'/index.html':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/brand.png':['../../root-universe/public/brand.png','image/png']};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(req.method!=='GET'){req.resume();res.writeHead(405);return res.end();}
  if(url.pathname.startsWith('/api/'))return api.emit('request',req,res);
  const asset=assets[url.pathname];if(!asset){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'"});
  fs.createReadStream(path.resolve(__dirname,asset[0])).pipe(res);
});
const port=Number(process.env.WORD_JOURNEY_PORT||8075);
server.listen(port,'127.0.0.1',()=>console.log('Word journey: http://127.0.0.1:'+port));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeAllConnections();});
