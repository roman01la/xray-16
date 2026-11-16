import createOgfModule from './ogf.mjs';
import {decodeDds} from './dds.mjs';
import {createRenderer} from './renderer.mjs';

const byId = id => document.getElementById(id);
const canvas = byId('model'), viewport = byId('viewport');
const maxFileBytes = 64 * 1024 * 1024;
const number = new Intl.NumberFormat();
const textureKey = name => name.replaceAll('\\', '/').replace(/\.dds$/i, '').toLowerCase();
const view = {yaw: Math.PI + 0.24, pitch: 0.08, zoom: 1, center: [0, 0, 0], radius: 1, wireframe: false, isMap: false};
let meshes = [], textures = new Map(), selectedPart = -1, frameId = 0;
let renderer, wasm;
const clipPicker = byId('clip'), clipFilter = byId('clip-filter'), timeline = byId('timeline');
const playback = {clips: [], active: null, time: 0, playing: false, previousFrame: null};

function status(message, error = false) {
  const output = byId('status');
  output.textContent = message;
  output.classList.toggle('error', error);
}

try {
  renderer = createRenderer(canvas);
  wasm = await createOgfModule();
} catch (error) {
  status(error.message, true);
  throw error;
}

function render() {
  if (frameId) return;
  frameId = requestAnimationFrame(timestamp => {
    frameId = 0;
    if (playback.playing) {
      if (playback.previousFrame !== null)
        playback.time += Math.max(0, (timestamp - playback.previousFrame) / 1000);
      playback.previousFrame = timestamp;
      const duration = playback.active.duration;
      if (playback.time >= duration) {
        if (byId('loop').checked) playback.time %= duration;
        else {
          playback.time = duration;
          setPlaying(false);
        }
      }
      updatePose();
    }
    renderer.draw(selectedPart < 0 ? meshes : [meshes[selectedPart]], view);
    if (playback.playing) render();
  });
}

function loadWasm(bytes, loader, extra) {
  const pointer = wasm._malloc(bytes.byteLength);
  if (!pointer) throw new Error('Could not allocate space for the asset.');
  try {
    wasm.HEAPU8.set(new Uint8Array(bytes), pointer);
    const result = extra ?
      loadWasm(extra, (data, size) => loader(pointer, bytes.byteLength, data, size)) :
      loader(pointer, bytes.byteLength);
    if (!result) throw new Error(wasm.UTF8ToString(wasm._ogf_error()));
    return result;
  } finally {
    wasm._free(pointer);
  }
}

function uploadAsset(name, isMap = false) {
  const next = [];
  let vertexTotal = 0, triangleTotal = 0;
  try {
    for (let part = 0; part < wasm._ogf_mesh_count(); part++) {
      const vertexCount = wasm._ogf_vertex_count(part), indexCount = wasm._ogf_index_count(part);
      const vertices = new Float32Array(wasm.HEAPU8.buffer, wasm._ogf_vertices(part), vertexCount * 8);
      const indices = new Uint16Array(wasm.HEAPU8.buffer, wasm._ogf_indices(part), indexCount);
      const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
      for (let p = 0; p < vertices.length; p += 8) {
        for (let axis = 0; axis < 3; axis++) {
          lower[axis] = Math.min(lower[axis], vertices[p + axis]);
          upper[axis] = Math.max(upper[axis], vertices[p + axis]);
        }
      }
      next.push({
        ...renderer.createMesh(vertices, indices, isMap),
        vertexCount,
        name: wasm.UTF8ToString(wasm._ogf_texture(part)),
        shader: wasm.UTF8ToString(wasm._ogf_shader(part)),
        lower, upper,
      });
      vertexTotal += vertexCount;
      triangleTotal += indexCount / 3;
    }
  } catch (error) {
    next.forEach(renderer.deleteMesh);
    throw error;
  }

  meshes.forEach(renderer.deleteMesh);
  meshes = next;
  selectedPart = -1;
  byId('model-name').textContent = name;
  byId('vertices').textContent = number.format(vertexTotal);
  byId('triangles').textContent = number.format(triangleTotal);
  byId('bones').textContent = number.format(wasm._ogf_bone_count());
  view.isMap = isMap;
  view.wireframe = !isMap && byId('wireframe').checked;
  byId('front').textContent = isMap ? 'Top' : 'Front';
  byId('hint').textContent = isMap ? 'Drag to orbit · Shift-drag to pan · Scroll to zoom' : 'Drag to orbit · Scroll to zoom';
  for (const id of ['stats', 'view-tools', 'hint']) byId(id).hidden = false;
  for (const id of ['materials', 'bone-stat', 'wireframe-tool']) byId(id).hidden = isMap;
  byId('empty').hidden = true;
  canvas.classList.add('loaded');
  resetView();
}

