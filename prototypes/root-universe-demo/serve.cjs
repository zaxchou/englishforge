'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const routes=new Map([
 ['/', ['index.html','text/html; charset=utf-8']],
 ['/index.html',['index.html','text/html; charset=utf-8']],
 ['/brand.png',['brand.png','image/png']]
]);
const port=Number(process.env.ROOT_DEMO_PORT||4186);
const server=http.createServer((req,res)=>{
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{'Allow':'GET, HEAD'});res.end();return;}
 let url;try{url=new URL(req.url,'http://127.0.0.1');}catch{res.writeHead(400);res.end();return;}
 const route=routes.get(url.pathname);
 if(!route){res.writeHead(404);res.end('Not found');return;}
 try{
  const bytes=fs.readFileSync(path.join(__dirname,route[0]));
  res.writeHead(200,{'Content-Type':route[1],'Cache-Control':'no-store','Content-Length':bytes.length,'X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:bytes);
 }catch{res.writeHead(500);res.end('Demo file unavailable');}
});
server.on('error',e=>{console.error(e.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('Word family demos: http://127.0.0.1:'+server.address().port));
