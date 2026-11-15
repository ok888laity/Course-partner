# Transport
No dependencies. Browser scripts (globals): bridge.js, store.js, recorder.js, app.js, in that order.

`TingkeApi.request(method, path, body?)` returns JSON for JSON APIs, Blob for /api/media/ GET. It uses host MCP `app_request` tool when embedded, REST fetch when standalone. JSON input supported. Binary upload: `TingkeApi.upload(lessonId, asset)` where asset has id, kind (audio/photo), startMs,endMs,mime,filename,blob. `TingkeApi.media(lessonId,assetId)` returns Blob; `TingkeApi.ask(prompt)` sends host followup when supported, else returns false. `TingkeApi.embedded` boolean; `TingkeApi.origin` absolute server origin.

Routes:
- GET /api/config -> {version,apiKeyRequired:false,officialVoiceAvailable:false,origin}
- GET /api/lessons -> {lessons:[Lesson]}
- POST /api/lessons body {id?:UUID,title,language} -> {lesson:Lesson}
- GET /api/lessons/:id -> {lesson:Lesson,assets:[Asset],transcripts:[Transcript],notes:string}
- PATCH /api/lessons/:id body {status:'recording'|'paused'|'finished'|'interrupted',durationMs?,title?} -> {lesson}
- PUT /api/lessons/:id/notes body {markdown} -> {ok:true}
- POST /api/lessons/:id/transcript body Transcript -> {ok:true}
- PUT /api/lessons/:id/assets/:assetId binary using upload adapter -> {ok:true,asset:Asset}
- GET /api/media/:lessonId/:assetId -> Blob

Lesson {id,title,language,createdAt,status,durationMs}; Asset {id,kind,startMs,endMs,mime,filename,size,url?}; Transcript {id,startMs,endMs,text,source:'device'|'import'|'manual'}.

# Local persistence
`TingkeStore.init()`; `.putLesson(lesson)`; `.lessons()`; `.getLesson(id)`; `.queue(record)` persists a queue record with id,lessonId,type:'asset'|'transcript'|'status'|'create', payload (asset with blob or JSON); `.pending(lessonId?)`; `.ack(id)` removes queue only; `.putAsset(lessonId,asset)` stores local blob; `.assets(lessonId)`; `.putTranscript(lessonId,t)`; `.transcripts(lessonId)`; `.saveNotes(lessonId,markdown)`; `.getNotes(lessonId)`.
Persistence fails loudly; no swallowing IDB quota/storage errors.

# Recorder
`new TingkeRecorder({onChunk(asset),onState(state),onMeter(level),onError(error)})`. Async `.start()` requests mic (must be called from click); `.pause()`, `.resume()`, async `.stop()`, `.elapsedMs()`. `state` values idle/recording/paused/stopping/stopped/interrupted. Chunk asset object matches upload contract incl id kind:'audio' startMs/endMs mime filename blob. Continuous MediaRecorder data chunks (10s) may depend on container header; expose `containerGroup`/`sequence` metadata when provided, and preserve exact bytes and order; browser must concatenate a group for playback/export. No stop/restart loops pretending gapless. Main UI controls capture elapsedMs of photos. .stream property for optional visual audio monitor. Avoid microphone re-acquisition for camera; camera getUserMedia audio:false.

# UI requirements
Chinese, phone-first. Name �ΰ�, lightweight, warm offwhite + dark ink + restrained teal. No external icons/fonts. Main recording tab, photo timeline, notes/library. Start recording/title/lang, pause/resume/finish; elapsed clock; camera expand in-page with live rear preview, shutter/save/close independent of mic. Canvas JPEG reasonable 1600px max. Photos clickable. Optional device dictation switch (webkitSpeechRecognition), source clearly labeled; keep recording even if dictation unsupported/fails. User can import/paste transcript; don't invent text. View notes, import transcripts, export Markdown and audio; Ask current GPT button. No signup form/API-key form/fake sample lessons. Expose upload queued/saved/error honestly. Recovery after reload must show pending local records and interrupted recording, never pretend it kept capturing. Host restrictions show actionable open-in-browser link. Never auto-send followup messages every few seconds.
