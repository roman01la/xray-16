import {Action} from './particle-library.mjs';

const step = 0.033;
const maxParticles = 6000;
const zero = [0, 0, 0];
const unit = Math.random;
const normal = () => Math.sqrt(-2 * Math.log(Math.max(1e-7, unit()))) * Math.cos(unit() * Math.PI * 2);
const clamp01 = x => Math.min(1, Math.max(0, x));
const add = (a, b, n = 1) => { for (let i = 0; i < a.length; i++) a[i] += b[i] * n; };

function sample(d) {
  const {type, p1, p2, u, v, outer, inner} = d;
  const out = [...p1];
  if (type === 1) add(out, p2, unit());
  if (type === 4) return p1.map((x, i) => x + (p2[i] - x) * unit());
  if (type === 2 || type === 10) {
    let a = unit(), b = unit();
    if (type === 2 && a + b > 1) { a = 1 - a; b = 1 - b; }
    add(out, u, a);
    add(out, v, b);
  }
  if (type === 5) {
    const r = inner + (outer - inner) * unit(), direction = [normal(), normal(), normal()];
    add(out, direction, r / (Math.hypot(...direction) || 1));
  }
  if (type === 6 || type === 7 || type === 9) {
    const t = unit(), a = unit() * Math.PI * 2;
    const r = (inner + (outer - inner) * unit()) * (type === 7 ? t : 1);
    if (type !== 9) add(out, p2, t);
    add(out, u, Math.cos(a) * r);
    add(out, v, Math.sin(a) * r);
  }
  if (type === 8) return p1.map(x => x + normal() * outer);
  return out;
}

function within(d, p) {
  if (d.type === 4) return p.every((x, i) => x >= d.p1[i] && x <= d.p2[i]);
  const v = p.map((x, i) => x - d.p1[i]);
  if (d.type === 3) return v.reduce((value, x, i) => value + x * d.p2[i], 0) >= 0;
  if (d.type === 5) {
    const r = Math.hypot(...v);
    return r >= d.inner && r <= d.outer;
  }
  return undefined;
}

function lerp(current, target, rate) {
  for (let i = 0; i < current.length; i++)
    current[i] += (target[i] - current[i]) * clamp01(Array.isArray(rate) ? rate[i] : rate);
}

function force(p, type, values, shape, time) {
  const center = values.slice(0, 3);
  const delta = center.map((x, i) => x - p.position[i]);
  if (type === Action.orbitLine) {
    const axis = values.slice(3, 6);
    const dot = axis.reduce((sum, x, i) => sum + x * delta[i], 0);
    add(delta, axis, -dot);
  }
  const radius = Math.hypot(...delta);
  if (!radius) return;
  if (type === Action.explosion) {
    const [velocity, magnitude, sigma, age, epsilon] = values.slice(3);
    const distance = radius - (age + time) * velocity;
    const wave = Math.exp(-0.5 * (distance / Math.max(0.001, sigma)) ** 2);
    add(p.velocity, delta, -step * magnitude * wave / (radius + radius * radius + epsilon));
    return;
  }
  const offset = type === Action.orbitLine || type === Action.vortex ? 6 : 3;
  const [magnitude, epsilon, range] = values.slice(offset);
  if (radius >= range) return;
  if (type === Action.jet) {
    add(p.velocity, sample(shape), magnitude * step / (radius * radius + epsilon));
  } else if (type === Action.vortex) {
    const [x, y, z] = values.slice(3, 6), [a, b, c] = delta;
    add(p.position, [y * c - z * b, z * a - x * c, x * b - y * a],
      magnitude * step / Math.max(1, radius ** Math.max(0, Math.min(3, epsilon))));
  } else {
    const direction = type === Action.scatter ? -1 : 1;
    add(p.velocity, delta, direction * magnitude * step / (radius + radius * radius + epsilon));
  }
}

