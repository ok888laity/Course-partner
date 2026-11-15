(function (global) {
  'use strict';

  const MIME_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const now = () => global.performance && typeof global.performance.now === 'function' ? global.performance.now() : Date.now();
  const identifier = () => global.crypto && typeof global.crypto.randomUUID === 'function'
    ? global.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  const namedError = (message, code, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

  /**
   * A single continuous MediaRecorder. Its blobs are ordered container fragments,
   * not separate audio files. Join every sequence in containerGroup for playback.
   * Capture timestamps use a monotonic wall clock excluding explicit pauses;
   * they are alignment anchors, not sample-accurate speech timestamps.
   */
  class TingkeRecorder {
    constructor(options = {}) {
      this.options = options;
      this.state = 'idle';
      this.stream = null;
      this.failedChunks = [];
      this.containerGroup = '';
      this.mime = '';
      this._recorder = null;
      this._elapsed = 0;
      this._runningSince = null;
      this._sequence = 0;
      this._lastChunkEnd = 0;
      this._totalBytes = 0;
      this._chunkQueue = Promise.resolve();
      this._stopPromise = null;
      this._starting = false;
      this._startGeneration = 0;
      this._stopRequested = false;
      this._interruption = null;
      this._ended = false;
      this._wakeLock = null;
      this._wakeRequest = null;
      this._meterTimer = null;
      this._audioContext = null;
      this._trackListeners = [];
      this._onVisibility = () => {
        if (global.document.visibilityState === 'visible' && this.state === 'recording') this._requestWakeLock();
        else if (global.document.visibilityState === 'hidden' && this.state === 'recording') {
          this._report(namedError('页面已进入后台，手机可能限制录音。请回到听课页检查录音状态。', 'BACKGROUND_RESTRICTION'));
        }
      };
    }

    async start() {
      if (this._starting || this.state === 'recording' || this.state === 'paused' || this.state === 'stopping') {
        throw namedError('录音已经开始。', 'ALREADY_RECORDING');
      }
      if (this.failedChunks.length) throw namedError('还有未保存的音频片段，请先保存或导出后再开始。', 'UNSAVED_AUDIO');
      if (!global.navigator?.mediaDevices?.getUserMedia || typeof global.MediaRecorder !== 'function' || global.isSecureContext === false) {
        const error = namedError('当前页面无法使用麦克风录音。请在安全的浏览器页面中打开并允许麦克风权限。', 'RECORDING_UNAVAILABLE');
        this._report(error);
        throw error;
      }
      this._starting = true;
      this._recorder = null;
      this._stopPromise = null;
      const generation = ++this._startGeneration;
      let stream;
      try {
        // Call getUserMedia before another await so a user gesture can authorize it.
        stream = await global.navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
          video: false,
        });
        if (generation !== this._startGeneration) {
          stream.getTracks().forEach(track => track.stop());
          throw namedError('录音启动已取消。', 'START_CANCELLED');
        }
        this.stream = stream;
        const mime = MIME_TYPES.find(type => {
          try { return global.MediaRecorder.isTypeSupported(type); } catch { return false; }
        });
        const settings = { audioBitsPerSecond: 48000, ...(mime ? { mimeType: mime } : {}) };
        let recorder;
        try { recorder = new global.MediaRecorder(stream, settings); }
        catch { recorder = new global.MediaRecorder(stream); }
        this._recorder = recorder;
        this.mime = recorder.mimeType || mime || 'application/octet-stream';
        this.containerGroup = identifier();
        this._elapsed = 0;
        this._runningSince = null;
        this._sequence = 0;
        this._lastChunkEnd = 0;
        this._totalBytes = 0;
        this._chunkQueue = Promise.resolve();
        this._stopPromise = null;
        this._stopRequested = false;
        this._interruption = null;
        this._ended = false;
        this._nativeStopSeen = false;
        this._nativeStop = new Promise(resolve => { this._resolveNativeStop = resolve; });

        recorder.addEventListener('dataavailable', event => this._acceptChunk(event));
        recorder.addEventListener('error', event => {
          this._interrupt(namedError('录音受到系统中断，请检查已保存的音频并重新开始。', 'RECORDER_INTERRUPTED', event.error));
        });
        recorder.addEventListener('stop', () => {
          this._nativeStopSeen = true;
          if (!this._stopRequested) {
            this._interruption = this._interruption || namedError('录音已被系统停止。已收到的片段仍会保存，请重新开始录音。', 'UNEXPECTED_STOP');
            this._freezeClock();
            this._report(this._interruption);
          }
          this._resolveNativeStop();
          this._finish().catch(() => {});
        });

        for (const track of stream.getAudioTracks()) {
          const ended = () => {
            if (!this._ended && !this._stopRequested) this._interrupt(namedError('麦克风连接已结束，录音已中断。', 'MICROPHONE_ENDED'));
          };
          const muted = () => {
            if (!this._ended && !this._stopRequested) this._report(namedError('麦克风暂时被系统静音，录音可能缺少声音。请检查来电或麦克风权限。', 'MICROPHONE_MUTED'));
          };
          track.addEventListener('ended', ended);
          track.addEventListener('mute', muted);
          this._trackListeners.push({ track, ended, muted });
        }

        this._runningSince = now();
        recorder.start(10000);
        this._setState('recording');
        if (global.document?.addEventListener) global.document.addEventListener('visibilitychange', this._onVisibility);
        this._startMeter();
        this._requestWakeLock();
        return this;
      } catch (cause) {
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (generation === this._startGeneration) {
          this._ended = true;
          this._freezeClock();
          await this._cleanup();
          this._setState('idle');
        }
        const error = cause.code ? cause : namedError(
          cause.name === 'NotAllowedError' ? '麦克风权限未获允许，请在浏览器设置中允许录音。' : '无法启动麦克风录音，请检查设备和权限。',
          'MICROPHONE_START_FAILED', cause,
        );
        if (error.code !== 'START_CANCELLED') this._report(error);
        throw error;
      } finally { this._starting = false; }
    }

    elapsedMs() {
      const current = this._runningSince === null ? 0 : Math.max(0, now() - this._runningSince);
      return Math.max(0, Math.round(this._elapsed + current));
    }

    pause() {
      if (this.state !== 'recording' || this._recorder?.state !== 'recording') return false;
      try {
        this._recorder.pause();
        this._freezeClock();
        this._setState('paused');
        this._releaseWakeLock();
        return true;
      } catch (cause) { this._report(namedError('暂时无法暂停录音。', 'PAUSE_FAILED', cause)); return false; }
    }

    resume() {
      if (this.state !== 'paused' || this._recorder?.state !== 'paused') return false;
      try {
        this._recorder.resume();
        this._runningSince = now();
        this._setState('recording');
        this._requestWakeLock();
        return true;
      } catch (cause) { this._report(namedError('无法继续录音，请先结束并保存本次录音。', 'RESUME_FAILED', cause)); return false; }
    }

    async stop() {
      if (this._starting && !this._recorder) {
        ++this._startGeneration;
        this._setState('stopped');
        return { durationMs: 0, containerGroup: '', chunks: 0, bytes: 0 };
      }
      if (!this._recorder) return { durationMs: this.elapsedMs(), containerGroup: this.containerGroup, chunks: 0, bytes: 0 };
      if (this._stopPromise) return this._stopPromise;
      this._stopRequested = true;
      this._freezeClock();
      this._setState('stopping');
      try {
        if (this._recorder.state !== 'inactive') this._recorder.stop();
        // An inactive native recorder normally still owes dataavailable + stop.
        // _nativeStop is resolved only by that event, so no tail is skipped.
      } catch (cause) {
        this._interruption = namedError('系统没有正常结束录音。已收到的片段会保留，请检查音频。', 'STOP_FAILED', cause);
        this._report(this._interruption);
        this._resolveNativeStop();
      }
      return this._finish();
    }

    async retryFailedChunks() {
      const pending = this.failedChunks.slice();
      const saved = new Set();
      for (const asset of pending) {
        await this.options.onChunk?.(asset);
        saved.add(asset.id);
      }
      this.failedChunks = this.failedChunks.filter(asset => !saved.has(asset.id));
      if (!this.failedChunks.length && this._ended) {
        this._stopPromise = Promise.resolve(this._summary());
      }
      return this.failedChunks.length;
    }

    _freezeClock() {
      if (this._runningSince !== null) {
        this._elapsed += Math.max(0, now() - this._runningSince);
        this._runningSince = null;
      }
    }

    _setState(state) {
      if (this.state === state) return;
      this.state = state;
      try { this.options.onState?.(state); } catch { /* Observer failures cannot drop captured audio. */ }
    }

    _report(error) {
      try { this.options.onError?.(error); } catch { /* Keep the original recording state intact. */ }
    }

    _acceptChunk(event) {
      if (!event.data || !event.data.size) return;
      const endMs = this.elapsedMs();
      const mime = event.data.type || this.mime;
      const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? 'webm' : 'bin';
      const sequence = this._sequence++;
      const asset = {
        id: identifier(), kind: 'audio', startMs: this._lastChunkEnd, endMs,
        mime, filename: this.containerGroup + '-' + String(sequence).padStart(5, '0') + '.' + extension,
        blob: event.data, size: event.data.size,
        containerGroup: this.containerGroup, sequence,
        timestampSource: 'capture-clock',
      };
      this._lastChunkEnd = endMs;
      this._totalBytes += event.data.size;
      this._chunkQueue = this._chunkQueue.then(async () => {
        try { await this.options.onChunk?.(asset); }
        catch (cause) {
          this.failedChunks.push(asset);
          const error = namedError('音频片段尚未保存成功，录音已停止以保护已录内容。请勿关闭页面，可重试保存。', 'AUDIO_SAVE_FAILED', cause);
          this._interrupt(error);
        }
      });
    }

    _interrupt(error) {
      if (!this._interruption) this._report(error);
      this._interruption = this._interruption || error;
      this._freezeClock();
      if (!this._stopRequested) {
        this._setState('interrupted');
        this.stop().catch(() => {});
      }
    }

    _finish() {
      if (this._stopPromise) return this._stopPromise;
      this._stopPromise = (async () => {
        await this._nativeStop;
        // The native stop event follows the final dataavailable event.
        await this._chunkQueue;
        this._ended = true;
        await this._cleanup();
        this._setState(this._interruption ? 'interrupted' : 'stopped');
        if (this.failedChunks.length) {
          throw namedError(this.failedChunks.length + ' 个音频片段仍未保存，请保留本页并重试。', 'UNSAVED_AUDIO');
        }
        if (this._interruption?.code === 'STOP_FAILED') throw this._interruption;
        return this._summary();
      })();
      // Internal interruption handling may start finalization without a caller.
      this._stopPromise.catch(() => {});
      return this._stopPromise;
    }

    _summary() {
      return { durationMs: this.elapsedMs(), containerGroup: this.containerGroup, chunks: this._sequence, bytes: this._totalBytes, interrupted: Boolean(this._interruption) };
    }

    _startMeter() {
      const Context = global.AudioContext || global.webkitAudioContext;
      if (!Context) return;
      try {
        const context = new Context();
        this._audioContext = context;
        const source = context.createMediaStreamSource(this.stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        this._meterSource = source;
        const samples = new Uint8Array(analyser.fftSize);
        context.resume?.().catch(() => {});
        this._meterTimer = global.setInterval(() => {
          if (this.state !== 'recording') {
            try { this.options.onMeter?.(0); } catch { /* Visualization is optional. */ }
            return;
          }
          analyser.getByteTimeDomainData(samples);
          let sum = 0;
          for (let index = 0; index < samples.length; index++) sum += ((samples[index] - 128) / 128) ** 2;
          try { this.options.onMeter?.(Math.min(1, Math.sqrt(sum / samples.length) * 3)); } catch { /* Visualization is optional. */ }
        }, 200);
      } catch { /* Some hosts allow MediaRecorder but not Web Audio metering. */ }
    }

    _requestWakeLock() {
      if (!global.navigator?.wakeLock?.request || this._wakeLock || this._wakeRequest || this.state !== 'recording') return;
      if (global.document?.visibilityState === 'hidden') return;
      let requested;
      try { requested = global.navigator.wakeLock.request('screen'); } catch { return; }
      this._wakeRequest = Promise.resolve(requested).then(lock => {
        if (this.state !== 'recording' || this._ended) {
          try { Promise.resolve(lock.release()).catch(() => {}); } catch { /* Already released. */ }
          return;
        }
        this._wakeLock = lock;
        lock.addEventListener?.('release', () => { if (this._wakeLock === lock) this._wakeLock = null; });
      }).catch(() => { /* A browser may deny Wake Lock. Recording still works in the foreground. */ })
        .finally(() => { this._wakeRequest = null; });
    }

    _releaseWakeLock() {
      const lock = this._wakeLock;
      this._wakeLock = null;
      if (lock) { try { Promise.resolve(lock.release()).catch(() => {}); } catch { /* Already released. */ } }
    }

    async _cleanup() {
      global.document?.removeEventListener?.('visibilitychange', this._onVisibility);
      if (this._meterTimer !== null) global.clearInterval(this._meterTimer);
      this._meterTimer = null;
      this._releaseWakeLock();
      for (const { track, ended, muted } of this._trackListeners) {
        track.removeEventListener('ended', ended);
        track.removeEventListener('mute', muted);
      }
      this._trackListeners = [];
      this.stream?.getTracks().forEach(track => track.stop());
      this.stream = null;
      try { this._meterSource?.disconnect(); } catch { /* Already disconnected. */ }
      this._meterSource = null;
      const context = this._audioContext;
      this._audioContext = null;
      if (context && context.state !== 'closed') { try { await context.close(); } catch { /* No captured bytes depend on the meter. */ } }
      try { this.options.onMeter?.(0); } catch { /* Observer only. */ }
    }
  }

  global.TingkeRecorder = TingkeRecorder;
})(typeof window !== 'undefined' ? window : globalThis);
