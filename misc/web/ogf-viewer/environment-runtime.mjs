const day = 86400;
const rad = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const circular = (from, to, amount) => from + (((to - from) % 360 + 540) % 360 - 180) * amount;
const mix = (a, b, amount) => a + (b - a) * amount;
const vectorMix = (a, b, amount) => a.map((x, i) => mix(x, b[i] ?? x, amount));

function sun(time, angles, azimuth, dynamic) {
  let [pitch, heading] = angles;
  let daylight = 1;
  if (dynamic) {
    // Same latitude, longitude and seasonal declination as X-Ray's descriptor mixer.
    const g = 360 / 365.25 * (180 + time / day) * rad;
    const declination = (0.396372 - 22.91327 * Math.cos(g) + 4.02543 * Math.sin(g)
      - 0.387205 * Math.cos(2 * g) + 0.051967 * Math.sin(2 * g)
      - 0.154527 * Math.cos(3 * g) + 0.084798 * Math.sin(3 * g)) * rad;
    const correction = 0.004297 + 0.107029 * Math.cos(g) - 1.837877 * Math.sin(g)
      - 0.837378 * Math.cos(2 * g) - 2.340475 * Math.sin(2 * g);
    const hourAngle = ((time / 3600 - 12) * 15 - 30.4 + correction + 540) % 360 - 180;
    const latitude = 50.27 * rad;
    const zenith = Math.acos(clamp(Math.sin(latitude) * Math.sin(declination) +
      Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle * rad), -1, 1));
    const elevation = 90 - zenith / rad;
    pitch = -Math.max(1, elevation);
    daylight = clamp((elevation - 1) / 2);
    const denominator = Math.max(1e-5, Math.sin(zenith) * Math.cos(latitude));
    heading = Math.acos(clamp((Math.sin(declination) - Math.sin(latitude) * Math.cos(zenith)) / denominator, -1, 1))
      / rad + azimuth;
    if (hourAngle < 0) heading = 360 - heading;
  }
  const h = heading * rad, p = pitch * rad;
  return {direction: [Math.cos(p) * Math.sin(h), -Math.sin(p), -Math.cos(p) * Math.cos(h)], daylight};
}

const vectorFields = ['skyColor', 'cloudColor', 'fogColor', 'rainColor', 'ambientColor', 'hemiColor', 'sunColor', 'treeWave'];
const scalarFields = ['fogDensity', 'fogDistance', 'far', 'rain', 'wind', 'water', 'treeAmplitude',
  'treeSpeed', 'treeRotation', 'shafts', 'thunderPeriod', 'thunderDuration'];
const modifierFields = ['far', 'fogColor', 'fogDensity', 'ambientColor', 'skyColor', 'hemiColor'];

export function sampleWeather(preset, time, position, modifiers = []) {
  const {frames, event} = preset;
  const first = frames[0], last = frames.at(-1);
  const t = event ? clamp(time, first.time, last.time) : (time + day) % day;
  const next = frames.findIndex(frame => frame.time > t);
  const a = next <= 0 ? event && next === 0 ? first : last : frames[next - 1];
  const b = next < 0 ? event ? last : first : frames[next];
  let span = b.time - a.time, offset = t - a.time;
  if (!event && span < 0) span += day;
  if (!event && offset < 0) offset += day;
  const blend = span > 0 ? clamp(offset / span) : 0;
  const nearest = blend < 0.5 ? a : b;
  const result = {a, b, blend, ambient: nearest.ambient, thunder: nearest.thunder};
  for (const key of vectorFields) result[key] = vectorMix(a[key], b[key], blend);
  for (const key of scalarFields) result[key] = mix(a[key], b[key], blend);
  result.windDirection = circular(a.windDirection, b.windDirection, blend) * rad;
  result.cloudRotation = circular(a.cloudRotation, b.cloudRotation, blend) * rad;
  const angles = a.sunAngles.map((x, i) => circular(x, b.sunAngles[i], blend));
  const solar = sun(t, angles, mix(a.sunAzimuth, b.sunAzimuth, blend), nearest.dynamicSun);
  result.sunDirection = solar.direction;
  result.sunColor = result.sunColor.map(x => x * solar.daylight);
  const weights = new Float32Array(modifierFields.length).fill(1);
  for (const {position: center, radius, flags, power, ...values} of modifiers) {
    const distance = Math.hypot(position[0] - center[0], position[1] - center[1], position[2] - center[2]);
    const weight = power * (1 - distance / radius);
    if (weight <= 0) continue;
    for (const [i, key] of modifierFields.entries()) {
      if (!(flags & (1 << i))) continue;
      weights[i] += weight;
      if (Array.isArray(result[key])) result[key] = result[key].map((x, axis) => x + values[key][axis] * weight);
      else result[key] += values[key] * weight;
    }
  }
  for (const [i, key] of modifierFields.entries()) {
    if (weights[i] === 1) continue;
    if (Array.isArray(result[key])) result[key] = result[key].map(x => x / weights[i]);
    else result[key] /= weights[i];
  }
  return result;
}

