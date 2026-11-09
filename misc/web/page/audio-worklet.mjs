// Shared layout in src/xrSound/SoundRender_Web.cpp. Atomics publish complete
// control snapshots and protect unconsumed PCM from producer reuse.
export const AUDIO_HEADER_WORDS = 16;
export const AUDIO_VOICE_WORDS = 20;
export const AUDIO_FRAME_CAPACITY = 32768;

const RUNNING = 0, LISTENER_SEQUENCE = 1, MASTER_GAIN = 2, LISTENER_X = 3;
const LAYOUT_VERSION = 12, RENDERED_FRAMES = 13, MIXED_FRAMES = 14;
const VOICE_SEQUENCE = 0, GENERATION = 1, ACTIVE = 2, START_FRAME = 3;
const RATE = 4, CHANNELS = 5, POSITION_X = 6, POSITION_Y = 7, POSITION_Z = 8;
const GAIN = 9, PITCH = 10, REFERENCE = 11, MAX_DISTANCE = 12, ROLLOFF = 13, RELATIVE = 14;
const READ = 15, WRITE = 16;
const FRAME_MASK = AUDIO_FRAME_CAPACITY - 1;
const HALF_PI = Math.PI / 2;

export class XrayAudioMixer {
  constructor({buffer, offset, voices}, outputRate) {
    this.control = new Uint32Array(buffer, offset, AUDIO_HEADER_WORDS + voices * AUDIO_VOICE_WORDS);
    this.pcm = new Float32Array(buffer, offset + this.control.byteLength, voices * AUDIO_FRAME_CAPACITY * 2);
    if (Atomics.load(this.control, LAYOUT_VERSION) !== 1) throw Error('Unsupported X-Ray audio layout');
    this.voices = voices;
    this.outputRate = outputRate;
    this.listener = new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]);
    this.listenerBits = new Uint32Array(9);
    this.voiceBits = new Uint32Array(WRITE + 1);
    this.voiceParams = Array.from({length: voices}, () => new Uint32Array(WRITE + 1));
    this.voiceSequences = new Uint32Array(voices);
    this.generations = new Uint32Array(voices);
    this.fractions = new Float64Array(voices);
    this.bits = new Uint32Array(1);
    this.float = new Float32Array(this.bits.buffer);
  }

  asFloat(bits) {
    this.bits[0] = bits;
    return this.float[0];
  }

  refreshListener() {
    const sequence = Atomics.load(this.control, LISTENER_SEQUENCE);
    if (sequence & 1) return;
    for (let index = 0; index < this.listener.length; ++index)
      this.listenerBits[index] = Atomics.load(this.control, LISTENER_X + index);
    if (sequence !== Atomics.load(this.control, LISTENER_SEQUENCE)) return;
    for (let index = 0; index < this.listener.length; ++index)
      this.listener[index] = this.asFloat(this.listenerBits[index]);
  }

  mixVoice(voice, left, right) {
    const control = this.control;
    const base = AUDIO_HEADER_WORDS + voice * AUDIO_VOICE_WORDS;
    const sequence = Atomics.load(control, base + VOICE_SEQUENCE);
    const params = this.voiceParams[voice];
    if (!(sequence & 1)) {
      const changed = sequence !== this.voiceSequences[voice];
      if (!changed && !params[ACTIVE]) return;
      if (changed)
        for (let index = GENERATION; index <= RELATIVE; ++index)
          this.voiceBits[index] = Atomics.load(control, base + index);
      const write = Atomics.load(control, base + WRITE);
      if (sequence === Atomics.load(control, base + VOICE_SEQUENCE)) {
        if (changed) {
          params.set(this.voiceBits);
          this.voiceSequences[voice] = sequence;
        }
        params[WRITE] = write;
      }
    }

    let read = Atomics.load(control, base + READ);
    if (params[GENERATION] !== this.generations[voice]) {
      this.generations[voice] = params[GENERATION];
      this.fractions[voice] = 0;
      read = params[START_FRAME];
      Atomics.store(control, base + READ, read);
    }
    if (!params[ACTIVE]) return;
    const available = (params[WRITE] - read) >>> 0;
    if (!available || available > AUDIO_FRAME_CAPACITY) return;

    const step = params[RATE] * this.asFloat(params[PITCH]) / this.outputRate;
    if (!(step > 0 && Number.isFinite(step))) return;
    const stereo = params[CHANNELS] === 2;
    const gain = this.asFloat(params[GAIN]);
    let leftGain = gain, rightGain = gain;
    if (!stereo) {
      const listener = this.listener;
      let x = this.asFloat(params[POSITION_X]);
      let y = this.asFloat(params[POSITION_Y]);
      let z = this.asFloat(params[POSITION_Z]);
      let lateral = x, forward = z;
      if (!params[RELATIVE]) {
        x -= listener[0]; y -= listener[1]; z -= listener[2];
        forward = x * listener[3] + y * listener[4] + z * listener[5];
        lateral = x * listener[6] + y * listener[7] + z * listener[8];
      }
      const reference = Math.max(1e-6, this.asFloat(params[REFERENCE]));
      const distance = Math.max(reference, Math.min(this.asFloat(params[MAX_DISTANCE]), Math.hypot(x, y, z)));
      const attenuated = gain * reference / (reference + this.asFloat(params[ROLLOFF]) * (distance - reference));
      let angle = Math.atan2(lateral, forward);
      if (angle > HALF_PI) angle = Math.PI - angle;
      else if (angle < -HALF_PI) angle = -Math.PI - angle;
      const pan = (angle + HALF_PI) * 0.5;
      leftGain = attenuated * Math.cos(pan);
      rightGain = attenuated * Math.sin(pan);
    }
    if (!Number.isFinite(leftGain) || !Number.isFinite(rightGain)) return;

    const source = voice * AUDIO_FRAME_CAPACITY * 2;
    let cursor = this.fractions[voice];
    for (let out = 0; out < left.length && cursor < available; ++out, cursor += step) {
      const frame = Math.floor(cursor);
      const fraction = cursor - frame;
      const index = source + ((read + frame) & FRAME_MASK) * 2;
      const next = source + ((read + Math.min(frame + 1, available - 1)) & FRAME_MASK) * 2;
      const a = this.pcm[index];
      left[out] += (a + (this.pcm[next] - a) * fraction) * leftGain;
      if (stereo) {
        const b = this.pcm[index + 1];
        right[out] += (b + (this.pcm[next + 1] - b) * fraction) * rightGain;
      } else {
        right[out] += (a + (this.pcm[next] - a) * fraction) * rightGain;
      }
    }
    const consumed = Math.min(Math.floor(cursor), available);
    this.fractions[voice] = consumed === available ? 0 : cursor - consumed;
    Atomics.store(control, base + READ, (read + consumed) >>> 0);
  }

  mix(left, right) {
    left.fill(0); right.fill(0);
    if (!Atomics.load(this.control, RUNNING)) return false;
    this.refreshListener();
    for (let voice = 0; voice < this.voices; ++voice) this.mixVoice(voice, left, right);

    const gain = this.asFloat(Atomics.load(this.control, MASTER_GAIN));
    let mixed = 0;
    for (let out = 0; out < left.length; ++out) {
      left[out] = Math.max(-1, Math.min(1, left[out] * gain));
      right[out] = Math.max(-1, Math.min(1, right[out] * gain));
      if (left[out] !== 0 || right[out] !== 0) ++mixed;
    }
    Atomics.add(this.control, RENDERED_FRAMES, left.length);
    Atomics.add(this.control, MIXED_FRAMES, mixed);
    return true;
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class XrayAudioProcessor extends AudioWorkletProcessor {
    constructor({processorOptions}) {
      super();
      this.mixer = new XrayAudioMixer(processorOptions, sampleRate);
    }

    process(_inputs, outputs) {
      return this.mixer.mix(outputs[0][0], outputs[0][1]);
    }
  }
  registerProcessor('xray-audio', XrayAudioProcessor);
}
