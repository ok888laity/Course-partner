import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../local-only/recorder.js', import.meta.url), 'utf8');

function environment({ getUserMedia, stopDelay = 0, failStop = false } = {}) {
  let milliseconds = 0;
  let nextId = 0;
  const track = new EventTarget();
  track.stopped = false;
  track.stop = () => { track.stopped = true; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const instances = [];
  class FakeRecorder extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor(input, options) {
      super(); this.stream = input; this.options = options; this.mimeType = options?.mimeType || 'audio/mp4'; this.state = 'inactive'; instances.push(this);
    }
    start(slice) { this.timeslice = slice; this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    chunk(bytes) {
      const event = new Event('dataavailable');
      event.data = new Blob([bytes], { type: this.mimeType });
      this.dispatchEvent(event);
    }
    stop() {
      if (failStop) throw new Error('native stop failed');
      this.state = 'inactive';
      setTimeout(() => { this.chunk('tail'); this.dispatchEvent(new Event('stop')); }, stopDelay);
    }
  }
  const page = new EventTarget();
  page.visibilityState = 'visible';
  const context = vm.createContext({
    Blob, Error, Promise, Date, Math, Uint8Array, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => milliseconds }, crypto: { randomUUID: () => 'test-' + ++nextId },
    isSecureContext: true, MediaRecorder: FakeRecorder, document: page,
    navigator: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } },
  });
  vm.runInContext(source, context);
  return { Recorder: context.TingkeRecorder, instances, track, stream, page, advance: delta => { milliseconds += delta; } };
}

test('recording clock excludes pauses and stays frozen after stop', async () => {
  const env = environment();
  const states = [];
  const recorder = new env.Recorder({ onState: state => states.push(state) });
  await recorder.start();
  env.advance(1250);
  assert.equal(recorder.elapsedMs(), 1250);
  assert.equal(recorder.pause(), true);
  env.advance(60000);
  assert.equal(recorder.elapsedMs(), 1250);
  assert.equal(recorder.resume(), true);
  env.advance(750);
  const result = await recorder.stop();
  assert.equal(result.durationMs, 2000);
  env.advance(1000);
  assert.equal(recorder.elapsedMs(), 2000);
  assert.deepEqual(states, ['recording', 'paused', 'recording', 'stopping', 'stopped']);
  assert.equal(env.track.stopped, true);
});

test('container fragments retain exact order and stop awaits tail persistence', async () => {
  const env = environment({ stopDelay: 5 });
  const persisted = [];
  let releaseFirst;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const recorder = new env.Recorder({ onChunk: async asset => {
    if (asset.sequence === 0) await firstWrite;
    persisted.push(asset);
  } });
  await recorder.start();
  assert.equal(env.instances[0].timeslice, 10000);
  assert.equal(env.instances[0].options.audioBitsPerSecond, 48000);
  env.advance(10000); env.instances[0].chunk('header');
  env.advance(10000); env.instances[0].chunk('continuation');
  env.advance(3500);
  let stopped = false;
  const stopping = recorder.stop().then(result => { stopped = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(stopped, false, 'stop must not finish before durable callback resolves');
  releaseFirst();
  const result = await stopping;
  assert.deepEqual(persisted.map(asset => asset.sequence), [0, 1, 2]);
  assert.deepEqual(persisted.map(asset => [asset.startMs, asset.endMs]), [[0, 10000], [10000, 20000], [20000, 23500]]);
  assert.ok(persisted.every(asset => asset.containerGroup === recorder.containerGroup));
  assert.equal(await new Blob(persisted.map(asset => asset.blob)).text(), 'headercontinuationtail');
  assert.equal(result.chunks, 3);
  assert.equal(recorder.state, 'stopped');
});

test('failed persistence stops capture, retains raw blob, and rejects success', async () => {
  const env = environment();
  const errors = [];
  let fail = true;
  const recorder = new env.Recorder({
    onError: error => errors.push(error.code),
    onChunk: async asset => { if (fail && asset.sequence === 0) throw new Error('QuotaExceededError'); },
  });
  await recorder.start();
  env.advance(10000); env.instances[0].chunk('irreplaceable audio');
  await new Promise(resolve => setTimeout(resolve, 15));
  await assert.rejects(recorder.stop(), error => error.code === 'UNSAVED_AUDIO');
  assert.equal(recorder.state, 'interrupted');
  assert.equal(env.track.stopped, true);
  assert.equal(recorder.failedChunks.length, 1);
  assert.equal(await recorder.failedChunks[0].blob.text(), 'irreplaceable audio');
  assert.ok(errors.includes('AUDIO_SAVE_FAILED'));
  fail = false;
  assert.equal(await recorder.retryFailedChunks(), 0);
  assert.equal((await recorder.stop()).interrupted, true);
});

test('track ending becomes interrupted and still saves the final container fragment', async () => {
  const env = environment();
  const chunks = [];
  const recorder = new env.Recorder({ onChunk: asset => { chunks.push(asset); } });
  await recorder.start();
  env.advance(5000);
  env.track.dispatchEvent(new Event('ended'));
  const result = await recorder.stop();
  assert.equal(result.interrupted, true);
  assert.equal(result.durationMs, 5000);
  assert.equal(recorder.state, 'interrupted');
  assert.equal(await chunks[0].blob.text(), 'tail');
});

test('canceling while permission is pending stops a late microphone stream', async () => {
  let allow;
  const permission = new Promise(resolve => { allow = resolve; });
  const env = environment({ getUserMedia: () => permission });
  const recorder = new env.Recorder();
  const starting = recorder.start();
  await recorder.stop();
  allow(env.stream);
  await assert.rejects(starting, error => error.code === 'START_CANCELLED');
  assert.equal(env.track.stopped, true);
  assert.equal(env.instances.length, 0);
});

test('native stop failure preserves received fragments and rejects complete-recording success', async () => {
  const env = environment({ failStop: true });
  const saved = [];
  const recorder = new env.Recorder({ onChunk: asset => saved.push(asset) });
  await recorder.start();
  env.advance(10000);
  env.instances[0].chunk('already captured');
  await assert.rejects(recorder.stop(), error => error.code === 'STOP_FAILED');
  assert.equal(recorder.state, 'interrupted');
  assert.equal(saved.length, 1);
  assert.equal(await saved[0].blob.text(), 'already captured');
  assert.equal(env.track.stopped, true);
});