function refreshMaterials() {
  const parts = byId('parts');
  parts.replaceChildren();
  let missing = 0;
  meshes.forEach((mesh, index) => {
    const mapped = textures.get(textureKey(mesh.name));
    mesh.texture = mapped?.handle;
    if (mesh.name && !mapped) missing++;
    const row = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'part';
    button.type = 'button';
    button.setAttribute('aria-pressed', String(index === selectedPart));
    button.title = 'Show this mesh part by itself';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    if (mapped) swatch.style.backgroundImage = 'url(' + mapped.preview + ')';
    const details = document.createElement('span');
    const label = document.createElement('strong');
    label.textContent = mesh.name.replaceAll('\\', '/') || 'Mesh part ' + (index + 1);
    const shader = document.createElement('small');
    shader.textContent = mesh.name && !mapped ? 'Texture missing' :
      mesh.shader.replaceAll('\\', '/') || 'Default material';
    details.append(label, shader);
    button.append(swatch, details);
    row.append(button);
    parts.append(row);
    button.addEventListener('click', () => {
      selectedPart = selectedPart === index ? -1 : index;
      for (const [part, item] of [...parts.querySelectorAll('button')].entries())
        item.setAttribute('aria-pressed', String(part === selectedPart));
      frameModel();
    });
  });
  if (meshes.length)
    status(missing ? missing + ' texture' + (missing === 1 ? '' : 's') + ' unavailable in this game archive.' :
      'OGF v4 · ' + (playback.active ? playback.active.name : 'Bind pose'));
  render();
}

function thumbnail({pixels, width, height}) {
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), width, height), 0, 0);
  const preview = document.createElement('canvas');
  preview.width = preview.height = 56;
  preview.getContext('2d').drawImage(source, 0, 0, 56, 56);
  return preview.toDataURL();
}

function updateMeshVertices(posed) {
  const getVertices = posed ? wasm._ogf_posed_vertices : wasm._ogf_vertices;
  meshes.forEach((mesh, index) => {
    renderer.updateMesh(mesh, new Float32Array(wasm.HEAPU8.buffer, getVertices(index), mesh.vertexCount * 8));
  });
}

function updatePose() {
  if (!playback.active) return;
  if (wasm._ogf_pose(playback.time, byId('loop').checked, byId('in-place').checked))
    updateMeshVertices(true);
  timeline.value = playback.time;
  byId('clip-time').textContent = playback.time.toFixed(2) + ' / ' + playback.active.duration.toFixed(2) + ' s';
}

function setPlaying(playing) {
  playback.playing = playing;
  playback.previousFrame = null;
  byId('play').textContent = playing ? 'Pause' : 'Play';
  if (playing) render();
}

function resetPlayback() {
  setPlaying(false);
  playback.clips = [];
  playback.active = null;
  playback.time = 0;
  playback.summary = '';
  clipFilter.value = '';
  byId('playback').hidden = true;
  byId('animation-picker').hidden = true;
  byId('animations').hidden = true;
}

function listClips() {
  const query = clipFilter.value.trim().toLowerCase();
  clipPicker.replaceChildren(new Option('Bind pose', ''));
  for (const clip of playback.clips) {
    if (clip === playback.active || clip.label.toLowerCase().includes(query))
      clipPicker.add(new Option(clip.label, clip.id));
  }
  clipPicker.value = playback.active?.id ?? '';
}

function selectClip() {
  setPlaying(false);
  const clip = playback.clips.find(item => item.id === Number(clipPicker.value));
  if (!clipPicker.value || !clip) {
    playback.active = null;
    byId('playback').hidden = true;
    updateMeshVertices(false);
    refreshMaterials();
    byId('animation-status').textContent = playback.summary;
    return;
  }
  if (!wasm._ogf_select_clip(clip.id)) {
    byId('animation-status').textContent = wasm.UTF8ToString(wasm._ogf_error());
    clipPicker.value = playback.active?.id ?? '';
    return;
  }
  playback.active = clip;
  const warning = wasm.UTF8ToString(wasm._ogf_error());
  byId('animation-status').textContent = warning ? playback.summary + ' ' + warning : playback.summary;
  playback.time = 0;
  timeline.max = clip.duration;
  byId('loop').checked = clip.loops;
  byId('playback').hidden = false;
  updatePose();
  refreshMaterials();
  setPlaying(true);
}

