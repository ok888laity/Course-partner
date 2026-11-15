/* �ΰ�: dependency-free, real capture, explicit provenance. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {ready:false,config:null,lesson:null,lessons:[],assets:[],transcripts:[],recorder:null,recordState:'idle',recordingId:null,offset:0,camera:null,dictation:null,dictating:false,flushing:false,pending:0,syncError:'',urls:new Map(),photoPromises:new Map(),mediaGeneration:0,selectedPhoto:null,audioUrl:null,audioGroups:[],audioGroup:null,notesDirty:false,toastTimer:null,busy:false,lastDictationMs:0};
  let photoObserver,lastPhotoGeneration=0,cameraGeneration=0,cameraStarting=false;
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const uuid = () => crypto.randomUUID();
  const duration = ms => {
    const total = Math.max(0,Math.floor((Number(ms)||0)/1000));
    const h = Math.floor(total/3600),m = Math.floor(total%3600/60),s = total%60;
    return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  };
  const prettyDate = value => new Date(value).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});
  const el = (tag,className,text) => { const node=document.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; };
  const active = () => ['recording','paused','stopping'].includes(state.recordState);
  const clock = () => state.recorder && state.recordingId===state.lesson?.id ? Math.max(Number(state.lesson?.durationMs)||0,state.offset+state.recorder.elapsedMs()) : Number(state.lesson?.durationMs)||0;
  const fileSafe = title => (title||'����¼��').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100);
  function toast(message,error=false) { clearTimeout(state.toastTimer); $('toast').textContent=message; $('toast').classList.toggle('error',error); $('toast').hidden=false; state.toastTimer=setTimeout(()=>$('toast').hidden=true,error?8500:4200); }
  function explain(error) {
    if(error?.name==='NotAllowedError'||error?.name==='SecurityError')return 'û�л����˷�����Ȩ�ޡ�������Ȩ�ޣ���� GPT �ڵ�ҳ�治֧�֣����������������';
    if(error?.name==='NotFoundError')return 'û���ҵ����õ���˷������������豸��';
    if(error?.name==='NotReadableError')return '�豸��ʱ����������ռ�á������ͨ��������¼�������ԡ�';
    if(error?.name==='QuotaExceededError')return '�����洢�ռ䲻�㡣���ȵ����ѱ������ϡ��ͷſռ䣬�ټ�����¼��';
    return error?.message||'����δ��ɣ������ԡ�';
  }
  function setTab(name) { tabs.forEach(button=>{const yes=button.dataset.tab===name;button.classList.toggle('active',yes);button.setAttribute('aria-selected',String(yes));}); ['capture','photos','notes'].forEach(key=>$(`panel-${key}`).hidden=key!==name); }
  tabs.forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.tab)));
  function openLibrary(){ $('libraryDrawer').hidden=false;$('drawerBackdrop').hidden=false;renderLibrary(); }
  function closeLibrary(){ $('libraryDrawer').hidden=true;$('drawerBackdrop').hidden=true; }
  $('libraryButton').addEventListener('click',openLibrary);$('closeLibrary').addEventListener('click',closeLibrary);$('drawerBackdrop').addEventListener('click',closeLibrary);
  function browserLink(node) { const origin=window.TingkeApi?.origin||location.origin;node.href=`${origin}/${state.lesson?`?lesson=${encodeURIComponent(state.lesson.id)}`:''}`; }
  async function init(){
    $('connectionError').hidden=true;$('connectionText').textContent='��������';
    try{
      const config=await TingkeApi.request('GET','/api/config');
      if(!config.ownerId)throw new Error('δȷ�ϵ�ǰ�˺����ݣ������µ�¼��򿪿ΰ顣');
      state.config=config;await TingkeStore.init(config.ownerId);state.ready=true;
      browserLink($('connectBrowser'));browserLink($('cameraBrowserLink'));
      const localLessons=await TingkeStore.lessons();
      for(const lesson of localLessons){if(['recording','paused'].includes(lesson.status)){lesson.status='interrupted';await TingkeStore.putLesson(lesson);await TingkeStore.queue({id:`status-${uuid()}`,lessonId:lesson.id,type:'status',payload:{status:'interrupted',durationMs:lesson.durationMs||0},queuedAt:Date.now()});}}
      await refreshLessons();
      const wanted=new URL(location.href).searchParams.get('lesson');
      if(wanted&&state.lessons.some(lesson=>lesson.id===wanted))await loadLesson(wanted);
      else if(wanted){try{await loadLesson(wanted);}catch(error){toast(explain(error),true);}}
      else if(state.lessons.length)await loadLesson(state.lessons[0].id);
      render();await updateQueueStatus();void flushQueue();
      if(localLessons.some(lesson=>lesson.status==='interrupted'))toast('�ѻָ���������Ŀγ��زġ�ҳ��ر��ڼ�û�м���¼����');
    }catch(error){
      state.ready=false;$('connectionError').hidden=false;$('connectionErrorText').textContent=explain(error);browserLink($('connectBrowser'));$('connectionText').textContent='����δ���';render();
    }
  }
  $('retryConnection').addEventListener('click',()=>void init());
  async function refreshLessons(){
    const local=await TingkeStore.lessons();const merged=new Map(local.map(lesson=>[lesson.id,lesson]));
    const unsynced=await TingkeStore.pending();
    try{const remote=await TingkeApi.request('GET','/api/lessons');for(const lesson of remote.lessons||[]){const localLesson=merged.get(lesson.id);if(!localLesson||!unsynced.some(record=>record.lessonId===lesson.id&&['create','status'].includes(record.type)))merged.set(lesson.id,lesson);}}catch(error){state.syncError=explain(error);}
    state.lessons=[...merged.values()].sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));renderLibrary();
  }
  function renderLibrary(){
    $('lessonList').replaceChildren();$('libraryEmpty').hidden=state.lessons.length>0;
    for(const lesson of state.lessons){const button=el('button','lesson-item');button.classList.toggle('current',lesson.id===state.lesson?.id);button.append(el('strong','',lesson.title||'δ��������'));const small=el('small');small.append(el('span','',prettyDate(lesson.createdAt)),el('span','',`${duration(lesson.durationMs)} �� ${statusText(lesson.status)}`));button.append(small);button.addEventListener('click',async()=>{if(active()&&lesson.id!==state.recordingId){toast('���Ƚ�������¼�Ƶ����ÿΣ����л��γ̡�');return;}try{await loadLesson(lesson.id);closeLibrary();}catch(error){toast(explain(error),true);}});$('lessonList').append(button);}
  }
  const statusText=status=>({recording:'¼����',paused:'����ͣ',finished:'�ѽ���',interrupted:'�ɼ��ж�'}[status]||'�ѱ���');
  function clearMedia(){state.mediaGeneration++;if(photoObserver)photoObserver.disconnect();for(const url of state.urls.values())URL.revokeObjectURL(url);state.urls.clear();state.photoPromises.clear();if(state.audioUrl)URL.revokeObjectURL(state.audioUrl);state.audioUrl=null;state.audioGroup=null;$('audioPlayer').pause();$('audioPlayer').removeAttribute('src');$('audioPlayer').hidden=true;}
  async function loadLesson(id){
    if(state.notesDirty&&state.lesson){await TingkeStore.saveNotes(state.lesson.id,$('notesEditor').value);state.notesDirty=false;await updateQueueStatus();void flushQueue();}
    clearMedia();let lesson=await TingkeStore.getLesson(id);let remote=null;const localPending=await TingkeStore.pending(id);
    try{remote=await TingkeApi.request('GET',`/api/lessons/${id}`);}catch(error){if(!lesson)throw error;state.syncError=explain(error);}
    if(!lesson&&!remote?.lesson)throw new Error('û���ҵ����ÿΡ�');
    const localStatusPending=lesson&&localPending.some(record=>['create','status'].includes(record.type));
    state.lesson=active()&&state.recordingId===id?state.lesson:localStatusPending?lesson:(remote?.lesson||lesson);
    if(!active()&&localStatusPending&&['recording','paused'].includes(state.lesson.status)){state.lesson.status='interrupted';await TingkeStore.queue({id:`status-${uuid()}`,lessonId:id,type:'status',payload:{status:'interrupted',durationMs:state.lesson.durationMs||0},queuedAt:Date.now()});}
    const localAssets=await TingkeStore.assets(id);const byId=new Map((remote?.assets||[]).map(asset=>[asset.id,asset]));for(const asset of localAssets){const {blob,...meta}=asset;byId.set(asset.id,{...byId.get(asset.id),...meta});}state.assets=[...byId.values()].map(asset=>({...asset,lessonId:id})).sort((a,b)=>a.startMs-b.startMs||(a.sequence??0)-(b.sequence??0));
    const localText=await TingkeStore.transcripts(id);const byText=new Map((remote?.transcripts||[]).map(item=>[item.id,item]));for(const item of localText)byText.set(item.id,item);state.transcripts=[...byText.values()].sort((a,b)=>a.startMs-b.startMs);
    const localNotes=await TingkeStore.getNotes(id);$('notesEditor').value=(localPending.some(record=>record.type==='notes')?localNotes:remote?.notes!==undefined?remote.notes:localNotes)||'';state.notesDirty=false;
    await TingkeStore.putLesson(state.lesson);upsertLesson(state.lesson);browserLink($('cameraBrowserLink'));try{history.replaceState(null,'',`?lesson=${encodeURIComponent(id)}`);}catch{}render();
  }
  function upsertLesson(lesson){const i=state.lessons.findIndex(item=>item.id===lesson.id);if(i>=0)state.lessons[i]={...lesson};else state.lessons.unshift({...lesson});renderLibrary();}
  async function queue(type,lessonId,payload,id){await TingkeStore.queue({id:id||`${type}-${uuid()}`,lessonId,type,payload,queuedAt:Date.now()});await updateQueueStatus();void flushQueue();}
  async function updateQueueStatus(){if(!state.ready)return;state.pending=(await TingkeStore.pending()).length;renderSync();}
  function renderSync(){const online=navigator.onLine!==false;$('connection').className=`connection ${state.ready?(online?'online':'offline'):''}`;$('connectionText').textContent=!state.ready?'����δ���':!online?'���� �� ��������':state.syncError?'ͬ��������':state.pending?'���ڱ���':'������';$('syncText').textContent=state.flushing?`����ͬ�� �� ${state.pending} ��`:state.syncError?`��������� �� ${state.pending} ��`:state.pending?`${state.pending} ���ͬ��`:'ȫ����ͬ��';}
  async function flushQueue(){
    if(!state.ready||state.flushing||navigator.onLine===false)return;
    state.flushing=true;state.syncError='';renderSync();
    try{
      let pending=await TingkeStore.pending();const order={create:0,asset:1,transcript:1,notes:2,status:3};pending.sort((a,b)=>(order[a.type]??2)-(order[b.type]??2)||(a.queuedAt||0)-(b.queuedAt||0));
      for(const record of pending){
        const base=`/api/lessons/${encodeURIComponent(record.lessonId)}`;
        if(record.type==='create')await TingkeApi.request('POST','/api/lessons',record.payload);
        else if(record.type==='asset')await TingkeApi.upload(record.lessonId,record.payload);
        else if(record.type==='transcript')await TingkeApi.request('POST',`${base}/transcript`,record.payload);
        else if(record.type==='notes')await TingkeApi.request('PUT',`${base}/notes`,record.payload);
        else if(record.type==='status')await TingkeApi.request('PATCH',base,record.payload);
        else throw new Error('�����޷�ʶ��ı���������¼���ѱ���ԭʼ���ݡ�');
        await TingkeStore.ack(record.id);state.pending=Math.max(0,state.pending-1);renderSync();
      }
    }catch(error){state.syncError=explain(error);}finally{state.flushing=false;await updateQueueStatus();}
  }
  $('syncButton').addEventListener('click',async()=>{if(!state.ready)return void init();try{if(state.recorder?.failedChunks?.length)await state.recorder.retryFailedChunks();await flushQueue();if(state.syncError)toast(state.syncError,true);else toast(state.pending?'�����زĴ�ͬ�����뱣��ҳ��򿪡�':'��ͬ�����档');}catch(error){toast(explain(error),true);}});
  window.addEventListener('online',()=>void flushQueue());window.addEventListener('offline',renderSync);setInterval(()=>{if(state.ready&&state.pending)void flushQueue();},15000);
  function render(){
    const has=!!state.lesson,isActive=active(),capturing=state.recordState==='recording';
    $('setupFields').hidden=has;$('activeLessonTitle').hidden=!has;$('activeLessonTitle').textContent=state.lesson?.title||'';
    $('pageTitle').textContent=has?'��һ�Σ���������':'��ע�����������á�';$('pageCaption').textContent=has?`${prettyDate(state.lesson.createdAt)} �� ${state.lesson.title}`:'¼�½��⣬�����ص㣬�¿����������⡣';
    $('startButton').disabled=!state.ready||state.busy;$('startButton').hidden=isActive;$('startButton').querySelector('span').textContent=has?'�������ÿ�':'��ʼ����';
    $('pauseButton').hidden=!isActive||state.recordState==='stopping';$('pauseButton').querySelector('span').textContent=capturing?'��ͣ':'����';$('stopButton').hidden=!isActive;$('stopButton').disabled=state.recordState==='stopping';
    $('recordState').textContent=state.recordState==='recording'?'���ڼ�¼����':state.recordState==='paused'?'¼������ͣ':state.recordState==='stopping'?'���ڱ���ĩ��¼��':has?statusText(state.lesson.status):'׼���ã��ٿ�ʼ';
    $('recordIndicator').className=`record-dot ${capturing?'recording':state.recordState==='paused'?'paused':''}`;
    $('timerCaption').textContent=capturing?'¼���������У����ղ�������ֹͣ¼��':state.recordState==='paused'?'��ͣʱ�䲻�������¼��':state.recordState==='stopping'?'�ȴ����һ�α��棬�뱣��ҳ���':has&&state.lesson.status==='interrupted'?'�ϴβɼ����жϣ��ѱ�����ز�����':has?'ԭʼ�ز��ѱ������ɼ�����¼�򽻸� GPT':'׼����¼��ʵ�Ŀ�������';
    $('waveform').classList.toggle('live',capturing);
    ['cameraButton','galleryButton','addPhotoButton','importButton','saveNotesButton','askGPTButton','askGPTAgain','exportNotesButton'].forEach(id=>$(id).disabled=!state.ready||!has||state.recordState==='stopping');
    const speech=window.SpeechRecognition||window.webkitSpeechRecognition;$('dictationButton').disabled=!state.ready||!has||!speech||!capturing;$('dictationButton').setAttribute('aria-pressed',String(state.dictating));$('dictationButton').textContent=state.dictating?'ֹͣ��д':'�豸��д';
    if(!speech){$('dictationState').textContent='�������δ�ṩ�豸��д';$('dictationCaption').textContent='¼���������棻�ɵ������н��塣';}
    const photoAssets=state.assets.filter(asset=>asset.kind==='photo');$('photoCount').textContent=photoAssets.length;$('transcriptCount').textContent=state.transcripts.length;$('transcriptEmpty').hidden=state.transcripts.length>0;$('photosEmpty').hidden=photoAssets.length>0;
    renderTranscript();renderPhotos();renderAudioGroups();$('notesEmpty').hidden=!!$('notesEditor').value.trim();renderClock();renderSync();renderQuickPhoto();
  }
  function renderQuickPhoto(){const show=state.ready&&!!state.lesson&&['recording','paused'].includes(state.recordState)&&!state.camera;$('quickPhotoButton').hidden=!show;$('quickPhotoButton').disabled=cameraStarting;$('quickPhotoLabel').textContent=cameraStarting?'���ڴ������':'���ص�';document.body.classList.toggle('has-quick-photo',show);}
  function renderClock(){const value=clock();const whole=duration(value);$('timer').replaceChildren(document.createTextNode(whole),el('span','',`.${String(Math.floor(value%1000/10)).padStart(2,'0')}`));$('shutterTime').textContent=whole;$('quickPhotoTime').textContent=whole;}
  setInterval(renderClock,200);
  function onRecorderState(value){
    state.recordState=value;render();if(value!=='recording')stopDictation(false);
    if(value==='interrupted'){if(state.lesson)void persistStatus('interrupted').catch(error=>toast(explain(error),true));toast('�ɼ����жϡ��ѱ����ز����ڣ�����Ȩ�޻�洢���ټ�����',true);}
  }
  async function persistStatus(status){if(!state.lesson)return;state.lesson={...state.lesson,status,durationMs:clock()};await TingkeStore.putLesson(state.lesson);upsertLesson(state.lesson);await queue('status',state.lesson.id,{status,durationMs:state.lesson.durationMs});}
  async function persistAsset(lessonId,asset){
    await TingkeStore.putAsset(lessonId,asset);await queue('asset',lessonId,asset,`asset-${asset.id}`);
    if(state.lesson?.id===lessonId){const {blob,...meta}=asset;const saved={...meta,lessonId};const i=state.assets.findIndex(item=>item.id===asset.id);if(i<0)state.assets.push(saved);else state.assets[i]=saved;state.assets.sort((a,b)=>a.startMs-b.startMs||(a.sequence??0)-(b.sequence??0));state.lesson.durationMs=Math.max(state.lesson.durationMs||0,asset.endMs||asset.startMs||0);await TingkeStore.putLesson(state.lesson);if(asset.kind==='photo')renderPhotos();renderAudioGroups();$('localSaveState').lastChild.textContent='�����ѱ���';$('photoCount').textContent=state.assets.filter(item=>item.kind==='photo').length;}
  }
  $('startButton').addEventListener('click',async()=>{
    if(!state.ready||state.busy||active())return;state.busy=true;render();
    const isNew=!state.lesson;const lesson=isNew?{id:uuid(),title:$('lessonTitle').value.trim()||`���� �� ${new Date().toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'})}`,language:$('lessonLanguage').value,createdAt:new Date().toISOString(),status:'recording',durationMs:0}:{...state.lesson,status:'recording'};
    const offset=Number(lesson.durationMs)||0;state.lesson=lesson;state.offset=offset;state.recordingId=lesson.id;
    state.recorder=new TingkeRecorder({onChunk:asset=>persistAsset(lesson.id,{...asset,startMs:asset.startMs+offset,endMs:asset.endMs+offset}),onState:onRecorderState,onMeter:updateMeter,onError:error=>toast(explain(error),true)});
    let startPromise;
    try{
      startPromise=state.recorder.start();startPromise.catch(()=>{});
      await TingkeStore.putLesson(lesson);if(isNew)await queue('create',lesson.id,{id:lesson.id,title:lesson.title,language:lesson.language},`create-${lesson.id}`);await startPromise;await persistStatus('recording');upsertLesson(lesson);browserLink($('cameraBrowserLink'));try{history.replaceState(null,'',`?lesson=${encodeURIComponent(lesson.id)}`);}catch{}toast('��ʼ��¼������ҳ�汣��ǰ̨������������');
    }catch(error){try{await state.recorder.stop();}catch{}state.recordState='interrupted';lesson.status='interrupted';if(isNew&&state.assets.length===0){state.lesson=lesson;}toast(explain(error),true);}
    finally{state.busy=false;render();}
  });
  $('pauseButton').addEventListener('click',async()=>{try{if(state.recordState==='recording'){if(state.recorder.pause())await persistStatus('paused');}else if(state.recordState==='paused'){if(await state.recorder.resume())await persistStatus('recording');}}catch(error){toast(explain(error),true);}render();});
  $('stopButton').addEventListener('click',async()=>{
    if(!state.recorder||state.recordState==='stopping')return;const finalMs=clock();stopDictation(false);closeCamera();
    try{await state.recorder.stop();state.lesson.durationMs=Math.max(finalMs,state.lesson.durationMs||0);state.recordState='stopped';await persistStatus('finished');toast('��һ���ѽ������زı������ɽ�����ǰ GPT ������');}catch(error){state.lesson.durationMs=Math.max(finalMs,state.lesson.durationMs||0);state.recordState='interrupted';await persistStatus('interrupted');toast(`${explain(error)}\n�����ѱ����Ƭ���Ա�����`,true);}render();
  });
  let meterFrame=0;function updateMeter(level){if(!state.ready)return;cancelAnimationFrame(meterFrame);meterFrame=requestAnimationFrame(()=>{const bars=$('waveform').children;const l=Math.max(0,Math.min(1,Number(level)||0));for(let i=0;i<bars.length;i++){const weight=.28+.72*Math.sin((i/(bars.length-1))*Math.PI);bars[i].style.height=`${4+l*34*weight}px`;}});}
  $('newLessonButton').addEventListener('click',async()=>{if(active()){toast('�Ƚ�������¼�Ƶ����ÿΣ��ٿ�ʼ�¿Ρ�');return;}try{if(state.notesDirty&&state.lesson){await TingkeStore.saveNotes(state.lesson.id,$('notesEditor').value);state.notesDirty=false;await updateQueueStatus();void flushQueue();}}catch(error){toast(explain(error),true);return;}closeCamera();stopDictation(false);clearMedia();state.lesson=null;state.assets=[];state.transcripts=[];state.recordState='idle';state.recorder=null;state.offset=0;$('lessonTitle').value='';$('notesEditor').value='';state.notesDirty=false;try{history.replaceState(null,'','/');}catch{}closeLibrary();setTab('capture');render();$('lessonTitle').focus();});
  async function openCamera(){
    if(!state.lesson||state.camera||cameraStarting)return;const generation=++cameraGeneration;cameraStarting=true;renderQuickPhoto();setTab('capture');$('cameraError').hidden=true;$('cameraButton').disabled=true;
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('��ǰҳ�治֧����������� HTTPS �����ҳ���д򿪿ΰ顣');
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
      if(generation!==cameraGeneration){stream.getTracks().forEach(track=>track.stop());return;}
      state.camera=stream;const video=$('cameraVideo');video.srcObject=state.camera;$('cameraArea').hidden=false;$('cameraPlaceholder').hidden=true;$('cameraButton').hidden=true;document.body.classList.add('camera-is-open');renderQuickPhoto();await video.play();if(!window.matchMedia('(max-width:760px)').matches)video.scrollIntoView({behavior:'smooth',block:'nearest'});
    }catch(error){closeCamera();$('cameraError').hidden=false;$('cameraErrorText').textContent=explain(error);browserLink($('cameraBrowserLink'));toast(explain(error),true);$('cameraError').scrollIntoView({behavior:'smooth',block:'center'});}finally{if(generation===cameraGeneration)cameraStarting=false;$('cameraButton').disabled=!state.lesson;renderQuickPhoto();}
  }
  function closeCamera(){++cameraGeneration;cameraStarting=false;if(state.camera){state.camera.getTracks().forEach(track=>track.stop());state.camera=null;}$('cameraVideo').srcObject=null;$('cameraArea').hidden=true;$('cameraPlaceholder').hidden=false;$('cameraButton').hidden=false;document.body.classList.remove('camera-is-open');renderQuickPhoto();}
  $('cameraButton').addEventListener('click',()=>void openCamera());$('addPhotoButton').addEventListener('click',()=>void openCamera());$('quickPhotoButton').addEventListener('click',()=>void openCamera());$('closeCamera').addEventListener('click',closeCamera);
  const canvasBlob=canvas=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('��Ƭ����ʧ�ܣ������ġ�')),'image/jpeg',.86));
  $('shutterButton').addEventListener('click',async()=>{
    const video=$('cameraVideo');if(!state.lesson||!video.videoWidth)return;const takenAt=clock();$('shutterButton').disabled=true;
    try{const ratio=Math.min(1,1600/Math.max(video.videoWidth,video.videoHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(video.videoWidth*ratio));canvas.height=Math.max(1,Math.round(video.videoHeight*ratio));canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);const blob=await canvasBlob(canvas);const asset={id:uuid(),kind:'photo',startMs:takenAt,endMs:takenAt,mime:'image/jpeg',filename:`������Ƭ-${duration(takenAt).replace(/:/g,'-')}.jpg`,blob,size:blob.size};await persistAsset(state.lesson.id,asset);closeCamera();toast(`������ ${duration(takenAt)} �Ļ��档`);}catch(error){toast(explain(error),true);}finally{$('shutterButton').disabled=false;}
  });
  $('galleryButton').addEventListener('click',()=>$('galleryInput').click());
  $('galleryInput').addEventListener('change',async event=>{const file=event.target.files?.[0];event.target.value='';if(!file||!state.lesson)return;const at=clock();try{if(file.size>25*1024*1024)throw new Error('��Ƭ���� 25 MB����ѡ���С��ͼƬ��');const url=URL.createObjectURL(file),image=new Image();try{image.src=url;await image.decode();const ratio=Math.min(1,1600/Math.max(image.width,image.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const blob=await canvasBlob(canvas);await persistAsset(state.lesson.id,{id:uuid(),kind:'photo',startMs:at,endMs:at,mime:'image/jpeg',filename:`������Ƭ-${duration(at).replace(/:/g,'-')}.jpg`,blob,size:blob.size});toast('��������Ƭ��ʱ����Ϊ����ʱ�Ŀ���λ�á�');}finally{URL.revokeObjectURL(url);}}catch(error){toast(explain(error),true);}});
  async function assetBlob(asset){if(asset.blob instanceof Blob)return asset.blob;const lessonId=asset.lessonId||state.lesson.id;const local=TingkeStore.getAsset?await TingkeStore.getAsset(lessonId,asset.id):(await TingkeStore.assets(lessonId)).find(item=>item.id===asset.id);if(local?.blob instanceof Blob)return local.blob;return await TingkeApi.media(lessonId,asset.id);}
  async function photoUrl(asset){if(state.urls.has(asset.id))return state.urls.get(asset.id);if(state.photoPromises.has(asset.id))return state.photoPromises.get(asset.id);const generation=state.mediaGeneration;const promise=(async()=>{const blob=await assetBlob(asset),url=URL.createObjectURL(blob);if(generation!==state.mediaGeneration){URL.revokeObjectURL(url);throw new Error('�γ����л���');}state.urls.set(asset.id,url);while(state.urls.size>48){const oldest=state.urls.keys().next().value;URL.revokeObjectURL(state.urls.get(oldest));state.urls.delete(oldest);}return url;})();state.photoPromises.set(asset.id,promise);try{return await promise;}finally{state.photoPromises.delete(asset.id);}}
  function renderPhotos(){
    const photos=state.assets.filter(asset=>asset.kind==='photo').sort((a,b)=>a.startMs-b.startMs);$('photoCount').textContent=photos.length;$('photosEmpty').hidden=photos.length>0;$('photoGrid').replaceChildren();if(photoObserver)photoObserver.disconnect();
    if(window.IntersectionObserver)photoObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){photoObserver.unobserve(entry.target);entry.target.loadPhoto?.();}}},{rootMargin:'150px'});
    photos.forEach((asset,index)=>{const tile=el('button','photo-tile');const holder=el('div','photo-loading','������Ƭ');tile.append(holder,el('span','photo-index',String(index+1).padStart(2,'0')));const meta=el('div','photo-meta');meta.append(el('strong','',duration(asset.startMs)),el('small','','����鿴 / ����'));tile.append(meta);tile.addEventListener('click',()=>void openPhoto(asset,index));$('photoGrid').append(tile);tile.loadPhoto=()=>{holder.textContent='����������Ƭ';void photoUrl(asset).then(url=>{if(!tile.isConnected)return;const image=el('img');image.src=url;image.alt=`������Ƭ ${index+1}�������� ${duration(asset.startMs)}`;image.loading='lazy';holder.replaceWith(image);}).catch(()=>holder.textContent='��Ƭ��δ���룬�������');};if(photoObserver)photoObserver.observe(tile);else if(index<12)tile.loadPhoto();});
    const last=photos[photos.length-1],lastGeneration=++lastPhotoGeneration;$('lastPhoto').hidden=!last;if(last){$('lastPhoto').replaceChildren();const info=el('div');info.append(el('p','',`�ѱ��� ${photos.length} �ſ�����Ƭ`),el('small','',`���һ�� �� ${duration(last.startMs)}`));$('lastPhoto').append(info);void photoUrl(last).then(url=>{if(lastGeneration===lastPhotoGeneration&&state.lesson&&state.assets.some(a=>a.id===last.id)){const image=el('img');image.src=url;image.alt='������µĿ�����Ƭ';$('lastPhoto').prepend(image);}}).catch(()=>{});}
  }
  async function openPhoto(asset,index){try{state.selectedPhoto=asset;$('photoDialogTime').textContent=`��Ƭ ${index+1} �� ${duration(asset.startMs)}`;$('photoDialogImage').src=await photoUrl(asset);$('photoDialogCaption').textContent='��Ƭʱ���ǲɼ�ʱ�Ŀ���λ�á���ʦ����ؽ������������֮ǰ��֮��';$('photoDialog').showModal();}catch(error){toast(explain(error),true);}}
  $('photoListenButton').addEventListener('click',async()=>{if(!state.selectedPhoto)return;try{await loadAudio(Math.max(0,state.selectedPhoto.startMs-15000));$('photoDialog').close();setTab('notes');await $('audioPlayer').play();}catch(error){toast(explain(error),true);}});
  $('photoAskButton').addEventListener('click',()=>void askGPT(state.selectedPhoto));
  function renderTranscript(){const list=$('transcriptList');list.replaceChildren();const max=state.transcripts.slice(-120);for(const item of max){const row=el('div','transcript-row');const timed=item.endMs>item.startMs||item.startMs>0;const time=el('button','transcript-time',timed?duration(item.startMs):'����');time.disabled=!state.assets.some(asset=>asset.kind==='audio');time.addEventListener('click',async()=>{try{await loadAudio(item.startMs);setTab('notes');await $('audioPlayer').play();}catch(error){toast(explain(error),true);}});const text=el('p','transcript-text',item.text);text.append(el('span','transcript-source',item.source==='device'?'�豸��д �� �ɺ˶�ԭ��':item.source==='manual'?'�ֶ���¼':'���뽲��'));row.append(time,text);list.append(row);}if(state.transcripts.length>120){const caption=el('p','micro-text',`Ϊ������������ʾ��� 120 �Σ�ȫ�� ${state.transcripts.length} ���ѱ�����`);list.prepend(caption);}$('transcriptEmpty').hidden=state.transcripts.length>0;$('transcriptCount').textContent=state.transcripts.length;}
  async function saveTranscript(item){if(!state.lesson)return;await TingkeStore.putTranscript(state.lesson.id,item);await queue('transcript',state.lesson.id,item,`transcript-${item.id}`);state.transcripts.push(item);state.transcripts.sort((a,b)=>a.startMs-b.startMs);renderTranscript();}
  function stopDictation(message=true){if(state.dictation){try{state.dictation.stop();}catch{}}state.dictation=null;state.dictating=false;$('interimText').hidden=true;$('dictationButton').setAttribute('aria-pressed','false');$('dictationButton').textContent='�豸��д';if(message)$('dictationState').textContent='��д��ֹͣ��ԭ¼����������';}
  $('dictationButton').addEventListener('click',()=>{
    if(state.dictating)return stopDictation();if(state.recordState!=='recording')return toast('���ȿ�ʼ¼����');const Speech=window.SpeechRecognition||window.webkitSpeechRecognition;if(!Speech)return toast('�������û���ṩ�豸��д�����ڿκ��뽲�塣');
    const recognition=new Speech();recognition.lang=state.lesson.language||'zh-CN';recognition.continuous=true;recognition.interimResults=true;state.dictation=recognition;state.lastDictationMs=clock();
    recognition.onstart=()=>{state.dictating=true;$('dictationState').textContent='�豸��д�� �� �� GPT �ٷ�תд';$('dictationButton').textContent='ֹͣ��д';$('dictationButton').setAttribute('aria-pressed','true');};
    recognition.onresult=event=>{let interim='';for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i],text=result[0]?.transcript?.trim();if(!text)continue;if(result.isFinal){const end=clock(),start=state.lastDictationMs;state.lastDictationMs=end;void saveTranscript({id:uuid(),startMs:start,endMs:Math.max(start,end),text,source:'device'}).catch(error=>toast(explain(error),true));}else interim+=text;}$('interimText').textContent=interim;$('interimText').hidden=!interim;};
    recognition.onerror=event=>{const text=event.error==='not-allowed'?'�豸��дȨ��δ��׼��¼���Զ������С�':`�豸��дδ��ɣ�${event.error||'δ֪ԭ��'}����ԭʼ¼���������档`;$('dictationState').textContent=text;toast(text,true);};recognition.onend=()=>{if(state.dictation===recognition){state.dictating=false;state.dictation=null;$('interimText').hidden=true;$('dictationButton').textContent='�豸��д';$('dictationButton').setAttribute('aria-pressed','false');$('dictationState').textContent='�豸��д�ѽ��������ֶ��ٴο���';}};
    try{recognition.start();}catch(error){stopDictation(false);toast(explain(error),true);}
  });
  $('importButton').addEventListener('click',()=>$('importDialog').showModal());
  $('transcriptFile').addEventListener('change',async event=>{const file=event.target.files?.[0];event.target.value='';if(!file)return;try{if(file.size>5*1024*1024)throw new Error('���峬�� 5 MB���밴�½ڲ�ֵ��롣');$('transcriptPaste').value=await file.text();toast('�Ѷ�ȡ�ļ���������浽���Ρ�');}catch(error){toast(explain(error),true);}});
  function parseTranscript(text){
    const clean=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim();if(!clean)return[];
    const parseTime=value=>{const parts=value.replace(',','.').split(':').map(Number);if(parts.some(n=>!Number.isFinite(n)))return NaN;return Math.round(parts.reduce((total,n)=>total*60+n,0)*1000);};
    const items=[];for(const block of clean.split(/\n\s*\n/)){const lines=block.split('\n');const i=lines.findIndex(line=>/\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}\s*-->/.test(line));if(i<0)continue;const match=lines[i].match(/([\d:]+[.,]\d+)\s*-->\s*([\d:]+[.,]\d+)/);if(!match)continue;const startMs=parseTime(match[1]),endMs=parseTime(match[2]),body=lines.slice(i+1).join('\n').replace(/<[^>]*>/g,'').trim();if(body&&Number.isFinite(startMs)&&Number.isFinite(endMs)&&endMs>=startMs)items.push({id:uuid(),startMs,endMs,text:body,source:'import'});}
    if(items.length)return items;
    const paragraphs=clean.replace(/^WEBVTT[^\n]*\n?/,'').split(/\n\s*\n/);for(const paragraph of paragraphs){for(let i=0;i<paragraph.length;i+=2000){const body=paragraph.slice(i,i+2000).trim();if(body)items.push({id:uuid(),startMs:0,endMs:0,text:body,source:'import'});}}return items;
  }
  $('saveTranscriptButton').addEventListener('click',async()=>{if(!state.lesson)return;const items=parseTranscript($('transcriptPaste').value);if(!items.length)return toast('��ճ�����ֻ�ѡ�񽲸��ļ���');$('saveTranscriptButton').disabled=true;try{for(const item of items)await saveTranscript(item);$('transcriptPaste').value='';$('importDialog').close();toast(`�ѱ��� ${items.length} �ν��塣����������豸��д��ֱ������`);}catch(error){toast(explain(error),true);}finally{$('saveTranscriptButton').disabled=false;}});
  function renderAudioGroups(){
    const chunks=state.assets.filter(asset=>asset.kind==='audio');const map=new Map();for(const chunk of chunks){const key=chunk.containerGroup||'recording';if(!map.has(key))map.set(key,[]);map.get(key).push(chunk);}state.audioGroups=[...map.entries()].map(([id,parts])=>({id,parts:parts.sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.startMs-b.startMs),startMs:Math.min(...parts.map(a=>a.startMs)),endMs:Math.max(...parts.map(a=>a.endMs))})).sort((a,b)=>a.startMs-b.startMs);
    const select=$('audioGroup'),selected=select.value;select.replaceChildren();state.audioGroups.forEach((group,index)=>{const option=el('option','',`¼�� ${index+1} �� ${duration(group.startMs)}��${duration(group.endMs)}`);option.value=group.id;select.append(option);});if(state.audioGroups.some(g=>g.id===selected))select.value=selected;select.hidden=state.audioGroups.length<2;$('audioCount').textContent=chunks.length?`${state.audioGroups.length} ��¼�� �� ${chunks.length} ������Ƭ��`:'��û��¼��Ƭ��';$('playAudioButton').disabled=!chunks.length||active();$('exportAudioButton').disabled=!chunks.length||active();
  }
  async function loadAudio(seekMs){
    if(active())throw new Error('��������κ��ٻ���������Ӱ�����ڽ��е�¼����');if(!state.audioGroups.length)throw new Error('���ÿλ�û�пɻ�����¼����');
    let group=Number.isFinite(seekMs)?state.audioGroups.find(item=>seekMs>=item.startMs&&seekMs<=item.endMs):state.audioGroups.find(item=>item.id===$('audioGroup').value);group=group||state.audioGroups[0];$('audioGroup').value=group.id;
    const player=$('audioPlayer');if(state.audioGroup!==group.id){$('audioStatus').textContent=`���ڶ�ȡ ${group.parts.length} ��ԭʼƬ�Σ����Ժ�`;$('playAudioButton').disabled=true;try{const blobs=[];for(const part of group.parts)blobs.push(await assetBlob(part));const blob=new Blob(blobs,{type:group.parts[0].mime||'audio/mp4'});if(state.audioUrl)URL.revokeObjectURL(state.audioUrl);state.audioUrl=URL.createObjectURL(blob);state.audioGroup=group.id;player.src=state.audioUrl;player.hidden=false;$('audioStatus').textContent='ԭʼ�ֽڰ�¼��˳��ƴ�ӣ����ʱ��ɻ�����';}finally{$('playAudioButton').disabled=false;}}
    if(Number.isFinite(seekMs)){const seconds=Math.max(0,(seekMs-group.startMs)/1000);if(player.readyState>=1)player.currentTime=seconds;else player.addEventListener('loadedmetadata',()=>player.currentTime=seconds,{once:true});}return group;
  }
  $('playAudioButton').addEventListener('click',async()=>{try{await loadAudio();await $('audioPlayer').play();}catch(error){toast(explain(error),true);}});
  $('audioGroup').addEventListener('change',async()=>{try{await loadAudio();}catch(error){toast(explain(error),true);}});
  function download(blob,name){const link=el('a');const url=URL.createObjectURL(blob);link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  $('exportAudioButton').addEventListener('click',async()=>{if(!state.lesson)return;try{const group=await loadAudio();const response=await fetch(state.audioUrl),blob=await response.blob();const ext=group.parts[0].mime?.includes('webm')?'webm':group.parts[0].mime?.includes('ogg')?'ogg':'m4a';download(blob,`${fileSafe(state.lesson.title)}-${duration(group.startMs).replace(/:/g,'-')}.${ext}`);toast(state.audioGroups.length>1?'�ѵ�����ѡ¼��������¼�����л���ֱ𵼳���':'��׼��ԭʼ¼���ļ���');}catch(error){toast(explain(error),true);}});
  $('notesEditor').addEventListener('input',()=>{state.notesDirty=true;$('notesEmpty').hidden=!!$('notesEditor').value.trim();});
  $('saveNotesButton').addEventListener('click',async()=>{if(!state.lesson)return;try{const markdown=$('notesEditor').value;await TingkeStore.saveNotes(state.lesson.id,markdown);await updateQueueStatus();void flushQueue();state.notesDirty=false;toast('�ʼ����ȱ��浽������');}catch(error){toast(explain(error),true);}});
  $('exportNotesButton').addEventListener('click',()=>{if(!state.lesson)return;const lines=[`# ${state.lesson.title}`,'',`���ڣ�${state.lesson.createdAt}`,`����ʱ����${duration(state.lesson.durationMs)}`,'', $('notesEditor').value.trim()||'��δ����������ıʼǡ�','','## ������Ƭ����',''];for(const asset of state.assets.filter(item=>item.kind==='photo'))lines.push(`- ${duration(asset.startMs)} �� ${asset.filename} �� �ز� ID: ${asset.id}`);lines.push('','## ԭʼ����','');for(const item of state.transcripts)lines.push(`[${duration(item.startMs)}]��${item.source==='device'?'�豸��д':item.source==='manual'?'�ֶ���¼':'���뽲��'}��${item.text}`,'');lines.push('','���ļ�������ԭʼ¼����ͼƬ����ӿΰ�ֱ𱣴�ԭʼ���ϡ�');download(new Blob([lines.join('\n')],{type:'text/markdown;charset=utf-8'}),`${fileSafe(state.lesson.title)}.md`);});
  async function askGPT(photo){
    if(!state.lesson)return;await flushQueue();const lessonPending=await TingkeStore.pending(state.lesson.id);if(lessonPending.length){toast('���ÿλ����ز�δͬ�����������ͬ����GPT ���ܶ�ȡ�����������ϡ�',true);return;}
    const prompt=photo?`��ʹ�ÿΰ�����ȡ�γ� ${state.lesson.id}��${state.lesson.title}������Ƭ ${photo.id}���������λ�� ${duration(photo.startMs)}�����Ȼ�ȡԭͼ��ǰ����ؽ��壬��������ͼ����ȷ���ֿμ����ݡ���ʦ���⡢AI ���䣻�������ȱ�ٽ���ĵط����������Ҫ�������ԭ����`:`��ʹ�ÿΰ�����ȡ�γ� ${state.lesson.id}��${state.lesson.title}�������Ż�ȡ��Ƭ����ؽ��壬��������ͼ�Ŀ��ñʼǣ������ɱ༭�������빫ʽ������Ƭ������ʦǰ����صĽ��⣬����Ƭ����������������ֿ�����Դ�� AI ���䣬����������û��תд�ĵط���ԭʼ��Ƶ���ڲ������Ѿ����תд���������ȡ���ϲ�����ʼǵ����Ρ�`;
    try{const sent=await TingkeApi.ask(prompt);if(sent){$('photoDialog').open&&$('photoDialog').close();toast('�ѽ�����ǰ GPT����ɺ��ˢ�±��β鿴����ıʼǡ�');}else{if($('photoDialog').open)$('photoDialog').close();$('gptPromptText').value=prompt;$('gptPromptDialog').showModal();}}catch(error){$('gptPromptText').value=prompt;if($('photoDialog').open)$('photoDialog').close();$('gptPromptDialog').showModal();toast('��ʱ�޷�ֱ�ӷ��͵����죬�ɸ������ָ�',true);}
  }
  $('copyGPTPrompt').addEventListener('click',async()=>{const text=$('gptPromptText').value;try{if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);else{$('gptPromptText').focus();$('gptPromptText').select();if(!document.execCommand('copy'))throw new Error('�볤�������ָ��ơ�');}toast('�Ѹ��ơ��ص� GPT��ѡ�пΰ�����ճ�����͡�');}catch{$('gptPromptText').focus();$('gptPromptText').select();toast('�볤��ָ�ѡ���ƺ�ص� GPT ���͡�');}});
  $('askGPTButton').addEventListener('click',()=>void askGPT());$('askGPTAgain').addEventListener('click',()=>void askGPT());
  window.addEventListener('beforeunload',event=>{if(active()||state.pending||state.notesDirty){event.preventDefault();event.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.recordState==='recording')toast('��ص��ΰ鱣��ǰ̨����̨¼���Ƿ����ȡ�����ֻ�ϵͳ��',true);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeLibrary();closeCamera();}});
  void init();
})();
