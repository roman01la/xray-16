import {chunks, Reader} from './xray-binary.mjs';

const slotSize = 2;
const binSize = 8;
const maxInstances = 28000;

export function readDetails(bytes) {
  const file = chunks(bytes), header = new Reader(file.get(0));
  if (header.u32() !== 3) throw new Error('Unsupported level.details version');
  const count = header.u32(), offsetX = header.i32(), offsetZ = header.i32(), width = header.u32(), depth = header.u32();
  const slotBytes = file.get(2);
  if (count > 63 || !width || !depth || width * depth > 4000000 || slotBytes?.byteLength !== width * depth * 16)
    throw new Error('Invalid terrain detail grid');

  const objects = chunks(file.get(1));
  const prototypes = Array.from({length: count}, (_, id) => {
    const input = new Reader(objects.get(id));
    const shader = input.string(), texture = input.string(), flags = input.u32();
    const minScale = input.f32(), maxScale = input.f32();
    const vertexCount = input.u32(), indexCount = input.u32();
    if (vertexCount > 65535 || indexCount % 3 || vertexCount * 20 + indexCount * 2 > input.remaining)
      throw new Error('Invalid terrain detail mesh');
    const vertices = new Float32Array(vertexCount * 8), indices = new Uint16Array(indexCount);
    const wind = flags & 1 ? null : new Float32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
      const position = input.vec3(), u = input.f32(), v = input.f32();
      vertices.set([...position, 0, 1, 0, u, v], i * 8);
      if (wind) wind[i] = Math.max(0, position[1]);
    }
    for (let i = 0; i < indexCount; i++) {
      const index = input.u16();
      if (index >= vertexCount) throw new Error('Invalid terrain detail mesh index');
      indices[i] = index;
    }
    return {shader, texture, minScale, maxScale, vertices, indices, wind};
  });
  return {
    prototypes, originX: -slotSize * offsetX, originZ: -slotSize * offsetZ,
    width, depth, slots: new DataView(slotBytes.buffer, slotBytes.byteOffset, slotBytes.byteLength),
  };
}

export function buildGroundIndex(buffer, details, passable) {
  const reader = new Reader(buffer);
  if (reader.u32() !== 4) throw new Error('Unsupported level.cform version');
  const vertexCount = reader.u32(), triangleCount = reader.u32();
  reader.take(24); // Bounding box.
  if (vertexCount * 12 + triangleCount * 16 !== reader.remaining) throw new Error('Invalid collision geometry');
  const position = new Float32Array(buffer, 36, vertexCount * 3);
  const triangles = new Uint32Array(buffer, 36 + vertexCount * 12, triangleCount * 4);
  const {originX, originZ} = details;
  const binWidth = Math.ceil(details.width * slotSize / binSize), binDepth = Math.ceil(details.depth * slotSize / binSize);
  const ignored = new Uint8Array(16384);
  for (const id of passable) if (id < ignored.length) ignored[id] = 1;

  function visit(add) {
    for (let i = 0; i < triangles.length; i += 4) {
      if (ignored[triangles[i + 3] & 0x3fff]) continue;
      const a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
      if (c >= position.length || b >= position.length || a >= position.length) continue;
      const ax = position[a], az = position[a + 2], bx = position[b], bz = position[b + 2],
        cx = position[c], cz = position[c + 2];
      // Downward, back-face-culled ray used by CDetailManager.
      if ((bx - ax) * (cz - az) - (bz - az) * (cx - ax) >= -1e-6) continue;
      const left = Math.max(0, Math.floor((Math.min(ax, bx, cx) - originX) / binSize));
      const right = Math.min(binWidth - 1, Math.floor((Math.max(ax, bx, cx) - originX) / binSize));
      const top = Math.max(0, Math.floor((Math.min(az, bz, cz) - originZ) / binSize));
      const bottom = Math.min(binDepth - 1, Math.floor((Math.max(az, bz, cz) - originZ) / binSize));
      for (let z = top; z <= bottom; z++) {
        for (let x = left; x <= right; x++) add(z * binWidth + x, i);
      }
    }
  }
  const bounds = new Uint32Array(binWidth * binDepth + 1);
  visit(bin => { bounds[bin + 1]++; });
  for (let i = 1; i < bounds.length; i++) bounds[i] += bounds[i - 1];
  if (bounds.at(-1) > 12000000) throw new Error('Terrain collision index exceeds the viewer limit');
  const entries = new Uint32Array(bounds.at(-1)), cursor = bounds.slice(0, -1);
  visit((bin, triangle) => { entries[cursor[bin]++] = triangle; });

  return function groundHeight(x, z, low, high) {
    const ix = Math.floor((x - originX) / binSize), iz = Math.floor((z - originZ) / binSize);
    if (ix < 0 || ix >= binWidth || iz < 0 || iz >= binDepth) return undefined;
    let best;
    const bin = iz * binWidth + ix;
    for (let j = bounds[bin]; j < bounds[bin + 1]; j++) {
      const i = entries[j], a = triangles[i] * 3, b = triangles[i + 1] * 3, c = triangles[i + 2] * 3;
      const ay = position[a + 1], by = position[b + 1], cy = position[c + 1];
      if (Math.max(ay, by, cy) < (best ?? low) || Math.min(ay, by, cy) > high) continue;
      const ax = position[a], az = position[a + 2], bx = position[b] - ax, bz = position[b + 2] - az,
        cx = position[c] - ax, cz = position[c + 2] - az;
      const px = x - ax, pz = z - az, inverse = 1 / (bx * cz - bz * cx);
      const u = (px * cz - pz * cx) * inverse, v = (bx * pz - bz * px) * inverse;
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      const height = ay + u * (by - ay) + v * (cy - ay);
      if (height >= (best ?? low) && height <= high) best = height;
    }
    return best;
  };
}

function seedRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function coverage(palette, x, z) {
  const a = palette & 15, b = (palette >> 4) & 15, c = (palette >> 8) & 15, d = palette >> 12;
  return ((a * (1 - x) + b * x) * (1 - z) + (c * (1 - x) + d * x) * z) / 15;
}

export function detailInstances(details, groundHeight, center, radius) {
  const {originX, originZ, slots, width, depth, prototypes} = details;
  const [cx, cz] = center;
  const xmin = Math.max(0, Math.floor((cx - radius - originX) / slotSize));
  const xmax = Math.min(width - 1, Math.floor((cx + radius - originX) / slotSize));
  const zmin = Math.max(0, Math.floor((cz - radius - originZ) / slotSize));
  const zmax = Math.min(depth - 1, Math.floor((cz + radius - originZ) / slotSize));
  const buckets = prototypes.map(() => []);
  const candidates = [];

  for (let iz = zmin; iz <= zmax; iz++) {
    for (let ix = xmin; ix <= xmax; ix++) {
      const at = (iz * width + ix) * 16;
      const first = slots.getUint32(at, true), second = slots.getUint32(at + 4, true);
      const ids = [(first >>> 20) & 63, first >>> 26, second & 63, (second >>> 6) & 63];
      if (ids.every(id => id >= prototypes.length)) continue;
      const x = originX + ix * slotSize, z = originZ + iz * slotSize;
      const distance = (x + 1 - cx) ** 2 + (z + 1 - cz) ** 2;
      if (distance < radius * radius) candidates.push({at, first, second, ids, x, z, distance});
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);

  let count = 0;
  for (const {at, first, second, ids, x, z, distance} of candidates) {
    const ybase = (first & 0xfff) * 0.2 - 200, ymax = ybase + ((first >>> 12) & 255) * 0.1;
    const palettes = ids.map((_, i) => slots.getUint16(at + 8 + i * 2, true));
    const seed = Math.imul(at, 2654435761) ^ 0x12071980;
    const shade = 0.62 + (second >>> 16 & 15) * 0.025 + (second >>> 12 & 15) * 0.012;
    const density = 7, stride = distance < 38 ** 2 ? 1 : 2;
    for (let zi = 0; zi < density && count < maxInstances; zi += stride) {
      for (let xi = 0; xi < density && count < maxInstances; xi += stride) {
        const random = seedRandom(seed ^ Math.imul(zi * density + xi + 1, 0x85ebca77));
        const u = (xi + 0.16 + random() * 0.68) / density, v = (zi + 0.16 + random() * 0.68) / density;
        let chosen = -1, matches = 0;
        for (let k = 0; k < 4; k++) {
          if (ids[k] >= prototypes.length || random() >= coverage(palettes[k], u, v)) continue;
          if (random() * ++matches < 1) chosen = ids[k];
        }
        if (chosen < 0) continue;
        const px = x + u * slotSize, pz = z + v * slotSize;
        const y = groundHeight(px, pz, ybase - 0.04, ymax + 0.04);
        if (y === undefined) continue;
        const detail = prototypes[chosen];
        const scale = detail.minScale * 0.5 + random() * (detail.maxScale * 0.9 - detail.minScale * 0.5);
        const yaw = random() * Math.PI * 2;
        buckets[chosen].push(px, y, pz, scale, Math.cos(yaw), Math.sin(yaw), shade);
        count++;
      }
    }
    if (count >= maxInstances) break;
  }
  return buckets.map(items => new Float32Array(items));
}
