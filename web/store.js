(function () {
  'use strict';
  let db;
  const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  async function tx(name, mode, work) {
    if (!db) throw new Error('���ر�����δ׼����');
    const t = db.transaction(name, mode);
    const done = new Promise((resolve, reject) => { t.oncomplete = resolve; t.onabort = () => reject(t.error || new Error('���ر��汻�ж�')); t.onerror = () => reject(t.error || new Error('���ر���ʧ��')); });
    try { const result = await work(t.objectStore(name)); await done; return result; }
    catch (error) { await done.catch(() => {}); throw error; }
  }
  const put = (store, value) => tx(store, 'readwrite', s => request(s.put(value)));
  const get = (store, key) => tx(store, 'readonly', s => request(s.get(key)));
  const all = store => tx(store, 'readonly', s => request(s.getAll()));
  const queueRecord = r => ({...r,id:['asset','transcript','create'].includes(r.type)?r.type+':'+(r.payload?.id||r.lessonId):r.id,queuedAt:r.queuedAt||Date.now()});
  async function persistAndQueue(store,value,record) {
    if(!db)throw new Error('���ر�����δ׼����');
    const t=db.transaction([store,'queue'],'readwrite');
    const done=new Promise((resolve,reject)=>{t.oncomplete=resolve;t.onabort=()=>reject(t.error||new Error('���ر����ж�'));t.onerror=()=>reject(t.error||new Error('���ر���ʧ��'));});
    t.objectStore(store).put(value);t.objectStore('queue').put(queueRecord(record));
    await done;
  }
  window.TingkeStore = {
    async init(ownerId) {
      if (!ownerId || !/^[a-f0-9]{64}$/.test(ownerId)) throw new Error('�޷�ȷ�ϱ������������˺�');
      if (db) db.close();
      const open = indexedDB.open('tingke-pocket-' + ownerId, 1);
      open.onupgradeneeded = () => {
        for (const name of ['lessons', 'assets', 'transcripts', 'queue', 'notes']) {
          open.result.createObjectStore(name, { keyPath: 'id' });
        }
      };
      db = await request(open);
      db.onversionchange = () => db.close();
    },
    putLesson: async lesson => (await get('lessons',lesson.id)) ? put('lessons',lesson) : persistAndQueue('lessons',lesson,{id:'create:'+lesson.id,lessonId:lesson.id,type:'create',payload:{id:lesson.id,title:lesson.title,language:lesson.language}}),
    lessons: async () => (await all('lessons')).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    getLesson: id => get('lessons', id),
    queue: record => put('queue', queueRecord(record)),
    pending: async lessonId => (await all('queue')).filter(r => !lessonId || r.lessonId === lessonId).sort((a,b) => (a.type==='create'?0:1)-(b.type==='create'?0:1)||a.queuedAt - b.queuedAt),
    ack: id => tx('queue', 'readwrite', s => request(s.delete(id))),
    putAsset: (lessonId, asset) => persistAndQueue('assets',{...asset,lessonId},{id:'asset:'+asset.id,lessonId,type:'asset',payload:asset}),
    getAsset: async (lessonId,assetId) => {const asset=await get('assets',assetId);return asset?.lessonId===lessonId?asset:null;},
    assets: async lessonId => (await all('assets')).filter(r => r.lessonId === lessonId).sort((a,b) => a.startMs - b.startMs || (a.sequence || 0) - (b.sequence || 0)),
    putTranscript: (lessonId, transcript) => persistAndQueue('transcripts',{...transcript,lessonId},{id:'transcript:'+transcript.id,lessonId,type:'transcript',payload:transcript}),
    transcripts: async lessonId => (await all('transcripts')).filter(r => r.lessonId === lessonId).sort((a,b) => a.startMs - b.startMs),
    saveNotes: (lessonId, markdown) => persistAndQueue('notes',{id:lessonId,markdown},{id:'notes:'+crypto.randomUUID(),lessonId,type:'notes',payload:{markdown}}),
    getNotes: async lessonId => (await get('notes', lessonId))?.markdown || ''
  };
})();
