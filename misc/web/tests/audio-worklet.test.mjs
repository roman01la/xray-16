import test from 'node:test';
import assert from 'node:assert/strict';
import {AUDIO_FRAME_CAPACITY, AUDIO_HEADER_WORDS, AUDIO_VOICE_WORDS, XrayAudioMixer} from '../page/audio-worklet.mjs';

const CONTROL = {running: 0, gain: 2, version: 12, rendered: 13, mixed: 14};
const VOICE = {sequence: 0, generation: 1, active: 2, first: 3, rate: 4, channels: 5, x: 6,
  gain: 9, pitch: 10, reference: 11, maxDistance: 12, rolloff: 13, relative: 14, read: 15, write: 16};
const bits = new Uint32Array(1), floats = new Float32Array(bits.buffer);
const asBits = value => { floats[0] = value; return bits[0]; };

function fixture(voices = 1) {
  const offset = 512;
  const controlLength = AUDIO_HEADER_WORDS + voices * AUDIO_VOICE_WORDS;
  const sampleLength = voices * AUDIO_FRAME_CAPACITY * 2;
  const pages = Math.ceil((offset + (controlLength + sampleLength) * 4) / 65536);
  const memory = new WebAssembly.Memory({initial: pages, maximum: pages + 1, shared: true});
  const views = () => ({
    control: new Uint32Array(memory.buffer, offset, controlLength),
    pcm: new Float32Array(memory.buffer, offset + controlLength * 4, sampleLength),
  });
  const {control} = views();
  control[CONTROL.running] = control[CONTROL.version] = 1;
  control[CONTROL.gain] = asBits(1);
  control[8] = control[9] = asBits(1); // forward Z, right X
  const mixer = new XrayAudioMixer({buffer: memory.buffer, offset, voices}, 48000);
  const publish = (voice, params) => {
    const {control} = views(), base = AUDIO_HEADER_WORDS + voice * AUDIO_VOICE_WORDS;
    Atomics.add(control, base + VOICE.sequence, 1);
    for (const [name, value] of Object.entries(params)) Atomics.store(control, base + VOICE[name], value);
    Atomics.add(control, base + VOICE.sequence, 1);
  };
  const submit = (voice, first, frames) => {
    const {control, pcm} = views(), start = voice * AUDIO_FRAME_CAPACITY * 2;
    for (const [index, [left, right]] of frames.entries()) {
      const position = start + ((first + index) & (AUDIO_FRAME_CAPACITY - 1)) * 2;
      pcm[position] = left; pcm[position + 1] = right;
    }
    Atomics.store(control, AUDIO_HEADER_WORDS + voice * AUDIO_VOICE_WORDS + VOICE.write, first + frames.length);
  };
  const mix = length => {
    const left = new Float32Array(length), right = new Float32Array(length);
    const running = mixer.mix(left, right);
    return {left: [...left], right: [...right], running};
  };
  return {control, memory, views, publish, submit, mix};
}

const playing = {generation: 1, active: 1, first: 0, rate: 48000, channels: 2,
  gain: asBits(1), pitch: asBits(1), reference: asBits(1), maxDistance: asBits(100), rolloff: asBits(1)};

test('worklet advances stereo PCM and shares fixed views through Wasm memory growth', () => {
  const f = fixture();
  f.memory.grow(1);
  const current = f.views().control;
  current[CONTROL.gain] = asBits(0.5);
  f.publish(0, playing);
  f.submit(0, 0, [[0.5, -1], [1, 0.25]]);
  assert.deepEqual(f.mix(3), {left: [0.25, 0.5, 0], right: [-0.5, 0.125, 0], running: true});
  assert.equal(Atomics.load(current, AUDIO_HEADER_WORDS + VOICE.read), 2);
  assert.equal(Atomics.load(current, CONTROL.rendered), 3);
  assert.equal(Atomics.load(current, CONTROL.mixed), 2);
});

test('worklet resamples pitch across quanta and pans mono through stock distance attenuation', () => {
  const f = fixture();
  f.publish(0, {...playing, channels: 1, x: asBits(2), pitch: asBits(0.5)});
  f.submit(0, 0, [[0, 0], [1, 0], [0, 0]]);
  assert.deepEqual(f.mix(2).right, [0, 0.25]);
  const next = f.mix(2);
  assert.deepEqual(next.right, [0.5, 0.25]);
  assert.ok(next.left.every(value => Math.abs(value) < 1e-6));
});

test('stop and rewind generations drop old PCM and handle wrapped cursors', () => {
  const f = fixture();
  const nearWrap = 0xffff_fffe;
  f.publish(0, {...playing, first: nearWrap});
  f.submit(0, nearWrap, [[1, 1], [0.25, -0.25], [0.5, -0.5]]);
  assert.deepEqual(f.mix(1).left, [1]);
  f.publish(0, {generation: 2, active: 0, first: 1});
  assert.deepEqual(f.mix(2).left, [0, 0]);
  assert.equal(f.control[AUDIO_HEADER_WORDS + VOICE.read], 1);
  f.publish(0, {...playing, generation: 3, first: 1, relative: 1});
  f.submit(0, 1, [[-0.75, 0.125]]);
  assert.deepEqual(f.mix(2).left, [-0.75, 0]);
  f.control[CONTROL.running] = 0;
  assert.equal(f.mix(2).running, false);
});

test('worklet retains the last complete voice state while an update is in progress', () => {
  const f = fixture(2);
  f.publish(0, playing);
  f.publish(1, playing);
  f.submit(0, 0, [[0.25, 0.25], [0.5, 0.5]]);
  f.submit(1, 0, [[0.125, 0.125], [0.25, 0.25]]);
  assert.deepEqual(f.mix(1).left, [0.375]);
  Atomics.add(f.control, AUDIO_HEADER_WORDS + VOICE.sequence, 1);
  f.control[AUDIO_HEADER_WORDS + VOICE.gain] = asBits(0);
  assert.deepEqual(f.mix(1).left, [0.75]);
});
