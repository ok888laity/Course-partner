import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileBucket } from './bucket.mjs';
const worker = (await import('../dist/server/index.js?dev='+Date.now())).default;
const bucket = new FileBucket(resolve('.data'));
const port=Number(process.env.PORT||8787);
const server=http.createServer(async(req,res)=>{
  try {
    if(req.url==='/__preview/mobile') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>�ΰ� �� �ֻ��ߴ�Ԥ��</title><body style="margin:0;background:#e5e9e2;display:grid;place-items:center;min-height:100vh"><iframe title="�ΰ��ֻ��ߴ�Ԥ��" src="/" width="390" height="844" style="border:0;border-radius:26px;box-shadow:0 20px 80px #142d2320;background:white"></iframe></body></html>');return;}
    // Local development identity is only injected by this localhost runner, never the deployed worker.
    const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','local-development-user');
    const method=req.method;const parts=[];if(method!=='GET'&&method!=='HEAD')for await(const b of req)parts.push(b);
    const request=new Request('http://127.0.0.1:'+port+req.url,{method,headers,...(parts.length?{body:Buffer.concat(parts)}:{})});
    const response=await worker.fetch(request,{BUCKET:bucket},{});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
server.listen(port,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+port));
