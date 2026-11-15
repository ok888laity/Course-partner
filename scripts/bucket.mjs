import { mkdir, readFile, writeFile, readdir, rename, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
export class FileBucket {
  constructor(directory) { this.directory=resolve(directory); }
  file(key) { const p=resolve(this.directory,key); if(!p.startsWith(this.directory+sep))throw new Error('Invalid storage key');return p; }
  async put(key,value,options={}) {
    const bytes=typeof value==='string'?Buffer.from(value):Buffer.from(value);
    const target=this.file(key);await mkdir(resolve(target,'..'),{recursive:true});
    const etag=createHash('sha256').update(bytes).digest('hex');
    const meta={key,size:bytes.length,etag,httpEtag:'"'+etag+'"',httpMetadata:options.httpMetadata||{},customMetadata:options.customMetadata||{}};
    const temp=target+'.'+randomUUID()+'.tmp';await writeFile(temp,bytes);await rename(temp,target);
    await writeFile(target+'.meta.json',JSON.stringify(meta));return meta;
  }
  async get(key) { try {const [bytes,meta]=await Promise.all([readFile(this.file(key)),this.head(key)]);if(!meta)return null;return {...meta,body:bytes,arrayBuffer:async()=>Uint8Array.from(bytes).buffer,text:async()=>bytes.toString(),json:async()=>JSON.parse(bytes.toString())};}catch(e){if(e.code==='ENOENT')return null;throw e;} }
  async head(key) {try {return JSON.parse(await readFile(this.file(key)+'.meta.json','utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;} }
  async list({prefix='',cursor,limit=1000}) {
    const keys=[];
    async function walk(dir) {for(const e of await readdir(dir,{withFileTypes:true}).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))){const p=join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.meta.json')){const meta=JSON.parse(await readFile(p,'utf8'));if(meta.key.startsWith(prefix))keys.push(meta);}}}
    await walk(this.directory);keys.sort((a,b)=>a.key.localeCompare(b.key));
    const start=cursor?Number(cursor):0,objects=keys.slice(start,start+limit),truncated=start+limit<keys.length;
    return {objects,truncated,...(truncated?{cursor:String(start+limit)}:{})};
  }
}