function apply(p, action, def, age) {
  const {type, values, shape} = action;
  switch (type) {
    case Action.gravity: add(p.velocity, values, step); break;
    case Action.move: add(p.position, p.velocity, step); p.age += step; break;
    case Action.randomAccel: add(p.velocity, sample(shape), step); break;
    case Action.randomDisplace: add(p.position, sample(shape), step); break;
    case Action.randomVelocity: p.velocity = sample(shape); break;
    case Action.targetColor: {
      const [r, g, b, a, speed, from = 0, to = 1] = values;
      if (p.age >= from * def.lifetime && p.age <= to * def.lifetime)
        lerp(p.color, [r, g, b, a], speed * step);
      break;
    }
    case Action.targetSize: lerp(p.size, values, values.slice(3, 6).map(x => x * step)); break;
    case Action.targetRotate: case Action.targetRotateD:
      p.angle += (Math.sign(p.angle || 1) * Math.abs(values[0]) - p.angle) * clamp01(values[3] * step);
      break;
    case Action.targetVelocity: case Action.targetVelocityD: lerp(p.velocity, values, values[3] * step); break;
    case Action.speedLimit: {
      const speed = Math.hypot(...p.velocity);
      if (speed) {
        const limited = Math.max(values[0], Math.min(values[1], speed));
        p.velocity = p.velocity.map(x => x * limited / speed);
      }
      break;
    }
    case Action.damping: {
      const speed = p.velocity.reduce((sum, x) => sum + x * x, 0);
      if (speed >= values[3] && speed <= values[4])
        for (let i = 0; i < 3; i++) p.velocity[i] *= 1 - (1 - values[i]) * step;
      break;
    }
    case Action.orbitLine: case Action.orbitPoint: case Action.scatter: case Action.jet:
    case Action.explosion: case Action.vortex: force(p, type, values, shape, age); break;
    case Action.turbulence: {
      const [frequency, , magnitude] = values;
      for (let i = 0; i < 3; i++) p.velocity[i] += Math.sin(age * frequency + p.position[(i + 1) % 3] * 3.1 + i) * magnitude * step;
      break;
    }
    case Action.bounce: {
      if (shape.type === 3) {
        const n = shape.p2;
        const distance = p.position.reduce((sum, x, i) => sum + (x - shape.p1[i]) * n[i], 0);
        const normalSpeed = p.velocity.reduce((sum, x, i) => sum + x * n[i], 0);
        if (distance >= 0 && distance + normalSpeed * step < 0) {
          for (let i = 0; i < 3; i++)
            p.velocity[i] = (p.velocity[i] - normalSpeed * n[i]) * values[0] - normalSpeed * n[i] * values[1];
        }
      }
      break;
    }
  }
}

function countParticles(emitter) {
  return emitter.particles.length + emitter.children.reduce((sum, child) => sum + countParticles(child.state), 0);
}

function createEmitter(def, track) {
  return {def, track, age: 0, particles: [], children: [], last: zero};
}

function advanceEmitter(emitter, age, library, budget, depth = 0) {
  const {def, track, particles, children} = emitter;
  if (age < track.start || depth > 2) return;
  emitter.age += step;
  const allowEmission = (!(track.end > track.start) || age < track.end) &&
    (!(def.timeLimit > 0) || emitter.age <= def.timeLimit);
  function child(name, position, follow) {
    const childDef = library.effects.get(name);
    if (!childDef || depth >= 2 || children.length >= 32) return;
    const state = createEmitter(childDef, {start: 0, end: childDef.timeLimit || 0.033, flags: 1});
    children.push({state, position: [...position], follow, age: 0});
  }
  if (!allowEmission && track.end > track.start && !(track.flags & 1) && age >= track.end) particles.length = 0;
  for (const action of def.actions) {
    if (action.type === Action.source) {
      if (!allowEmission || budget.left <= 0) continue;
      const count = Math.min(def.max - particles.length, budget.left, Math.floor(action.rate * step + unit()));
      const [position, velocity, rotation, size, color] = action.shapes;
      for (let i = 0; i < count; i++) {
        const p = {
          position: sample(position), velocity: sample(velocity), size: sample(size),
          angle: sample(rotation)[0], color: [...sample(color), action.alpha],
          age: action.age + (action.sigma ? normal() * action.sigma : 0),
          frame: def.frame && (def.flags & (1 << 12)) ? Math.floor(unit() * def.frame.count) : 0,
          reverse: Boolean(def.flags & (1 << 13)) && unit() < 0.5,
        };
        if (action.flags & (1 << 29)) p.size.fill(p.size[0]);
        particles.push(p);
        budget.left--;
        if (track.flags & 2) child(track.follow, p.position, p);
        if (track.flags & 32) child(track.birth, p.position);
      }
    } else if (action.type === Action.killOld || action.type === Action.sink || action.type === Action.sinkVelocity) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        const inside = action.type === Action.killOld ? p.age < action.values[0] :
          within(action.shape, action.type === Action.sink ? p.position : p.velocity);
        if (inside !== undefined && inside === Boolean(action.values[action.type === Action.killOld ? 1 : 0])) {
          if (track.flags & 64) child(track.death, p.position);
          p.dead = true;
          particles[i] = particles.at(-1);
          particles.pop();
        }
      }
    } else {
      for (const p of particles) apply(p, action, def, emitter.age);
    }
  }
  if (def.frame && (def.flags & (1 << 11))) {
    for (const p of particles) p.frame += def.frame.speed * step * (p.reverse ? -1 : 1);
  }
  for (let i = children.length - 1; i >= 0; i--) {
    const c = children[i];
    if (c.follow && !c.follow.dead) c.position = c.follow.position;
    c.age += step;
    advanceEmitter(c.state, c.age, library, budget, depth + 1);
    if (c.age > c.state.def.lifetime + 2 || c.age > 0.15 && !c.state.particles.length) children.splice(i, 1);
  }
}

function emitterDuration(def, track) {
  if (track.end > track.start) return track.end + (track.flags & 1 ? def.lifetime : 0);
  return def.timeLimit > 0 ? track.start + def.timeLimit + def.lifetime : 0;
}

