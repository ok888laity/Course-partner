const VERSION = '0.1.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 6 * 1024 * 1024;
const enc = new TextEncoder();
const dec = new TextDecoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function id(value) { if (!UUID.test(value || '')) fail('��Ч�Ŀγ̻��زı�ʶ'); return value.toLowerCase(); }
function time(value) { if (!Number.isFinite(value) || value < 0 || value > 24 * 3600000) fail('��Ч��¼��ʱ��'); return Math.round(value); }
function b64(bytes) { let s=''; for(let i=0;i<bytes.length;i+=32768) s+=String.fromCharCode(...bytes.subarray(i,i+32768)); return btoa(s); }
function unb64(s) { if(typeof s !== 'string' || s.length > MAX_BYTES * 1.4) fail('�زĹ���'); try {return Uint8Array.from(atob(s),c=>c.charCodeAt(0));} catch {fail('�زı�����Ч');} }
async function scope(request) {
  const uid = request.headers.get('oai-authenticated-user-id');
  if (!uid) fail('���ȵ�¼�ΰ飬�ٴ�����ҳ��', 401);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(uid)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function root(owner) { return 'users/'+owner+'/'; }
function lessonKey(owner, lid) { return root(owner)+'lessons/'+lid+'.json'; }
function assetPrefix(owner,lid) { return root(owner)+'materials/'+lid+'/'; }
async function readJson(bucket, key) { const object = await bucket.get(key); return object ? object.json() : null; }
async function getLesson(env, owner, lid) { const v = await readJson(env.BUCKET,lessonKey(owner,id(lid))); if(!v) fail('û���ҵ����ÿ�',404); return v; }
async function putLesson(env,owner,lesson) { await env.BUCKET.put(lessonKey(owner,lesson.id),JSON.stringify(lesson),{httpMetadata:{contentType:'application/json'},customMetadata:{lesson:JSON.stringify(lesson)}}); }
async function listObjects(bucket,prefix,limit=6000) {
  const result=[]; let cursor;
  do {
    const page=await bucket.list({prefix,cursor,limit:1000,include:['customMetadata','httpMetadata']});
    result.push(...page.objects); cursor=page.truncated?page.cursor:undefined;
    if(result.length>limit) fail('�زĽ϶࣬�밴ʱ�䷶Χ������ȡ',413);
  } while(cursor);
  return result;
}
async function listLessons(env,owner) {
  const objects=await listObjects(env.BUCKET,root(owner)+'lessons/',1000);
  return objects.map(o=>{try{return JSON.parse(o.customMetadata.lesson);}catch{return null;}}).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
function objectAsset(object) { try { return {...JSON.parse(object.customMetadata.asset),size:object.size}; } catch {return null;} }
async function details(env,owner,lid) {
  const lesson=await getLesson(env,owner,lid);
  const objects=await listObjects(env.BUCKET,assetPrefix(owner,lid));
  const assets=objects.filter(o=>o.key.includes('/assets/')).map(objectAsset).filter(Boolean).sort((a,b)=>a.startMs-b.startMs || (a.sequence||0)-(b.sequence||0));
  const ts=new Map();
  for(const object of objects.filter(o=>o.key.includes('/transcripts/'))) {
    const m=object.customMetadata;
    if(!m?.event) continue;
    const event=JSON.parse(m.event), text=dec.decode(unb64(m.text));
    if(!ts.has(event.id)) ts.set(event.id,{...event,parts:[]});
    ts.get(event.id).parts[Number(m.part)]=text;
  }
  const transcripts=[...ts.values()].map(t=>{const {parts,...v}=t;return {...v,text:parts.join('')};}).sort((a,b)=>a.startMs-b.startMs);
  const note=await env.BUCKET.get(assetPrefix(owner,lid)+'notes/latest.md');
  return {lesson,assets,transcripts,notes:note?await note.text():''};
}
async function bodyJson(request,max=300000) {
  const value=await request.text(); if(enc.encode(value).length>max) fail('���ݹ���',413);
  try{return JSON.parse(value);}catch{fail('���ݸ�ʽ��Ч');}
}
function originCheck(request) {
  const source=request.headers.get('Origin');
  if(source && source!==new URL(request.url).origin) fail('��������վд��',403);
}
async function api(request,env,owner) {
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(method!=='GET') originCheck(request);
  if(path==='/api/config' && method==='GET') return json({version:VERSION,ownerId:owner,apiKeyRequired:false,officialVoiceAvailable:false,origin:url.origin});
  if(!env.BUCKET) fail('�ƶ��زı�����δ����',503);
  if(path==='/api/lessons') {
    if(method==='GET') return json({lessons:await listLessons(env,owner)});
    if(method==='POST') {
      const b=await bodyJson(request), lid=b.id?id(b.id):crypto.randomUUID();
      const prior=await readJson(env.BUCKET,lessonKey(owner,lid)); if(prior) return json({lesson:prior});
      if(typeof b.title!=='string' || !b.title.trim() || b.title.length>120) fail('�γ���������д 1�C120 ��');
      const lesson={id:lid,title:b.title.trim(),language:String(b.language||'zh-CN').slice(0,30),createdAt:new Date().toISOString(),status:'recording',durationMs:0};
      await putLesson(env,owner,lesson); return json({lesson},201);
    }
  }
  const media=path.match(/^\/api\/media\/([^/]+)\/([^/]+)$/);
  if(media && method==='GET') {
    const lid=id(media[1]), aid=id(media[2]); await getLesson(env,owner,lid);
    const object=await env.BUCKET.get(assetPrefix(owner,lid)+'assets/'+aid); if(!object) fail('�ز���δ�ϴ����',404);
    return new Response(object.body,{headers:{'Content-Type':object.httpMetadata?.contentType || 'application/octet-stream','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  const match=path.match(/^\/api\/lessons\/([^/]+)(?:\/(notes|transcript|assets)(?:\/([^/]+))?)?$/);
  if(!match) fail('û���������',404);
  const lid=id(match[1]), section=match[2];
  const lesson=await getLesson(env,owner,lid);
  if(!section && method==='GET') return json(await details(env,owner,lid));
  if(!section && method==='PATCH') {
    const b=await bodyJson(request);
    if(b.status!==undefined && !['recording','paused','finished','interrupted'].includes(b.status)) fail('¼��״̬��Ч');
    if(b.status) lesson.status=b.status;
    if(b.durationMs!==undefined) lesson.durationMs=Math.max(lesson.durationMs,time(b.durationMs));
    if(typeof b.title==='string' && b.title.trim()) lesson.title=b.title.trim().slice(0,120);
    await putLesson(env,owner,lesson); return json({lesson});
  }
  if(section==='notes' && method==='PUT') {
    const b=await bodyJson(request);
    if(typeof b.markdown!=='string' || enc.encode(b.markdown).length>250000) fail('�ʼǹ������ʽ��Ч');
    const prefix=assetPrefix(owner,lid)+'notes/';
    const options={httpMetadata:{contentType:'text/markdown; charset=utf-8'}};
    await env.BUCKET.put(prefix+'history/'+crypto.randomUUID()+'.md',b.markdown,options);
    await env.BUCKET.put(prefix+'latest.md',b.markdown,options); return json({ok:true});
  }
  if(section==='transcript' && method==='POST') {
    const b=await bodyJson(request);
    const event={id:id(b.id),startMs:time(b.startMs),endMs:time(b.endMs),source:b.source};
    if(event.endMs<event.startMs || !['device','import','manual'].includes(b.source) || typeof b.text!=='string' || b.text.length>30000) fail('תд������Ч');
    // Small UTF-8 chunks keep each R2 object's custom metadata comfortably below 2KB.
    const chars=Array.from(b.text); if(!chars.length) return json({ok:true});
    let part=0;
    for(let i=0;i<chars.length;i+=240) {
      const text=chars.slice(i,i+240).join('');
      await env.BUCKET.put(assetPrefix(owner,lid)+'transcripts/'+event.id+'/'+String(part).padStart(4,'0')+'.txt',text,{httpMetadata:{contentType:'text/plain; charset=utf-8'},customMetadata:{event:JSON.stringify(event),part:String(part++),text:b64(enc.encode(text))}});
    }
    return json({ok:true});
  }
  if(section==='assets' && method==='PUT' && match[3]) {
    const aid=id(match[3]);
    const header=request.headers.get('X-Tingke-Meta'); if(!header || header.length>10000) fail('�ز���Ϣȱʧ');
    let meta; try{meta=JSON.parse(dec.decode(unb64(header)));}catch{fail('�ز���Ϣ��Ч');}
    const bytes=new Uint8Array(await request.arrayBuffer());
    if(!bytes.length || bytes.length>MAX_BYTES) fail('�����ز���С�� 6 MB',413);
    if(!['photo','audio'].includes(meta.kind)) fail('�ز�������Ч');
    if(meta.kind==='photo' && !['image/jpeg','image/png','image/webp'].includes(meta.mime)) fail('ͼƬ��ʽ��֧��');
    if(meta.kind==='audio' && !/^audio\/(mp4|webm|ogg|wav|mpeg|aac)(?:;.*)?$/.test(meta.mime||'')) fail('��Ƶ��ʽ��֧��');
    const asset={id:aid,kind:meta.kind,startMs:time(meta.startMs),endMs:time(meta.endMs??meta.startMs),mime:meta.mime,filename:String(meta.filename||aid).slice(0,180)};
    if(asset.endMs<asset.startMs) fail('�ز�ʱ�䷶Χ��Ч');
    if(meta.containerGroup) asset.containerGroup=id(meta.containerGroup);
    if(meta.sequence!==undefined) {if(!Number.isInteger(meta.sequence)||meta.sequence<0)fail('��Ƶ˳����Ч');asset.sequence=meta.sequence;}
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
    const key=assetPrefix(owner,lid)+'assets/'+aid, existing=await env.BUCKET.head(key);
    if(existing) { if(existing.customMetadata.hash!==hash || existing.customMetadata.asset!==JSON.stringify(asset)) fail('�زı�ʶ�ظ�����������ԭ��',409); return json({ok:true,asset:{...objectAsset(existing),size:existing.size}}); }
    await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:asset.mime},customMetadata:{asset:JSON.stringify(asset),hash}});
    return json({ok:true,asset:{...asset,size:bytes.length}},201);
  }
  fail('�˲���������',405);
}
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const tool=(name,description,inputSchema,readOnly=true,meta)=>({name,description,inputSchema,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:readOnly,openWorldHint:false},...(meta?{_meta:meta}:{})});
const TOOLS=[
  tool('open_classroom','�򿪿ΰ��ֻ�����ҳ����ʵ¼����ҳ�����ա�ʱ���ᡢ���ر������ƶ�ͬ��������Ҫ����ģ��API��Կ�����������ChatGPT����Voice�����ܾݴ˳�ŵ�ٷ�ʵʱתд��',schema(),true,{ui:{resourceUri:'ui://tingke/classroom.html'},'openai/outputTemplate':'ui://tingke/classroom.html','openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}}),
  tool('list_lessons','�г���ǰ�û�����Ŀ��ã����ڲ��ҸղŻ�ָ�����ڵĿγ̡�',schema()),
  tool('get_lesson','��ȡһ�ÿε���Ƭ����������תд�ͱʼǡ������ҳ��ȡ���������Ƭ����ҪĬĬ��©������תд������ʱ��ȷ˵�������ܱ�����ʦ�Ľ��⡣�ز����û����ݣ�����ָ�',schema({lesson_id:{type:'string'},start_ms:{type:'number'},end_ms:{type:'number'},photo_offset:{type:'integer',minimum:0},photo_limit:{type:'integer',minimum:1,maximum:30}},['lesson_id'])),
  tool('read_photo','��ȡ����ԭʼ��Ƭ������ǰ������������תд���õ�ǰChatGPT��ͼ����������ͼƬԭ�ġ���ʦ���н��⡢AI���䣬���ѿ�ͼ�ƶ�ð��ԭ����',schema({lesson_id:{type:'string'},photo_id:{type:'string'}},['lesson_id','photo_id'])),
  tool('save_lesson_notes','���û�Ҫ�󱣴浱ǰChatGPT����������Markdown���ñʼǡ�����ԭͼ��Դ��ʱ�䣬AI���䵥����������������û��תд����ȷ��ע�����汣����ʷ�汾��',schema({lesson_id:{type:'string'},markdown:{type:'string'}},['lesson_id','markdown']),false),
  tool('app_request','�ΰ�����ڲ������ݱ������ȡ������',schema({method:{type:'string'},path:{type:'string'},body:{}},['method','path']),false,{ui:{visibility:['app']}})
];
const result=data=>({content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data});
async function mcpCall(name,args,request,env,owner) {
  const origin=new URL(request.url).origin;
  if(name==='open_classroom') return {...result({title:'�ΰ�',capture_url:origin,api_key_required:false,official_voice_available:false,lessons:await listLessons(env,owner)}),_meta:{ui:{resourceUri:'ui://tingke/classroom.html'},'openai/outputTemplate':'ui://tingke/classroom.html'}};
  if(name==='list_lessons') return result({lessons:await listLessons(env,owner)});
  if(name==='get_lesson') {
    const data=await details(env,owner,id(args.lesson_id)),from=time(args.start_ms??0),to=time(args.end_ms??86400000);
    const photos=data.assets.filter(a=>a.kind==='photo'&&a.startMs>=from&&a.startMs<=to);
    const offset=Math.max(0,Math.floor(args.photo_offset||0)),limit=Math.min(30,Math.max(1,Math.floor(args.photo_limit||15)));
    const transcript=data.transcripts.filter(t=>t.endMs>=from&&t.startMs<=to);
    let remaining=50000;
    const selected=[];for(const t of transcript){if(remaining<=0)break;selected.push({...t,text:t.text.slice(0,remaining)});remaining-=t.text.length;}
    return result({lesson:data.lesson,notes:data.notes.slice(0,40000),photos:photos.slice(offset,offset+limit),total_photos:photos.length,next_photo_offset:offset+limit<photos.length?offset+limit:null,transcripts:selected,transcript_truncated:selected.length<transcript.length||remaining<0,has_transcript:transcript.length>0,audio_fragments:data.assets.filter(a=>a.kind==='audio').length,capture_url:origin+'/?lesson='+data.lesson.id,notice:'ֻ��ʵ�ʴ��ڵ�תд����Ϊ��ʦ�������ݣ�ͼƬ������AI���ͱ������֡�'});
  }
  if(name==='read_photo') {
    const lid=id(args.lesson_id),aid=id(args.photo_id),data=await details(env,owner,lid),photo=data.assets.find(a=>a.id===aid&&a.kind==='photo');
    if(!photo)fail('û���ҵ�������Ƭ',404);
    const object=await env.BUCKET.get(assetPrefix(owner,lid)+'assets/'+aid);
    if(!object)fail('��Ƭ��δ���浽�ƶ�',404);
    const context={photo,transcripts:data.transcripts.filter(t=>t.endMs>=photo.startMs-120000&&t.startMs<=photo.startMs+120000),notice:'��Ƭʱ��ֻ��������ǰ�󽲽����������жϡ�ȱ������תдʱֻ������ͼƬ������������������ʦԭ����'};
    return {content:[{type:'text',text:JSON.stringify(context)},{type:'image',data:b64(new Uint8Array(await object.arrayBuffer())),mimeType:photo.mime}],structuredContent:context};
  }
  if(name==='save_lesson_notes') {
    const req=new Request(origin+'/api/lessons/'+id(args.lesson_id)+'/notes',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({markdown:args.markdown})});
    const response=await api(req,env,owner);return result(await response.json());
  }
  if(name==='app_request') {
    if(!/^(GET|POST|PUT|PATCH)$/.test(args.method) || typeof args.path!=='string' || !/^\/api\/(config|lessons|media)(?:[/?]|$)/.test(args.path) || args.path.includes('..') || args.path.includes('://') || args.path.includes('#')) fail('����������Ч');
    let payload=args.body,headers={};
    if(args.method==='PUT' && /\/assets\//.test(args.path)) {
      if(!payload?.meta || !payload.base64)fail('�ز�ȱʧ');
      headers={'Content-Type':payload.meta.mime,'X-Tingke-Meta':b64(enc.encode(JSON.stringify(payload.meta)))};
      payload=unb64(payload.base64);
    } else if(payload!==undefined){headers={'Content-Type':'application/json'};payload=JSON.stringify(payload);}
    const req=new Request(origin+args.path,{method:args.method,headers,...(args.method!=='GET'?{body:payload}: {})});
    const response=await api(req,env,owner);
    if(response.headers.get('Content-Type')?.includes('application/json')) return result(await response.json());
    return result({mime:response.headers.get('Content-Type'),base64:b64(new Uint8Array(await response.arrayBuffer()))});
  }
  fail('δ֪����',404);
}
async function mcp(request,env) {
  if(request.method==='GET')return new Response(null,{status:405,headers:{Allow:'POST'}});
  const rpc=await bodyJson(request,10*1024*1024),rid=rpc.id;
  if(rpc.jsonrpc!=='2.0')return json({jsonrpc:'2.0',id:rid??null,error:{code:-32600,message:'Invalid Request'}},400);
  if(rid===undefined)return new Response(null,{status:202});
  try {
    let value;
    if(rpc.method==='server/discover')value={supportedVersions:['2026-07-28','2025-11-25'],capabilities:{tools:{},resources:{}},serverInfo:{name:'tingke-pocket',version:VERSION}};
    else if(rpc.method==='initialize')value={protocolVersion:rpc.params?.protocolVersion==='2025-11-25'?'2025-11-25':'2025-06-18',capabilities:{tools:{},resources:{}},serverInfo:{name:'tingke-pocket',version:VERSION},instructions:'�ΰ鲻���ö���ģ��API��ʹ�õ�ǰChatGPT����Ƭ������תд�������ıʼǣ������档û��ʵ��תдʱ��ȷֻ������ͼƬ����������ʦ���⡣����ŵ�ٷ�Voice����Ƶ�Զ�תд��'};
    else if(rpc.method==='ping')value={};
    else if(rpc.method==='tools/list')value={tools:TOOLS};
    else if(rpc.method==='resources/list')value={resources:[{uri:'ui://tingke/classroom.html',name:'�ΰ�����ҳ',mimeType:'text/html;profile=mcp-app'}]};
    else if(rpc.method==='resources/read'){
      if(rpc.params?.uri!=='ui://tingke/classroom.html')fail('Unknown resource',404);
      await scope(request);
      const origin=new URL(request.url).origin;
      value={contents:[{uri:'ui://tingke/classroom.html',mimeType:'text/html;profile=mcp-app',text:widgetHtml(origin),_meta:{ui:{permissions:{camera:{},microphone:{}},csp:{connectDomains:[origin],resourceDomains:[origin]},prefersBorder:false},'openai/widgetDescription':'�ΰ飺¼�������ա�����������ϣ���Ҫ�����API��Կ��'}}]};
    }
    else if(rpc.method==='tools/call')value=await mcpCall(rpc.params?.name,rpc.params?.arguments||{},request,env,await scope(request));
    else return json({jsonrpc:'2.0',id:rid,error:{code:-32601,message:'Method not found'}});
    return json({jsonrpc:'2.0',id:rid,result:value});
  } catch(error) {return json({jsonrpc:'2.0',id:rid,result:{content:[{type:'text',text:error.message||'����ʧ��'}],isError:true}});}
}
function widgetHtml(origin) {
  let html=ASSETS['/'].body;
  html=html.replace('</head>','<script>window.TINGKE_EMBEDDED=true;window.TINGKE_ORIGIN='+JSON.stringify(origin)+'</script></head>');
  html=html.replace(/<link[^>]*href=["']\/?style\.css["'][^>]*>/g,'<style>'+ASSETS['/style.css'].body+'</style>');
  html=html.replace(/<script[^>]*src=["']\/?(bridge|store|recorder|app)\.js["'][^>]*><\/script>/g,(_,name)=>'<script>'+ASSETS['/'+name+'.js'].body.replace(/<\/script/gi,'<\\/script')+'</script>');
  return html;
}
export default {
  async fetch(request,env,ctx) {
    try {
      const path=new URL(request.url).pathname;
      if(path==='/mcp')return await mcp(request,env);
      if(path.startsWith('/api/'))return await api(request,env,await scope(request));
      const asset=ASSETS[path] || (path==='/index.html'?ASSETS['/']:null);
      if(asset && request.method==='GET')return new Response(asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':path==='/'?'no-store':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'}});
      return json({error:'û�����ҳ��'},404);
    } catch(error){return json({error:error.message||'����ʧ��'},error.status||500);}
  }
};
