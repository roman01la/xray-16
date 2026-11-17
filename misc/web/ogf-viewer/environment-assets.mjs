import {chunks, Reader} from './xray-binary.mjs';

const ltx = /^configs?\/(.+\.ltx)$/;
export const environmentSound = path => /^sounds\/(?:ambient|nature)\/.+\.ogg$/.test(path);
export const environmentModifier = path => /^levels\/[^/]+\/level\.env_mod$/.test(path);
const decoder = new TextDecoder('windows-1251');
const key = name => name?.trim().replaceAll('\\', '/').toLowerCase() ?? '';
const split = value => (value ?? '').split(',').map(x => x.trim()).filter(Boolean);
const seconds = time => time.split(':').reduce((value, part) => value * 60 + Number(part), 0);
const hour = /^\d\d:\d\d:\d\d$/;

function sections(bytes) {
  const result = new Map();
  let current;
  for (const line of decoder.decode(bytes).split(/\r?\n/)) {
    const clean = line.split(';', 1)[0].trim();
    if (!clean || clean.startsWith('#') || clean.startsWith('//')) continue;
    const header = /^\[([^\]]+)\]/.exec(clean);
    if (header) {
      current = Object.create(null);
      result.set(header[1].toLowerCase(), current);
      continue;
    }
    const equal = clean.indexOf('=');
    if (current) current[(equal < 0 ? clean : clean.slice(0, equal)).trim().toLowerCase()] =
      equal < 0 ? '' : clean.slice(equal + 1).trim();
  }
  return result;
}

function descriptor(time, values, legacy) {
  const number = (name, fallback) => Number.isFinite(Number(values[name])) ? Number(values[name]) : fallback;
  const vector = (name, fallback) => {
    const parts = split(values[name]).map(Number);
    return parts.length >= fallback.length && parts.every(Number.isFinite) ? parts : fallback;
  };
  const skyRotation = number('sky_rotation', 0);
  const clouds = vector('clouds_color', [1, 1, 1, 0]);
  const sunAngles = vector('sun_dir', [number('sun_longitude', -45), number('sun_altitude', 0)]);
  return {
    time: seconds(time), sky: key(values.sky_texture), cloud: key(values.clouds_texture),
    skyColor: vector('sky_color', [0.65, 0.65, 0.65]).map(x => x * (legacy ? 0.5 : 1)),
    skyRotation, cloudRotation: number('clouds_rotation', skyRotation),
    cloudColor: clouds.slice(0, 3).map(x => x * (clouds[4] ?? 2) * 0.5).concat(clouds[3]),
    fogColor: vector('fog_color', [0.55, 0.58, 0.6]), fogDensity: number('fog_density', 0.12),
    fogDistance: number('fog_distance', 450), far: number('far_plane', 500),
    rain: number('rain_density', 0), rainColor: vector('rain_color', [0.65, 0.68, 0.72]),
    sunColor: vector('sun_color', [0, 0, 0]), sunAngles, dynamicSun: !values.sun_dir,
    sunAzimuth: number('sun_azimuth', 0), shafts: number('sun_shafts_intensity', 0),
    ambientColor: vector(legacy ? 'ambient' : 'ambient_color', [0.08, 0.08, 0.08]),
    hemiColor: vector(values.hemisphere_color ? 'hemisphere_color' : 'hemi_color', [0.55, 0.55, 0.55]),
    ambient: key(values[legacy ? 'env_ambient' : 'ambient']),
    wind: number('wind_velocity', 0), windDirection: number('wind_direction', 0),
    treeAmplitude: number('trees_amplitude', number('tree_amplitude_intensity', 0.005)),
    treeSpeed: number('trees_speed', 1), treeRotation: number('trees_rotation', 10),
    treeWave: vector('trees_wave', [0.1, 0.01, 0.11]),
    water: number('water_intensity', 1), thunder: key(values[legacy ? 'thunderbolt' : 'thunderbolt_collection']),
    thunderPeriod: number(legacy ? 'bolt_period' : 'thunderbolt_period', 0),
    thunderDuration: number(legacy ? 'bolt_duration' : 'thunderbolt_duration', 0),
  };
}