function createInstance(library, name, position, angles) {
  const group = library.groups.get(name);
  const tracks = group?.tracks ?? [{effect: name, start: 0, end: 0, flags: 1}];
  const emitters = tracks.flatMap(track => {
    const def = library.effects.get(track.effect);
    return def ? [createEmitter(def, track)] : [];
  });
  const durations = emitters.map(({def, track}) => emitterDuration(def, track));
  const duration = group?.timeLimit > 0 ? Math.max(group.timeLimit, ...durations) :
    durations.every(x => x > 0) ? Math.max(0, ...durations) : 0;
  return {name, position, angles, emitters, duration, age: 0};
}

export function particleDefinitions(library, names) {
  const result = new Set();
  for (const name of names) {
    const group = library.groups.get(name);
    const referenced = group?.tracks.flatMap(t => [t.effect, t.follow, t.birth, t.death]) ?? [name];
    for (const effect of referenced) {
      const def = library.effects.get(effect);
      if (def) result.add(def);
    }
  }
  return result;
}

function worldPosition(p, instance, offset) {
  const {position, angles} = instance;
  let [x, y, z] = p.map((value, i) => value + offset[i]);
  if (angles) {
    // X-Ray's spawn orientation uses heading, pitch and bank.
    const [pitch, heading, bank] = angles;
    [x, y] = [x * Math.cos(bank) + y * Math.sin(bank), y * Math.cos(bank) - x * Math.sin(bank)];
    [y, z] = [y * Math.cos(pitch) + z * Math.sin(pitch), z * Math.cos(pitch) - y * Math.sin(pitch)];
    [x, z] = [x * Math.cos(heading) - z * Math.sin(heading), z * Math.cos(heading) + x * Math.sin(heading)];
  }
  return [x + position[0], y + position[1], z + position[2]];
}

export function createParticleScene(library, placements, {map = false, burst = false, loop = true} = {}) {
  const entries = placements.filter(p => burst ? p.burst : p.idle);
  const instances = new Map();
  let previous, pending = 0, visible = entries, finished = false;
  function updateVisibility(view) {
    if (!map) return;
    const range = view.radius / view.zoom * 1.55;
    const close = entries.map(entry => {
      const distance = Math.hypot(...entry.position.map((x, i) => x - view.center[i]));
      return {entry, distance};
    }).filter(p => p.distance < range).sort((a, b) => a.distance - b.distance).slice(0, 72);
    visible = close.map(p => p.entry);
    const included = new Set(visible);
    for (const key of instances.keys()) if (!included.has(key)) instances.delete(key);
  }

  return {
    get finished() { return finished; },
    restart() { instances.clear(); previous = undefined; pending = 0; finished = false; },
    advance(timestamp, view) {
      if (finished) return;
      updateVisibility(view);
      if (previous !== undefined) pending += Math.min(0.099, (timestamp - previous) / 1000);
      else pending = step;
      previous = timestamp;
      while (pending >= step) {
        pending -= step;
        const budget = {left: maxParticles};
        for (const value of instances.values())
          for (const emitter of value.emitters) budget.left -= countParticles(emitter);
        for (const entry of visible) {
          let instance = instances.get(entry);
          if (instance && !loop && instance.age > (instance.duration || 4)) {
            instances.delete(entry);
            finished = true;
            continue;
          }
          if (!instance || instance.duration > 0 && instance.age > instance.duration + 0.55) {
            instance = createInstance(library, burst ? entry.burst : entry.idle, entry.position, entry.angles);
            instances.set(entry, instance);
          }
          instance.age += step;
          for (const emitter of instance.emitters) advanceEmitter(emitter, instance.age, library, budget);
        }
      }
    },
    batches() {
      const buffers = new Map();
      let count = 0;
      function emit(emitter, instance, offset) {
        const {def} = emitter;
        if (emitter.particles.length) {
          if (!buffers.has(def)) buffers.set(def, []);
          const data = buffers.get(def);
          for (const p of emitter.particles) {
            if (count >= maxParticles) break;
            if (p.color[3] <= 0.002 || !p.size[0] || !p.size[1] || !p.position.every(Number.isFinite)) continue;
            const f = def.frame;
            const index = f ? (Math.floor(p.frame) % f.count + f.count) % f.count : 0;
            const position = worldPosition(p.position, instance, offset);
            const uv = f ? [index % f.columns * f.width, Math.floor(index / f.columns) * f.height, f.width, f.height] :
              [0, 0, 1, 1];
            const speed = def.velocityScale ? Math.hypot(...p.velocity) : 0;
            const width = Math.abs(p.size[0] + 2 * speed * (def.velocityScale?.[0] ?? 0));
            const height = Math.abs(p.size[1] + 2 * speed * (def.velocityScale?.[1] ?? 0));
            data.push(...position, width, height, p.angle, ...p.color, ...uv);
            count++;
          }
        }
        for (const c of emitter.children) emit(c.state, instance, c.position.map((x, i) => x + offset[i]));
      }
      for (const instance of instances.values()) for (const emitter of instance.emitters) emit(emitter, instance, zero);
      return {buffers, count};
    },
  };
}
