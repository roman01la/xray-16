import {chunks, Reader} from './xray-binary.mjs';

export const effectKey = name => name.trim().replaceAll('/', '\\').toLowerCase();

export const Action = Object.freeze({
  avoid: 0, bounce: 1, copy: 3, damping: 4, explosion: 5, follow: 6, gravitate: 7,
  gravity: 8, jet: 9, killOld: 10, match: 11, move: 12, orbitLine: 13, orbitPoint: 14,
  randomAccel: 15, randomDisplace: 16, randomVelocity: 17, restore: 18, sink: 19, sinkVelocity: 20,
  source: 21, speedLimit: 22, targetColor: 23, targetSize: 24, targetRotate: 25,
  targetRotateD: 26, targetVelocity: 27, targetVelocityD: 28, vortex: 29, turbulence: 30, scatter: 31,
});

function domain(reader) {
  const type = reader.u32(), p1 = reader.vec3(), p2 = reader.vec3(), u = reader.vec3(), v = reader.vec3();
  const outer = reader.f32(), inner = reader.f32();
  reader.take(8);
  if (type > 10) throw new Error('Unknown particle domain ' + type);
  return {type, p1, p2, u, v, outer, inner};
}

function readActions(bytes, soc) {
  const reader = new Reader(bytes);
  const count = reader.u32();
  if (count > 512) throw new Error('Invalid particle action count');
  const actions = [];
  for (let i = 0; i < count; i++) {
    const type = reader.u32(), flags = reader.u32();
    if (reader.u32() !== type) throw new Error('Invalid particle action type');
    const values = [];
    let shape;
    switch (type) {
      case Action.source: {
        const shapes = Array.from({length: 5}, () => domain(reader));
        const alpha = reader.f32(), rate = reader.f32(), age = reader.f32(), sigma = reader.f32();
        reader.take(16); // Runtime parent velocity and its influence.
        actions.push({type, flags, shapes, alpha, rate, age, sigma});
        continue;
      }
      case Action.avoid: case Action.bounce:
        shape = domain(reader);
        values.push(reader.f32(), reader.f32(), reader.f32());
        break;
      case Action.jet:
        values.push(...reader.vec3());
        shape = domain(reader);
        values.push(...reader.vec3());
        break;
      case Action.sink: case Action.sinkVelocity:
        values.push(reader.u32());
        shape = domain(reader);
        break;
      case Action.randomAccel: case Action.randomDisplace: case Action.randomVelocity:
        shape = domain(reader);
        break;
      case Action.killOld:
        values.push(reader.f32(), reader.u32());
        break;
      default: {
        const words = {
          [Action.copy]: 1, [Action.damping]: 5, [Action.explosion]: 8, [Action.follow]: 3,
          [Action.gravitate]: 3, [Action.gravity]: 3, [Action.match]: 3, [Action.move]: 0,
          [Action.orbitLine]: 9, [Action.orbitPoint]: 6, [Action.restore]: 1, [Action.speedLimit]: 2,
          [Action.targetColor]: soc ? 5 : 7, [Action.targetSize]: 6,
          [Action.targetRotate]: 4, [Action.targetRotateD]: 4, [Action.targetVelocity]: 4,
          [Action.targetVelocityD]: 4, [Action.vortex]: 9, [Action.turbulence]: 7, [Action.scatter]: 6,
        }[type];
        if (words === undefined) throw new Error('Unknown particle action ' + type);
        for (let j = 0; j < words; j++) values.push(reader.f32());
        break;
      }
    }
    actions.push({type, values, shape});
  }
  if (reader.remaining) throw new Error('Unrecognized particle action data');
  return actions;
}

function optionalFloat(fields, id, fallback = 0) {
  return fields.has(id) ? new Reader(fields.get(id)).f32() : fallback;
}

function readEffect(fields, name, soc) {
  const flags = new Reader(fields.get(5)).u32();
  const sprite = new Reader(fields.get(7));
  const shader = effectKey(sprite.string());
  const textures = sprite.string().split(',').map(effectKey);
  const actions = readActions(fields.get(4), soc);
  let frame;
  if ((flags & (1 << 10)) && fields.has(6)) {
    const data = new Reader(fields.get(6));
    const width = data.f32(), height = data.f32();
    data.take(8);
    const columns = data.u32(), count = data.u32(), speed = data.f32();
    if (columns && count && width > 0 && height > 0) frame = {width, height, columns, count, speed};
  }
  const max = new Reader(fields.get(3)).u32();
  const rateLimit = actions.find(action => action.type === Action.killOld && !action.values[1])?.values[0] ?? 5;
  return {name, flags, shader, textures, actions, frame, max, lifetime: rateLimit,
    timeLimit: optionalFloat(fields, 8),
    velocityScale: fields.has(0x22) && new Reader(fields.get(0x22)).vec3()};
}

function readGroup(fields, name) {
  const reader = new Reader(fields.get(4) ?? fields.get(7));
  const count = reader.u32(), tracks = [];
  if (count > 256) throw new Error('Invalid particle group track count');
  for (let i = 0; i < count; i++) {
    const effect = effectKey(reader.string()), follow = effectKey(reader.string());
    const birth = effectKey(reader.string()), death = effectKey(reader.string());
    const start = reader.f32(), end = reader.f32(), flags = reader.u32();
    if (flags & 4) tracks.push({effect, follow, birth, death, start, end, flags});
  }
  return {name, tracks, timeLimit: optionalFloat(fields, 5)};
}

export function readParticleLibrary(bytes, game) {
  const file = chunks(bytes), effects = new Map(), groups = new Map(), unsupported = new Map();
  for (const [chunk, target] of [[3, effects], [4, groups]]) {
    if (!file.has(chunk)) continue;
    for (const bytes of chunks(file.get(chunk)).values()) {
      const fields = chunks(bytes);
      const name = effectKey(new Reader(fields.get(2)).string());
      try {
        const def = chunk === 3 ? readEffect(fields, name, game === 'soc') : readGroup(fields, name);
        target.set(name, def);
      } catch (error) {
        unsupported.set(name, error.message);
      }
    }
  }
  return {effects, groups, unsupported, names: [...effects.keys(), ...groups.keys(), ...unsupported.keys()].sort()};
}