function modifiers(bytes) {
  const entries = chunks(bytes);
  const version = entries.get(0)?.length === 4 ? new Reader(entries.get(0)).u32() : 0x15;
  const out = [];
  for (const bytes of entries.values()) {
    if (bytes.length < 76) continue;
    const input = new Reader(bytes);
    const position = input.vec3(), radius = input.f32(), power = input.f32(), far = input.f32(),
      fogColor = input.vec3(), fogDensity = input.f32(), ambientColor = input.vec3(),
      skyColor = input.vec3(), hemiColor = input.vec3();
    if (radius > 0 && power > 0) out.push({position, radius, power, far, fogColor, fogDensity,
      ambientColor, skyColor, hemiColor, flags: version >= 0x16 && input.remaining >= 2 ? input.u16() : 63});
  }
  return out;
}

export async function readEnvironmentAssets(assets, read) {
  const files = new Map(), local = Object.create(null);
  for (const [path, entry] of assets) {
    const config = ltx.exec(path)?.[1];
    if (config && /^(?:environment\/|weathers\/|game_levels\.ltx$)/.test(config))
      files.set(config, sections(await read(entry)));
    if (environmentModifier(path)) {
      const values = modifiers(await read(entry));
      if (values.length) local[path.split('/')[1]] = values;
    }
  }
  const presets = Object.create(null), levelWeather = Object.create(null);
  const old = new Map([...files].filter(([name]) => name.startsWith('weathers/')).flatMap(([, sections]) => [...sections]));

  function add(name, frames, event) {
    if (!frames.length || /^dw_/.test(name)) return;
    presets[name] = {frames: frames.sort((a, b) => a.time - b.time), event};
  }
  for (const [name, entries] of files) {
    const file = /^environment\/(weathers|weather_effects)\/(.+)\.ltx$/.exec(name);
    if (!file) continue;
    const event = file[1] === 'weather_effects';
    add(event ? 'fx:' + file[2] : file[2], [...entries].filter(([time, values]) => hour.test(time) && values.sky_texture)
      .map(([time, values]) => descriptor(time, values, false)), event);
  }
  for (const [label, event] of [['weathers', false], ['weather_effects', true]]) {
    for (const [name, mapped] of Object.entries(old.get(label) ?? {})) {
      const frames = Object.entries(old.get(key(mapped)) ?? {}).filter(([time, id]) => hour.test(time) && old.get(key(id))?.sky_texture)
        .map(([time, id]) => descriptor(time, old.get(key(id)), true));
      add(event ? 'fx:' + name : name, frames, event);
    }
  }
  const main = presets.default_clear ? 'default_clear' : presets.default ? 'default' : Object.keys(presets)[0];
  for (const {name, weathers, weather} of files.get('game_levels.ltx')?.values() ?? []) {
    const preset = key(weathers ?? weather);
    if (preset === '[default]') continue;
    if (name && presets[preset]) levelWeather[key(name)] = preset;
  }

  const sounds = value => split(value).map(name => 'sounds/' + key(name).replace(/\.ogg$/, '') + '.ogg')
    .filter(path => assets.has(path));
  const channels = files.get('environment/sound_channels.ltx') ?? old;
  const ambients = Object.create(null);
  function ambientPresets(definitions) {
    const result = Object.create(null);
    for (const [name, definition] of definitions) {
      const picks = split(definition.sound_channels ?? definition.snd_channels)
        .flatMap(channel => sounds(channels.get(key(channel))?.sounds));
      if (definition.sounds) picks.push(...sounds(definition.sounds));
      if (picks.length) result[name] = [...new Set(picks)];
    }
    return result;
  }
  Object.assign(ambients, ambientPresets(files.get('weathers/env_ambient.ltx') ?? new Map()),
    ambientPresets(files.get('environment/ambients.ltx') ?? new Map()));
  const levelAmbients = Object.create(null);
  for (const [name, definitions] of files) {
    const level = /^environment\/ambients\/([^/]+)\.ltx$/.exec(name)?.[1];
    if (level) levelAmbients[level] = ambientPresets(definitions);
  }
  const thunderSounds = Object.create(null);
  const bolts = files.get('environment/thunderbolts.ltx') ?? old;
  for (const [name, collection] of files.get('environment/thunderbolt_collections.ltx') ?? old) {
    const choices = Object.keys(collection).flatMap(id => sounds(bolts.get(id)?.sound));
    if (choices.length) thunderSounds[name] = choices;
  }
  return {presets, main, levelWeather, local, ambients, levelAmbients, thunderSounds,
    rainSound: assets.has('sounds/ambient/rain.ogg') ? 'sounds/ambient/rain.ogg' : null};
}