clipPicker.addEventListener('change', selectClip);
clipFilter.addEventListener('input', listClips);
byId('play').addEventListener('click', () => {
  if (!playback.playing && playback.time >= playback.active.duration) playback.time = 0;
  setPlaying(!playback.playing);
});
timeline.addEventListener('input', () => {
  setPlaying(false);
  playback.time = Number(timeline.value);
  updatePose();
  render();
});
for (const id of ['loop', 'in-place']) {
  byId(id).addEventListener('change', () => {
    updatePose();
    render();
  });
}

function frameModel() {
  if (!meshes.length) return;
  const visible = selectedPart < 0 ? meshes : [meshes[selectedPart]];
  const lower = [0, 1, 2].map(axis => Math.min(...visible.map(mesh => mesh.lower[axis])));
  const upper = [0, 1, 2].map(axis => Math.max(...visible.map(mesh => mesh.upper[axis])));
  view.center = lower.map((min, axis) => (min + upper[axis]) / 2);
  view.radius = Math.max(0.001, Math.hypot(...lower.map((min, axis) => (upper[axis] - min) / 2)));
  view.zoom = 1;
  render();
}
function resetView(front = false) {
  view.yaw = front ? Math.PI : Math.PI + 0.24;
  view.pitch = view.isMap ? (front ? Math.PI / 2 : 1.05) : (front ? 0 : 0.08);
  frameModel();
}
function orbit(dx, dy) {
  view.yaw += dx * 0.008;
  view.pitch = Math.max(-1.55, Math.min(1.55, view.pitch + dy * 0.008));
  render();
}
function zoom(amount) {
  view.zoom = Math.max(0.35, Math.min(view.isMap ? 60 : 12, view.zoom * Math.exp(amount)));
  render();
}

