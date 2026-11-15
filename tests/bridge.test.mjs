import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../web/bridge.js',import.meta.url),'utf8');
test('ordinary embedded browser page uses REST even if host adds unrelated openai metadata',async()=>{
  let calls=0;const window={parent:{postMessage(){throw new Error('Must not use host bridge');}},openai:{theme:'light'},addEventListener(){}};
  const ctx=vm.createContext({window,location:{origin:'https://class.example'},fetch:async()=>{calls++;return {ok:true,json:async()=>({ownerId:'abc'})};},AbortController,setTimeout,clearTimeout,TextEncoder,Blob,Uint8Array,btoa,atob});
  vm.runInContext(source,ctx);assert.equal(window.TingkeApi.embedded,false);const data=await window.TingkeApi.request('GET','/api/config');assert.equal(data.ownerId,'abc');assert.equal(calls,1);
});
test('MCP resource opts into host transport explicitly',()=>{
  const window={TINGKE_EMBEDDED:true,TINGKE_ORIGIN:'https://class.example',parent:{},addEventListener(){}};
  vm.runInNewContext(source,{window,location:{origin:'https://sandbox.example'},setTimeout,clearTimeout,TextEncoder,Blob,Uint8Array,btoa,atob});
  assert.equal(window.TingkeApi.embedded,true);assert.equal(window.TingkeApi.origin,'https://class.example');
});