const choose = values => values?.[Math.floor(Math.random() * values.length)];
const texturePath = name => 'textures/' + name.replace(/\.dds$/i, '') + '.dds';

export function createEnvironmentPlayer({renderer, source, game, level, data, signal, invalidate}) {
  const {presets} = data;
  const textures = new Map(), sounds = new Map(), playingSounds = new Set();
  let preset = data.levelWeather[level] ?? data.main;
  let playing = false, sound = false, enabled = true;
  let time = 13 * 3600, previous, elapsed = 0, nextThunder = 0, lastBolt = -100, nextAudio = 0, rainAudio;
  let lastAmbient, lastThunder, rainPending = false, disposed = false, lastAssets = '';
  let skyHandles = new Set(), cloudHandles = new Set();

  function requestTexture(type, name, keep) {
    if (!name || textures.has(type + name)) return;
    const key = type + name;
    const record = {handle: null};
    textures.set(key, record);
    source.asset(game, texturePath(name), signal).then(bytes => {
      if (disposed || signal.aborted || !keep().has(name)) return;
      record.handle = type === 'sky' ? renderer.skyTexture(bytes) : renderer.mapTexture(bytes);
      invalidate();
    }).catch(() => {});
  }

  function prepareTextures(frame) {
    const skies = new Set([frame.a.sky, frame.b.sky]), clouds = new Set([frame.a.cloud, frame.b.cloud]);
    const signature = [...skies, '|', ...clouds].join('/');
    if (lastAssets === signature) return;
    lastAssets = signature;
    skyHandles = skies;
    cloudHandles = clouds;
    for (const [key, record] of textures) {
      const desired = key.startsWith('sky') ? skies : clouds;
      if (desired.has(key.slice(key.startsWith('sky') ? 3 : 5))) continue;
      textures.delete(key);
      if (record.handle) renderer.deleteTexture(record.handle);
    }
    for (const name of skies) requestTexture('sky', name, () => skyHandles);
    for (const name of clouds) requestTexture('cloud', name, () => cloudHandles);
  }

  async function playSound(path, volume, loop = false) {
    if (!path || !sound) return;
    let request = sounds.get(path);
    if (!request) {
      request = source.asset(game, path, signal);
      sounds.set(path, request);
    }
    try {
      const bytes = await request;
      if (!sound || disposed || signal.aborted) return;
      const url = URL.createObjectURL(new Blob([bytes], {type: 'audio/ogg'}));
      const audio = new Audio(url);
      audio.volume = clamp(volume);
      audio.loop = loop;
      const entry = {audio, url};
      playingSounds.add(entry);
      const cleanup = () => {
        URL.revokeObjectURL(url);
        playingSounds.delete(entry);
      };
      audio.addEventListener('ended', cleanup, {once: true});
      await audio.play().catch(cleanup);
      return playingSounds.has(entry) ? entry : undefined;
    } catch {
      sounds.delete(path);
    }
  }

  function stopAudio(entry) {
    if (!entry) return;
    entry.audio.pause();
    URL.revokeObjectURL(entry.url);
    playingSounds.delete(entry);
  }

  function updateSound(frame) {
    if (!sound) return;
    if (lastAmbient !== frame.ambient) {
      lastAmbient = frame.ambient;
      nextAudio = elapsed + 0.1;
    }
    if (elapsed >= nextAudio) {
      nextAudio = elapsed + 7 + Math.random() * 14;
      const candidates = data.levelAmbients[level]?.[frame.ambient] ?? data.ambients[frame.ambient];
      void playSound(choose(candidates), 0.32);
    }
    if (frame.rain > 0.03 && data.rainSound) {
      if (rainAudio) rainAudio.audio.volume = clamp(frame.rain * 0.45);
      else if (!rainPending) {
        rainPending = true;
        void playSound(data.rainSound, frame.rain * 0.45, true).then(result => {
          rainAudio = result;
          rainPending = false;
        });
      }
    } else if (rainAudio) {
      stopAudio(rainAudio);
      rainAudio = undefined;
    }
  }

  function resetWeather() {
    lastThunder = undefined;
    lastBolt = -100;
  }

  return {
    get preset() { return preset; },
    get time() { return time; },
    get duration() { return presets[preset].event ? presets[preset].frames.at(-1).time : day - 1; },
    get event() { return presets[preset].event; },
    get animating() { return enabled; },
    setPreset(value) {
      if (!presets[value]) return;
      preset = value;
      if (presets[value].event) time = presets[value].frames[0].time;
      resetWeather();
    },
    setTime(value) { time = clamp(value, 0, this.duration); },
    setPlaying(value) { playing = value; },
    setEnabled(value) {
      enabled = value;
      previous = undefined;
      if (!value) this.setSound(false);
    },
    setSound(value) {
      sound = value;
      if (!sound) {
        for (const entry of playingSounds) stopAudio(entry);
        rainAudio = undefined;
      } else nextAudio = elapsed;
    },
    dispose() {
      disposed = true;
      this.setSound(false);
      for (const {handle} of textures.values()) if (handle) renderer.deleteTexture(handle);
      textures.clear();
    },
    frame(timestamp, center) {
      if (!enabled || disposed) return undefined;
      const dt = previous === undefined ? 0 : clamp((timestamp - previous) / 1000, 0, 0.12);
      previous = timestamp;
      elapsed += dt;
      if (playing) {
        const sped = time + dt * (this.event ? 5 : 240);
        time = this.event ? Math.min(this.duration, sped) : sped % day;
      }
      const frame = sampleWeather(presets[preset], time, center, data.local[level]);
      if (frame.thunder !== lastThunder) {
        lastThunder = frame.thunder;
        nextThunder = elapsed + 1.5;
      }
      if (frame.thunder && frame.thunderPeriod > 0 && elapsed >= nextThunder) {
        nextThunder = elapsed + Math.max(4, frame.thunderPeriod) * (0.75 + Math.random() * 0.5);
        lastBolt = elapsed;
        void playSound(choose(data.thunderSounds[frame.thunder]), 0.58);
      }
      const boltAge = elapsed - lastBolt;
      frame.flash = boltAge < Math.max(0.15, frame.thunderDuration) ?
        Math.exp(-boltAge * 8) * (0.7 + 0.3 * Math.cos(boltAge * 51)) : 0;
      prepareTextures(frame);
      updateSound(frame);
      frame.skies = [textures.get('sky' + frame.a.sky)?.handle, textures.get('sky' + frame.b.sky)?.handle];
      frame.clouds = [textures.get('cloud' + frame.a.cloud)?.handle, textures.get('cloud' + frame.b.cloud)?.handle];
      frame.elapsed = elapsed;
      return frame;
    },
  };
}