let pointer;
canvas.addEventListener('pointerdown', e => {
  if (!meshes.length || !e.isPrimary || e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  pointer = [e.clientX, e.clientY];
});
canvas.addEventListener('pointermove', e => {
  if (!pointer || !canvas.hasPointerCapture(e.pointerId)) return;
  if (view.isMap && e.shiftKey) {
    const units = 2 * view.radius / (0.96 * view.zoom * Math.min(canvas.clientWidth, canvas.clientHeight));
    const dx = (pointer[0] - e.clientX) * units, dy = (e.clientY - pointer[1]) * units;
    const sx = Math.sin(view.yaw), cx = Math.cos(view.yaw), sy = Math.sin(view.pitch), cy = Math.cos(view.pitch);
    view.center[0] += dx * cx - dy * sx * sy;
    view.center[1] += dy * cy;
    view.center[2] -= dx * sx + dy * cx * sy;
    render();
  } else {
    orbit(pointer[0] - e.clientX, e.clientY - pointer[1]);
  }
  pointer = [e.clientX, e.clientY];
});
canvas.addEventListener('lostpointercapture', () => { pointer = undefined; });
canvas.addEventListener('wheel', e => {
  if (!meshes.length) return;
  e.preventDefault();
  const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
  zoom(-e.deltaY * factor * 0.001);
}, {passive: false});
canvas.addEventListener('keydown', e => {
  if (!meshes.length) return;
  switch (e.key) {
    case 'ArrowLeft': orbit(-12, 0); break;
    case 'ArrowRight': orbit(12, 0); break;
    case 'ArrowUp': orbit(0, 12); break;
    case 'ArrowDown': orbit(0, -12); break;
    case '+': case '=': zoom(0.12); break;
    case '-': zoom(-0.12); break;
    default: return;
  }
  e.preventDefault();
});
byId('front').addEventListener('click', () => resetView(true));
byId('frame').addEventListener('click', () => resetView());
byId('wireframe').addEventListener('change', e => {
  view.wireframe = e.target.checked;
  render();
});
new ResizeObserver(render).observe(viewport);

const games = byId('game'), search = byId('search'), catalog = byId('catalog');
const catalogScroll = byId('catalog-scroll'), catalogEnd = byId('catalog-end');
const pageSize = 80;
const startingUrl = new URL(location.href);
const mapId = path => path.split('/')[1];
const mapNames = {
  agr_underground: 'Agroprom Underground', brainlab: 'X16 Lab', bunker: 'X10 Lab',
  control_monolith: 'Monolith Control Center', darkvalley: 'Dark Valley', escape: 'Cordon',
  hospital: 'Abandoned Hospital', labx18: 'X18 Lab', labx8: 'X8 Lab',
  marsh: 'Great Swamps', military: 'Army Warehouses', radar: 'Radar',
  sarcofag: 'Sarcophagus', stancia: 'Chernobyl NPP', stancia_2: 'Chernobyl NPP North',
};
let browsingMaps = startingUrl.searchParams.has('map') || startingUrl.searchParams.get('view') === 'maps';
const sakharov = 'meshes/actors/ucheniy/ucheniy_2.ogf';
const expandedFolders = new Set();
let paths = [], selectedPath, catalogRequest, modelRequest;
let catalogView = 'list', flatMatches = [], renderedMatches = 0;

function displayName(path) {
  if (browsingMaps) {
    const name = mapId(path).replace(/^l\d+[a-z]?_/, '');
    return mapNames[name] ?? name.replaceAll('_', ' ').replace(/\b\w/g, character => character.toUpperCase());
  }
  return games.value === 'soc' && path === sakharov ? 'Professor Sakharov' : path.split('/').pop();
}

function modelItem(path, showPath) {
  const item = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'catalog-item';
  button.dataset.path = path;
  button.title = path;
  if (path === selectedPath) button.setAttribute('aria-current', 'true');
  const title = document.createElement('strong');
  title.textContent = displayName(path);
  button.append(title);
  if (showPath) {
    const subtitle = document.createElement('small');
    subtitle.textContent = path;
    button.append(subtitle);
  }
  item.append(button);
  return item;
}

function appendCatalogPage() {
  if (catalogView !== 'list' || renderedMatches >= flatMatches.length) return;
  catalogObserver.unobserve(catalogEnd);
  const items = document.createDocumentFragment();
  const end = Math.min(renderedMatches + pageSize, flatMatches.length);
  for (const path of flatMatches.slice(renderedMatches, end)) items.append(modelItem(path, true));
  renderedMatches = end;
  catalog.append(items);
  catalogEnd.hidden = renderedMatches === flatMatches.length;
  if (!catalogEnd.hidden) catalogObserver.observe(catalogEnd);
}

const catalogObserver = new IntersectionObserver(entries => {
  if (!catalogEnd.hidden && entries.some(entry => entry.isIntersecting)) appendCatalogPage();
}, {root: catalogScroll, rootMargin: '0px 0px 180px'});

function folderTree(matches) {
  const root = {folders: new Map(), models: []};
  for (const path of matches) {
    const parts = path.split('/');
    parts.pop();
    let folder = root;
    for (const part of parts) {
      if (!folder.folders.has(part)) folder.folders.set(part, {folders: new Map(), models: []});
      folder = folder.folders.get(part);
    }
    folder.models.push(path);
  }
  return root;
}

function folderItems(folder, prefix, searching) {
  const items = document.createDocumentFragment();
  for (const [name, child] of folder.folders) {
    const path = prefix + name;
    const item = document.createElement('li');
    const details = document.createElement('details');
    details.className = 'catalog-folder';
    const summary = document.createElement('summary');
    summary.textContent = name;
    details.append(summary);
    item.append(details);
    items.append(item);
    const showChildren = () => {
      if (details.children.length > 1) return;
      const list = document.createElement('ul');
      list.append(folderItems(child, path + '/', searching));
      details.append(list);
    };
    details.open = searching || expandedFolders.has(path);
    if (details.open) showChildren();
    details.addEventListener('toggle', () => {
      if (details.open) showChildren();
      if (searching || !details.isConnected) return;
      if (details.open) expandedFolders.add(path);
      else expandedFolders.delete(path);
    });
  }
  for (const path of folder.models) items.append(modelItem(path, false));
  return items;
}

function renderCatalog() {
  const query = search.value.trim().toLowerCase();
  const terms = query.split(/\s+/);
  const matches = paths.filter(path => terms.every(term => (path + ' ' + displayName(path)).toLowerCase().includes(term)));
  const type = browsingMaps ? ' maps' : ' meshes';
  byId('results').textContent = matches.length === paths.length ? number.format(paths.length) + type :
    number.format(matches.length) + ' of ' + number.format(paths.length) + type;
  catalogObserver.unobserve(catalogEnd);
  catalogEnd.hidden = true;
  catalog.replaceChildren();
  catalogScroll.scrollTop = 0;
  if (!browsingMaps && catalogView === 'folders') {
    catalog.append(folderItems(folderTree(matches), '', Boolean(query)));
    return;
  }
  flatMatches = matches;
  if (!query && selectedPath && matches.includes(selectedPath) && !matches.slice(0, pageSize).includes(selectedPath))
    flatMatches = [selectedPath, ...matches.filter(path => path !== selectedPath)];
  renderedMatches = 0;
  appendCatalogPage();
}

function setCatalogView(view) {
  if (view === catalogView) return;
  catalogView = view;
  byId('list-view').setAttribute('aria-pressed', String(view === 'list'));
  byId('folder-view').setAttribute('aria-pressed', String(view === 'folders'));
  if (view === 'folders' && selectedPath) {
    const parts = selectedPath.split('/');
    for (let depth = 1; depth < parts.length; depth++) expandedFolders.add(parts.slice(0, depth).join('/'));
  }
  renderCatalog();
  if (view === 'folders')
    catalog.querySelector('[aria-current="true"]')?.scrollIntoView({block: 'nearest'});
}

function setUrl(path) {
  const url = new URL(location.href);
  url.searchParams.set('game', games.value);
  url.searchParams.delete('model');
  url.searchParams.delete('map');
  if (browsingMaps) {
    url.searchParams.set('view', 'maps');
    if (path) url.searchParams.set('map', mapId(path));
  } else {
    url.searchParams.delete('view');
    if (path) url.searchParams.set('model', path);
  }
  history.replaceState(null, '', url);
}

function texturePath(name) {
  const path = name.replaceAll('\\', '/').toLowerCase();
  return 'textures/' + path.replace(/\.dds$/, '') + '.dds';
}

function assetUrl(game, path) {
  return './api/asset?' + new URLSearchParams({game, path});
}

async function loadAnimations(game, model, signal) {
  byId('animations').hidden = false;
  const status = byId('animation-status');
  status.textContent = 'Loading animations…';
  const problems = [];
  const error = wasm.UTF8ToString(wasm._ogf_animation_error());
  if (error) problems.push(error);
  const paths = Array(wasm._ogf_clip_count()).fill('Embedded');
  const refs = Array.from({length: wasm._ogf_reference_count()}, (_, i) => wasm.UTF8ToString(wasm._ogf_reference(i)));
  if (refs.length) {
    try {
      const query = new URLSearchParams({game, model});
      refs.forEach(reference => query.append('ref', reference));
      const response = await fetch('./api/motions?' + query, {signal});
      if (!response.ok) throw new Error('Could not resolve animation references.');
      const sources = await response.json();
      const files = new Set();
      for (const {reference, paths} of sources) {
        if (!paths.length) problems.push('Missing ' + reference);
        for (const path of paths) files.add(path);
      }
      for (const path of files) {
        try {
          const file = await fetch(assetUrl(game, path), {signal});
          if (!file.ok) throw new Error('Could not read OMF');
          const bytes = await file.arrayBuffer();
          if (signal.aborted) return;
          const before = wasm._ogf_clip_count();
          loadWasm(bytes, wasm._ogf_add_motions);
          for (let i = before; i < wasm._ogf_clip_count(); i++) paths[i] = path.split('/').pop();
        } catch (error) {
          if (signal.aborted) return;
          problems.push(path + ' — ' + error.message);
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      problems.push(error.message);
    }
  }

  if (signal.aborted) return;
  const names = new Map();
  playback.clips = paths.map((source, id) => {
    const name = wasm.UTF8ToString(wasm._ogf_clip_name(id));
    names.set(name, (names.get(name) ?? 0) + 1);
    return {id, name, source, duration: wasm._ogf_clip_duration(id), loops: wasm._ogf_clip_loops(id)};
  });
  for (const clip of playback.clips)
    clip.label = names.get(clip.name) > 1 ? clip.name + ' (' + clip.source + ')' : clip.name;
  playback.clips.sort((a, b) => a.label.localeCompare(b.label));
  const count = playback.clips.length;
  const summary = count ? number.format(count) + (count === 1 ? ' clip' : ' clips') : 'No clips found.';
  playback.summary = problems.length ? summary + ' ' + problems.join(' · ') : summary;
  status.textContent = playback.summary;
  byId('animation-picker').hidden = count === 0;
  listClips();
}

function dropTextures() {
  for (const entry of textures.values()) renderer.deleteTexture(entry.handle);
  textures.clear();
}

async function assetBytes(game, path, signal) {
  const response = await fetch(assetUrl(game, path), {signal});
  if (!response.ok) throw new Error('Could not read ' + path + ' from the game archive.');
  return response.arrayBuffer();
}

// The R2 terrain shader combines these default detail layers with an RGBA mask.
const terrainLayers = ['grass', 'asphalt', 'earth', 'yantar'].map(name => 'detail/detail_grnd_' + name);

function blendTerrain(mask, layers) {
  const {width, height} = mask;
  const pixels = new Uint8Array(mask.pixels.length);
  const repeats = 16;
  const color = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const weight = mask.pixels[i] + mask.pixels[i + 1] + mask.pixels[i + 2] + mask.pixels[i + 3];
      color.fill(0);
      for (let layer = 0; layer < 4; layer++) {
        const detail = layers[layer];
        const dx = Math.floor(x * repeats * detail.width / width) % detail.width;
        const dy = Math.floor(y * repeats * detail.height / height) % detail.height;
        const j = (dy * detail.width + dx) * 4;
        const blend = weight ? mask.pixels[i + layer] / weight : layer === 2 ? 1 : 0;
        for (let c = 0; c < 3; c++) color[c] += detail.pixels[j + c] * blend;
      }
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(color[c]);
      pixels[i + 3] = 255;
    }
  }
  return {width, height, pixels};
}

async function loadMapTextures(game, signal) {
  const surfaces = new Map();
  for (const mesh of meshes) {
    if (!mesh.name) continue;
    const key = textureKey(mesh.name);
    if (!surfaces.has(key)) surfaces.set(key, []);
    surfaces.get(key).push(mesh);
  }
  const pending = surfaces.values();
  let missing = 0, details;
  const fetchTexture = name => assetBytes(game, texturePath(name), signal);
  const decodeTexture = async name => decodeDds(await fetchTexture(name), renderer.maxTextureSize);

  async function mapTexture(name) {
    try {
      const bytes = await fetchTexture(name);
      if (!signal.aborted) return renderer.mapTexture(bytes);
    } catch (error) {
      if (!textureKey(name).startsWith('terrain/terrain_') || signal.aborted) throw error;
      const mask = await decodeTexture(name + '_mask');
      details ??= Promise.all(terrainLayers.map(decodeTexture));
      const layers = await details;
      if (!signal.aborted) return renderer.texture(blendTerrain(mask, layers));
    }
  }

  async function load() {
    for (const parts of pending) {
      if (signal.aborted) return;
      const name = parts[0].name;
      try {
        const handle = await mapTexture(name);
        if (signal.aborted) {
          if (handle) renderer.deleteTexture(handle);
          return;
        }
        textures.set(textureKey(name), {handle});
        for (const part of parts) part.texture = handle;
      } catch {
        if (signal.aborted) return;
        missing++;
      }
    }
  }
  await Promise.all(Array.from({length: 4}, load));
  if (signal.aborted) return;
  status(missing ? 'Static geometry · ' + number.format(missing) + ' textures unavailable' : 'Static geometry');
  render();
}

async function selectAsset(path) {
  modelRequest?.abort();
  if (playback.active) updateMeshVertices(false);
  resetPlayback();
  render();
  const {signal} = modelRequest = new AbortController();
  const game = games.value, isMap = browsingMaps;
  selectedPath = path;
  setUrl(path);
  for (const button of catalog.querySelectorAll('button')) {
    if (button.dataset.path === path) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  status('Loading ' + displayName(path) + '…');
  try {
    const bytes = await assetBytes(game, path, signal);
    if (signal.aborted) return;
    if (isMap) {
      const geometry = await assetBytes(game, path + '.geom', signal);
      if (signal.aborted) return;
      loadWasm(bytes, wasm._ogf_load_level, geometry);
      try {
        uploadAsset(displayName(path), true);
      } finally {
        wasm._ogf_release_level();
      }
      dropTextures();
      status('Loading map textures…');
      await loadMapTextures(game, signal);
      return;
    }
    if (!bytes.byteLength || bytes.byteLength > maxFileBytes) throw new Error('The model exceeds the viewer’s 64 MiB limit.');
    loadWasm(bytes, wasm._ogf_load);
    uploadAsset(path.split('/').pop());
    dropTextures();
    refreshMaterials();

    const animations = loadAnimations(game, path, signal);
    const missing = [];
    const names = new Set(meshes.map(mesh => mesh.name).filter(Boolean));
    for (const name of names) {
      try {
        const result = await fetch(assetUrl(game, texturePath(name)), {signal});
        if (!result.ok) throw new Error('Texture not found');
        const buffer = await result.arrayBuffer();
        if (signal.aborted) return;
        const image = decodeDds(buffer);
        textures.set(textureKey(name), {handle: renderer.texture(image), preview: thumbnail(image)});
      } catch (error) {
        if (signal.aborted) return;
        missing.push(name);
      }
    }
    refreshMaterials();
    if (missing.length) status('Missing or unsupported textures: ' + missing.join(', ') + '.', true);
    await animations;
  } catch (error) {
    if (!signal.aborted) status(error.message, true);
  }
}

async function selectGame(initial = false) {
  catalogRequest?.abort();
  modelRequest?.abort();
  resetPlayback();
  const {signal} = catalogRequest = new AbortController();
  const game = games.value;
  paths = [];
  flatMatches = [];
  renderedMatches = 0;
  expandedFolders.clear();
  search.value = '';
  selectedPath = undefined;
  selectedPart = -1;
  meshes.forEach(renderer.deleteMesh);
  meshes = [];
  dropTextures();
  catalog.replaceChildren();
  catalogObserver.unobserve(catalogEnd);
  catalogEnd.hidden = true;
  byId('empty').hidden = false;
  const kind = browsingMaps ? 'map' : 'mesh';
  byId('asset-kind').textContent = browsingMaps ? 'Map' : 'Model';
  byId('model-name').textContent = browsingMaps ? 'No map open' : 'No model open';
  byId('empty').textContent = 'Select a ' + kind + ' from the catalog.';
  byId('search-label').textContent = 'Find a ' + kind;
  catalog.setAttribute('aria-label', browsingMaps ? 'Maps' : 'Meshes');
  byId('mesh-views').hidden = browsingMaps;
  byId('mesh-catalog').setAttribute('aria-pressed', String(!browsingMaps));
  byId('map-catalog').setAttribute('aria-pressed', String(browsingMaps));
  canvas.classList.remove('loaded');
  for (const id of ['stats', 'materials', 'view-tools', 'hint']) byId(id).hidden = true;
  status('');
  byId('results').textContent = 'Loading catalog…';
  render();
  setUrl();
  try {
    const endpoint = browsingMaps ? './api/maps?' : './api/catalog?';
    const response = await fetch(endpoint + new URLSearchParams({game}), {signal});
    if (!response.ok) throw new Error('The game catalog could not be loaded.');
    const catalogPaths = await response.json();
    if (signal.aborted) return;
    paths = catalogPaths;
    const first = initial && browsingMaps ? paths.find(path => mapId(path) === startingUrl.searchParams.get('map')) :
      initial ? startingUrl.searchParams.get('model') ?? (game === 'soc' ? sakharov : null) : null;
    if (first && paths.includes(first)) selectedPath = first;
    renderCatalog();
    if (selectedPath) await selectAsset(selectedPath);
  } catch (error) {
    if (!signal.aborted) byId('results').textContent = error.message;
  }
}

catalog.addEventListener('click', event => {
  const button = event.target.closest('button[data-path]');
  if (button) void selectAsset(button.dataset.path);
});
search.addEventListener('input', renderCatalog);
byId('list-view').addEventListener('click', () => setCatalogView('list'));
byId('folder-view').addEventListener('click', () => setCatalogView('folders'));
for (const [id, maps] of [['mesh-catalog', false], ['map-catalog', true]]) {
  byId(id).addEventListener('click', () => {
    if (browsingMaps === maps) return;
    browsingMaps = maps;
    void selectGame();
  });
}
games.addEventListener('change', () => { void selectGame(); });

try {
  const response = await fetch('./api/games');
  if (!response.ok) throw new Error('Start the OGF viewer server to browse game archives.');
  const installed = await response.json();
  for (const {id, name} of installed) games.add(new Option(name, id));
  const requested = startingUrl.searchParams.get('game');
  if (installed.some(game => game.id === requested)) games.value = requested;
  await selectGame(true);
} catch (error) {
  byId('results').textContent = error.message;
}
