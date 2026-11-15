(function () {
  'use strict';
  const origin = window.TINGKE_ORIGIN || location.origin;
  const pending = new Map();
  const prefix = 'tingke-' + Math.random().toString(36).slice(2) + '-';
  let counter = 0, connected = false, ready;
  const timed = (promise,ms=60000) => new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('���ӳ�ʱ���ز����ڱ������ϴ�')),ms);Promise.resolve(promise).then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});
  async function fetchSafe(url,options) {const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),45000);try{return await fetch(url,{...options,signal:controller.signal});}finally{clearTimeout(timer);}}
  // Only our MCP resource sets this flag. A normal iframe may contain unrelated
  // host-injected window.openai metadata and must still use same-origin REST.
  const embedded = window.TINGKE_EMBEDDED === true;
  function rpc(method, params, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const id = prefix + (++counter);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('GPT ������ӳ�ʱ�����������������ҳ')); }, timeout);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || event.data.jsonrpc !== '2.0') return;
    const p = pending.get(event.data.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(event.data.id);
    if (event.data.error) p.reject(new Error(event.data.error.message || '�������ʧ��'));
    else p.resolve(event.data.result);
  });
  async function connect() {
    if (!embedded) return false;
    if (!ready) ready = (async () => {
      try {
        await rpc('ui/initialize', { appInfo: {name:'tingke-pocket',version:'0.1.0'}, appCapabilities:{}, protocolVersion:'2026-01-26' }, 1800);
        window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}}, '*');
        connected = true;
      } catch (error) {
        if (window.openai?.callTool) connected = true;
        else throw error;
      }
      return true;
    })();
    try{return await ready;}catch(error){ready=undefined;connected=false;throw error;}
  }
  async function call(name, args) {
    await connect();
    let result;
    if (connected && !window.openai?.callTool) result = await rpc('tools/call', {name,arguments:args}, 60000);
    else result = await timed(window.openai.callTool(name, args));
    if (result?.isError) throw new Error(result.content?.find(c => c.type === 'text')?.text || '�������ʧ��');
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.find(c => c.type === 'text')?.text;
    if (text) { try { return JSON.parse(text); } catch {} }
    return result;
  }
  function encode(bytes) {
    let result = '';
    for (let i = 0; i < bytes.length; i += 32768) result += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(result);
  }
  async function decodeResponse(data) {
    if (data.error) throw new Error(data.error);
    return data;
  }
  window.TingkeApi = {
    embedded, origin,
    async request(method, path, body) {
      if (embedded) return decodeResponse(await call('app_request', {method,path,body}));
      const r = await fetchSafe(path, {method, credentials:'same-origin', headers: body === undefined ? {} : {'Content-Type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)});
      const data = await r.json().catch(() => ({error: r.status === 401 ? '���ȵ�¼������' : '�����ݲ�����'}));
      if (!r.ok) throw new Error(data.error || '����ʧ��');
      return decodeResponse(data);
    },
    async upload(lessonId, asset) {
      const meta = {...asset}; delete meta.blob;
      if (embedded) return decodeResponse(await call('app_request',{method:'PUT',path:'/api/lessons/'+lessonId+'/assets/'+asset.id,body:{meta,base64:encode(new Uint8Array(await asset.blob.arrayBuffer()))}}));
      const encoded = encode(new TextEncoder().encode(JSON.stringify(meta)));
      const r = await fetchSafe('/api/lessons/'+lessonId+'/assets/'+asset.id,{method:'PUT',headers:{'Content-Type':asset.mime,'X-Tingke-Meta':encoded},body:asset.blob,credentials:'same-origin'});
      const data = await r.json(); if (!r.ok) throw new Error(data.error || '�ϴ�δ�ɹ�'); return data;
    },
    async media(lessonId, assetId) {
      if (embedded) {
        const data = await call('app_request',{method:'GET',path:'/api/media/'+lessonId+'/'+assetId});
        if (data.error) throw new Error(data.error);
        return new Blob([Uint8Array.from(atob(data.base64),c=>c.charCodeAt(0))],{type:data.mime});
      }
      const r = await fetchSafe('/api/media/'+lessonId+'/'+assetId,{credentials:'same-origin'});
      if (!r.ok) throw new Error('��ʱ�޷���ȡ�ز�'); return r.blob();
    },
    async ask(prompt) {
      if (!embedded) return false;
      await connect();
      if (window.openai?.sendFollowUpMessage) await window.openai.sendFollowUpMessage({prompt});
      else await rpc('ui/message',{role:'user',content:[{type:'text',text:prompt}]});
      return true;
    }
  };
})();
