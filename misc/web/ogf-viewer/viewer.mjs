import createOgfModule from './ogf.mjs';
import {decodeDds} from './dds.mjs';
import {createRenderer} from './renderer.mjs';
import {createGrassViewer} from './grass-viewer.mjs';
import {createEnvironmentPlayer} from './environment-runtime.mjs';
import {createAssetSource} from './viewer-source.mjs';
import {readParticleLibrary} from './particle-library.mjs';
import {createParticleScene, particleDefinitions} from './particle-runtime.mjs';

const byId = id => document.getElementById(id);
const canvas = byId('model'), viewport = byId('viewport');
const maxFileBytes = 64 * 1024 * 1024;
const number = new Intl.NumberFormat();
const textureKey = name => name.replaceAll('\\', '/').replace(/\.dds$/i, '').toLowerCase();
const view = {yaw: Math.PI + 0.24, pitch: 0.08, zoom: 1, center: [0, 0, 0], radius: 1, wireframe: false, isMap: false, cutaway: ''};
let meshes = [], textures = new Map(), selectedPart = -1, frameId = 0;
let renderer, wasm, source;
const clipPicker = byId('clip'), clipFilter = byId('clip-filter'), timeline = byId('timeline');
let weather, grass;
const grassEnabled = byId('grass-enabled');
const weatherPanel = byId('weather'), weatherPreset = byId('weather-preset'), weatherTime = byId('weather-time');
const weatherEnabled = byId('weather-enabled'), weatherPlay = byId('weather-play'), weatherAudio = byId('weather-audio');
const effectLocation = byId('effect-location'), effectToggle = byId('effects-enabled');
const libraries = new Map(), placementsByGame = new Map();
let particleScene, effectsLight, mapEffects, mapBurst, sceneLibrary, lastMapDraw = 0, renderedParticles;
const particleTextures = new Map(), particleHandles = new Map();

const playback = {clips: [], active: null, time: 0, playing: false, previousFrame: null};

function status(message, error = false) {
  const output = byId('status');
  output.textContent = message;
  output.classList.toggle('error', error);
}

try {
  renderer = createRenderer(canvas);
  wasm = await createOgfModule();
  source = createAssetSource(wasm);
} catch (error) {
  status(error.message, true);
  throw error;
}

let weatherFrame;

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
    const animateEffects = particleScene && effectToggle.checked && !view.wireframe &&
      (!view.isMap || view.zoom >= 3 || mapBurst);
    const animateWeather = view.isMap && weather?.animating;
    if ((!animateEffects && !animateWeather) || !view.isMap || timestamp - lastMapDraw >= 33) {
      if (animateEffects) {
        particleScene.advance(timestamp, view);
        mapBurst?.advance(timestamp, view);
        renderedParticles = particleScene.batches();
        if (mapBurst) {
          const burst = mapBurst.batches();
          for (const [def, data] of burst.buffers) {
            const base = renderedParticles.buffers.get(def);
            if (base) base.push(...data);
            else renderedParticles.buffers.set(def, data);
          }
          if (mapBurst.finished) mapBurst = undefined;
        }
        renderedParticles.textures = particleTextures;
      } else renderedParticles = undefined;
      weatherFrame = view.isMap ? weather?.frame(timestamp, view.center) : undefined;
      if (weatherFrame && weatherPlay.checked) updateWeatherClock();
      renderer.draw(selectedPart < 0 ? meshes : [meshes[selectedPart]], view, renderedParticles,
        effectToggle.checked ? effectsLight : undefined, weatherFrame,
        grassEnabled.checked ? grass?.forView(view) : undefined);
      lastMapDraw = timestamp;
    }
    if (playback.playing || animateEffects || animateWeather) render();
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

function uploadWasmMeshes(isMap, position) {
  const next = [];
  let vertexTotal = 0, triangleTotal = 0;
  try {
    for (let part = 0; part < wasm._ogf_mesh_count(); part++) {
      const vertexCount = wasm._ogf_vertex_count(part), indexCount = wasm._ogf_index_count(part);
      let vertices = new Float32Array(wasm.HEAPU8.buffer, wasm._ogf_vertices(part), vertexCount * 8);
      if (position) {
        vertices = vertices.slice();
        for (let p = 0; p < vertices.length; p += 8)
          for (let axis = 0; axis < 3; axis++) vertices[p + axis] += position[axis];
      }
      const indices = new Uint16Array(wasm.HEAPU8.buffer, wasm._ogf_indices(part), indexCount);
      const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
      for (let p = 0; p < vertices.length; p += 8) {
        for (let axis = 0; axis < 3; axis++) {
          lower[axis] = Math.min(lower[axis], vertices[p + axis]);
          upper[axis] = Math.max(upper[axis], vertices[p + axis]);
        }
      }
      const shader = wasm.UTF8ToString(wasm._ogf_shader(part));
      const weights = isMap ? wasm._ogf_wind_weights(part) : 0;
      const wind = weights ? new Float32Array(wasm.HEAPU8.buffer, weights, vertexCount) : null;
      next.push({
        ...renderer.createMesh(vertices, indices, isMap, wind),
        vertexCount,
        name: wasm.UTF8ToString(wasm._ogf_texture(part)),
        shader, water: isMap && /^(?:effects[\\/])?water/i.test(shader), distortion: /[\\/]xdistort/i.test(shader),
        lower, upper,
      });
      vertexTotal += vertexCount;
      triangleTotal += indexCount / 3;
    }
  } catch (error) {
    next.forEach(renderer.deleteMesh);
    throw error;
  }

  return {next, vertexTotal, triangleTotal};
}

function uploadAsset(name, isMap = false) {
  const {next, vertexTotal, triangleTotal} = uploadWasmMeshes(isMap);
  meshes.forEach(renderer.deleteMesh);
  meshes = next;
  selectedPart = -1;
  byId('model-name').textContent = name;
  byId('vertices').textContent = number.format(vertexTotal);
  byId('triangles').textContent = number.format(triangleTotal);
  byId('bones').textContent = number.format(wasm._ogf_bone_count());
  view.isMap = isMap;
  view.cutaway = isMap ? byId('cutaway').value : '';
  byId('cutaway').hidden = !isMap;
  view.wireframe = !isMap && byId('wireframe').checked;
  byId('front').textContent = isMap ? 'Top' : 'Front';
  byId('hint').textContent = isMap ? 'Drag to orbit · Middle-drag or Shift-drag to pan · Scroll to zoom' : 'Drag to orbit · Middle-drag to pan · Scroll to zoom';
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
  if (!meshes.length) {
    if (catalogMode === 'effects') {
      view.center = [0, 0.5, 0];
      view.radius = 6;
      view.zoom = 1;
      render();
    }
    return;
  }
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
function primeOrbit() {
  if (!view.isMap || !meshes.length) return;
  const target = renderer.orbitTarget(meshes, view, weatherFrame);
  if (target) view.center = target;
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
  if ((!meshes.length && !particleScene) || !e.isPrimary || (e.button !== 0 && e.button !== 1)) return;
  if (e.button === 1) e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  pointer = {x: e.clientX, y: e.clientY, button: e.button, orbiting: false};
});
canvas.addEventListener('pointermove', e => {
  if (!pointer || !canvas.hasPointerCapture(e.pointerId)) return;
  const dx = pointer.x - e.clientX, dy = e.clientY - pointer.y;
  if (pointer.button === 1 || (view.isMap && e.shiftKey)) {
    const units = 2 * view.radius / (0.96 * view.zoom * Math.min(canvas.clientWidth, canvas.clientHeight));
    const sx = Math.sin(view.yaw), cx = Math.cos(view.yaw), sy = Math.sin(view.pitch), cy = Math.cos(view.pitch);
    view.center[0] += (dx * cx - dy * sx * sy) * units;
    view.center[1] += dy * cy * units;
    view.center[2] -= (dx * sx + dy * cx * sy) * units;
    pointer.orbiting = false;
    render();
  } else if (dx || dy) {
    if (!pointer.orbiting) {
      primeOrbit();
      pointer.orbiting = true;
    }
    orbit(dx, dy);
  }
  pointer.x = e.clientX;
  pointer.y = e.clientY;
});
canvas.addEventListener('lostpointercapture', () => { pointer = undefined; });
canvas.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
canvas.addEventListener('wheel', e => {
  if (!meshes.length && !particleScene) return;
  e.preventDefault();
  const factor = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
  zoom(-e.deltaY * factor * 0.001);
}, {passive: false});
canvas.addEventListener('keydown', e => {
  if (!meshes.length && !particleScene) return;
  if (!e.repeat && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) primeOrbit();
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
byId('cutaway').addEventListener('change', e => {
  view.cutaway = view.isMap ? e.target.value : '';
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
let catalogMode = startingUrl.searchParams.has('effect') || startingUrl.searchParams.get('view') === 'effects' ? 'effects' :
  startingUrl.searchParams.has('map') || startingUrl.searchParams.get('view') === 'maps' ? 'maps' : 'meshes';
const sakharov = 'meshes/actors/ucheniy/ucheniy_2.ogf';
const expandedFolders = new Set();
let paths = [], selectedPath, catalogRequest, modelRequest;
let catalogView = 'list', flatMatches = [], renderedMatches = 0;

function displayName(path) {
  if (catalogMode === 'effects') return path.split('\\').pop();
  if (catalogMode === 'maps') {
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
  const type = ' ' + catalogMode;
  byId('results').textContent = matches.length === paths.length ? number.format(paths.length) + type :
    number.format(matches.length) + ' of ' + number.format(paths.length) + type;
  catalogObserver.unobserve(catalogEnd);
  catalogEnd.hidden = true;
  catalog.replaceChildren();
  catalogScroll.scrollTop = 0;
  if (catalogMode === 'meshes' && catalogView === 'folders') {
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
  url.searchParams.delete('effect');
  if (catalogMode === 'effects') {
    url.searchParams.set('view', 'effects');
    if (path) url.searchParams.set('effect', path);
  } else if (catalogMode === 'maps') {
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
  return 'textures/' + path.replace(/\.(?:dds|tga|bmp|png)$/, '') + '.dds';
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
      const sources = await source.motions(game, model, refs, signal);
      const files = new Set();
      for (const {reference, paths} of sources) {
        if (!paths.length) problems.push('Missing ' + reference);
        for (const path of paths) files.add(path);
      }
      for (const path of files) {
        try {
          const bytes = await source.asset(game, path, signal);
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

// Defaults from CBlender_BmmD, used for maps without material metadata.
const defaultTerrainLayers = ['grass', 'asphalt', 'earth', 'yantar'].map(name => 'detail/detail_grnd_' + name);

async function loadMapTextures(game, level, signal, terrainMaterials, levelTextures) {
  const localTextures = levelTextures ? new Set(levelTextures[level]) : undefined;
  function localPath(shared) {
    const relative = shared.slice('textures/'.length);
    // Older hosted indexes may omit the level texture list.
    if (localTextures?.has(relative) ?? relative.startsWith('terrain/'))
      return 'levels/' + level + '/' + relative;
  }
  const surfaces = new Map();
  for (const mesh of meshes) {
    if (!mesh.name) continue;
    const key = mesh.water && /waterryaska$/i.test(mesh.shader) ? 'water/water_ryaska1' : textureKey(mesh.name);
    if (!surfaces.has(key)) surfaces.set(key, []);
    surfaces.get(key).push(mesh);
  }
  const pending = source.orderTextures(game, [...surfaces], ([name]) => {
    const shared = texturePath(name);
    return localPath(shared) ?? shared;
  }).values();
  const requests = new Map();
  let missing = 0;
  function textureFor(name, terrain = false) {
    const shared = texturePath(name);
    if (!requests.has(shared)) {
      const local = localPath(shared);
      const request = (async () => {
        const bytes = local
          ? await source.asset(game, local, signal).catch(() => {
            signal.throwIfAborted();
            return source.asset(game, shared, signal);
          })
          : await source.asset(game, shared, signal);
        signal.throwIfAborted();
        const handle = terrain ? renderer.terrainTexture(bytes) : renderer.mapTexture(bytes);
        textures.set(shared, {handle});
        return handle;
      })().catch(() => null);
      requests.set(shared, request);
    }
    return requests.get(shared);
  }

  const waterMeshes = meshes.filter(mesh => mesh.water);
  const waterNormals = waterMeshes.length ? textureFor('water/water_normal').then(handle => {
    if (!signal.aborted) for (const mesh of waterMeshes) mesh.waterNormal = handle;
  }) : undefined;

  async function load() {
    for (const [name, parts] of pending) {
      if (signal.aborted) return;
      const terrain = name.startsWith('terrain/terrain_');
      const base = textureFor(name, terrain);
      if (!terrain) {
        const handle = await base;
        if (signal.aborted) return;
        if (!handle) missing++;
        for (const part of parts) part.texture = handle;
        continue;
      }

      const groups = new Map();
      for (const part of parts) {
        const shader = textureKey(part.shader);
        if (!groups.has(shader)) groups.set(shader, []);
        groups.get(shader).push(part);
      }
      const [handle, mask] = await Promise.all([base, textureFor(name + '_mask', true)]);
      if (signal.aborted) return;
      const metadata = terrainMaterials?.textures[name];
      const defaultDetail = metadata?.detail ?? defaultTerrainLayers[2];
      let hasDetail = false;
      for (const [shader, group] of groups) {
        const configured = terrainMaterials?.shaders[shader];
        const layerNames = mask ? configured ?? defaultTerrainLayers : [defaultDetail];
        const layers = await Promise.all(layerNames.map(layer => textureFor(layer, true)));
        if (signal.aborted) return;
        const material = layers.some(Boolean) ? {mask, layers, scale: metadata?.scale ?? 128} : undefined;
        hasDetail ||= Boolean(material);
        for (const part of group) {
          part.texture = handle;
          part.terrain = material;
        }
      }
      if (!handle && !hasDetail) missing++;
    }
  }
  await Promise.all([waterNormals, ...Array.from({length: 4}, load)]);
  if (signal.aborted) return;
  status(missing ? 'Static geometry · ' + number.format(missing) + ' textures unavailable' : 'Static geometry');
  render();
}

async function particleLibrary(game, signal) {
  if (!libraries.has(game)) {
    const bytes = await source.asset(game, 'particles.xr', signal);
    signal.throwIfAborted();
    libraries.set(game, readParticleLibrary(bytes, game));
  }
  return libraries.get(game);
}

async function effectPlacements(game, signal) {
  if (!placementsByGame.has(game)) {
    const data = await source.placements(game, signal);
    signal.throwIfAborted();
    placementsByGame.set(game, data);
  }
  return placementsByGame.get(game);
}

function clearWeather() {
  weatherFrame = undefined;
  grass?.dispose();
  grass = undefined;
  byId('grass-option').hidden = true;
  byId('grass-status').hidden = true;
  weather?.dispose();
  weather = undefined;
  weatherPanel.hidden = true;
}

function startGrass(game, level, metadata, signal) {
  if (!metadata?.maps.includes(level) || signal.aborted) return;
  const status = byId('grass-status');
  grass = createGrassViewer({game, level, source, renderer, passable: metadata.passable, signal, invalidate: render,
    report(message) {
      status.textContent = message;
      status.hidden = !message;
    }});
  byId('grass-option').hidden = false;
  render();
}

grassEnabled.addEventListener('change', render);

function updateWeatherClock() {
  weatherTime.max = weather.duration;
  weatherTime.step = weather.event ? 1 : 60;
  weatherTime.disabled = weather.duration === 0 || !weatherEnabled.checked;
  weatherTime.value = weather.time;
  const hours = Math.floor(weather.time / 3600);
  const minutes = Math.floor(weather.time / 60) % 60;
  const seconds = Math.floor(weather.time) % 60;
  const clock = byId('weather-clock');
  const value = weather.event ? [hours, minutes, seconds] : [hours, minutes];
  const text = value.map(x => String(x).padStart(2, '0')).join(':');
  if (clock.textContent !== text) clock.textContent = text;
}

function startWeather(game, level, data, signal) {
  if (!data?.main || signal.aborted) return;
  weather = createEnvironmentPlayer({renderer, source, game, level, data, signal, invalidate: render});
  const cycles = document.createElement('optgroup'), events = document.createElement('optgroup');
  cycles.label = 'Weather cycles';
  events.label = 'Weather events';
  for (const [id, preset] of Object.entries(data.presets).sort(([a], [b]) => a.localeCompare(b))) {
    if (id.startsWith('[')) continue;
    const label = id.replace(/^fx:(?:fx_)?/, '').replace(/^default_/, '').replaceAll('_', ' ');
    (preset.event ? events : cycles).append(new Option(label[0].toUpperCase() + label.slice(1), id));
  }
  weatherPreset.replaceChildren(cycles);
  if (events.childElementCount) weatherPreset.append(events);
  weatherPreset.value = weather.preset;
  weatherEnabled.checked = true;
  weatherPlay.checked = false;
  weatherAudio.checked = false;
  weatherPreset.disabled = weatherPlay.disabled = weatherAudio.disabled = false;
  updateWeatherClock();
  weatherPanel.hidden = false;
  render();
}

weatherPreset.addEventListener('change', () => {
  if (!weather) return;
  weather.setPreset(weatherPreset.value);
  updateWeatherClock();
  render();
});
weatherTime.addEventListener('input', () => {
  if (!weather) return;
  weather.setTime(Number(weatherTime.value));
  updateWeatherClock();
  render();
});
weatherPlay.addEventListener('change', () => { weather?.setPlaying(weatherPlay.checked); render(); });
weatherAudio.addEventListener('change', () => { weather?.setSound(weatherAudio.checked); render(); });
weatherEnabled.addEventListener('change', () => {
  if (!weather) return;
  weather.setEnabled(weatherEnabled.checked);
  if (!weatherEnabled.checked) weatherAudio.checked = false;
  weatherPreset.disabled = weatherPlay.disabled = weatherAudio.disabled = !weatherEnabled.checked;
  updateWeatherClock();
  render();
});

function clearEffects() {
  particleScene = effectsLight = mapEffects = mapBurst = sceneLibrary = undefined;
  byId('effects').hidden = true;
  for (const handle of particleHandles.values()) renderer.deleteTexture(handle);
  particleHandles.clear();
  particleTextures.clear();
}

async function startEffects(game, library, entries, signal, {map = false} = {}) {
  if (!entries.length || signal.aborted) return;
  sceneLibrary = library;
  const panel = byId('effects'), message = byId('effects-status');
  panel.hidden = false;
  message.textContent = 'Loading particle textures…';
  effectLocation.hidden = !map;
  effectLocation.replaceChildren(new Option('Focus an effect', ''));
  byId('effect-trigger').hidden = true;
  if (map) {
    mapEffects = entries;
    entries.forEach((entry, i) => effectLocation.add(new Option(entry.name, String(i))));
  } else if (entries[0].light) {
    effectsLight = {...entries[0].light, position: entries[0].position};
  }
  const names = new Set(entries.flatMap(entry => [entry.idle, entry.burst]).filter(Boolean));
  const definitions = [...particleDefinitions(library, names)];
  const paths = [...new Set(definitions.flatMap(def => def.textures).filter(Boolean))];
  const ordered = source.orderTextures(game, paths, texturePath).values();
  async function load() {
    for (const texture of ordered) {
      if (signal.aborted) return;
      try {
        const bytes = await source.asset(game, texturePath(texture), signal);
        if (signal.aborted) return;
        particleHandles.set(texture, renderer.mapTexture(bytes));
      } catch (error) {
        if (signal.aborted) return;
      }
    }
  }
  await Promise.all(Array.from({length: 4}, load));
  if (signal.aborted) return;
  let missing = 0;
  for (const def of definitions) {
    const [first, second] = def.textures;
    const distortionOnly = /\\xdistort$/.test(def.shader);
    const base = !distortionOnly && particleHandles.get(first);
    const distort = /\\x(?:distort|add)$/.test(def.shader) && particleHandles.get(distortionOnly ? first : second);
    if (!base && !distort) missing++;
    particleTextures.set(def, {base, distort});
  }
  particleScene = createParticleScene(library, entries, {map});
  message.textContent = (map ? number.format(entries.length) + ' placed effects · Zoom in or choose a location' : [...names].join(', ')) +
    (missing ? ' · ' + missing + ' emitters missing textures' : '');
  render();
}

effectToggle.addEventListener('change', () => {
  particleScene?.restart();
  render();
});
byId('effect-replay').addEventListener('click', () => {
  particleScene?.restart();
  mapBurst = undefined;
  render();
});
effectLocation.addEventListener('change', () => {
  const entry = effectLocation.value === '' ? undefined : mapEffects?.[Number(effectLocation.value)];
  const trigger = byId('effect-trigger');
  trigger.hidden = !entry?.burst;
  trigger.textContent = entry?.name.includes('campfire') ? 'Play fire burst' : 'Trigger anomaly';
  effectsLight = entry?.light && {...entry.light, position: entry.position};
  if (entry) {
    view.center = [...entry.position];
    view.zoom = Math.max(1, Math.min(60, view.radius / 22));
  }
  render();
});
byId('effect-trigger').addEventListener('click', () => {
  const entry = mapEffects?.[Number(effectLocation.value)];
  if (entry?.burst && sceneLibrary) {
    mapBurst = createParticleScene(sceneLibrary, [entry], {burst: true, loop: false});
    render();
  }
});

async function placeMapArtefacts(game, placements, signal) {
  for (const {mesh, position} of placements) {
    if (!mesh || signal.aborted) continue;
    try {
      const bytes = await source.asset(game, mesh, signal);
      if (signal.aborted) return;
      loadWasm(bytes, wasm._ogf_load);
      meshes.push(...uploadWasmMeshes(true, position).next);
    } catch (error) {
      if (signal.aborted) return;
      console.warn('Could not render placed artefact', mesh, error);
    } finally {
      wasm._ogf_release_level();
    }
  }
}

async function selectAsset(path) {
  modelRequest?.abort();
  if (playback.active) updateMeshVertices(false);
  resetPlayback();
  clearEffects();
  clearWeather();
  render();
  const {signal} = modelRequest = new AbortController();
  const game = games.value, isMap = catalogMode === 'maps';
  selectedPath = path;
  setUrl(path);
  for (const button of catalog.querySelectorAll('button')) {
    if (button.dataset.path === path) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  status('Loading ' + displayName(path) + '…');
  try {
    if (catalogMode === 'effects') {
      const library = await particleLibrary(game, signal);
      if (signal.aborted) return;
      if (library.unsupported.has(path)) throw new Error('This effect has no supported sprite definition.');
      view.isMap = false;
      view.cutaway = '';
      view.wireframe = false;
      byId('model-name').textContent = displayName(path);
      byId('front').textContent = 'Front';
      byId('hint').textContent = 'Drag to orbit · Middle-drag to pan · Scroll to zoom';
      byId('wireframe-tool').hidden = true;
      byId('cutaway').hidden = true;
      for (const id of ['view-tools', 'hint']) byId(id).hidden = false;
      byId('empty').hidden = true;
      canvas.classList.add('loaded');
      resetView();
      status('');
      await startEffects(game, library, [{idle: path, position: [0, 0, 0]}], signal);
      return;
    }
    const bytes = await source.asset(game, path, signal);
    if (signal.aborted) return;
    if (isMap) {
      const geometry = await source.asset(game, path + '.geom', signal);
      if (signal.aborted) return;
      loadWasm(bytes, wasm._ogf_load_level, geometry);
      try {
        uploadAsset(displayName(path), true);
      } finally {
        wasm._ogf_release_level();
      }
      dropTextures();
      const data = await effectPlacements(game, signal);
      const entries = data.maps[mapId(path)] ?? [];
      await placeMapArtefacts(game, entries, signal);
      if (signal.aborted) return;
      status('Loading map textures…');
      await loadMapTextures(game, mapId(path), signal, data.terrain, data.levelTextures);
      startWeather(game, mapId(path), data.environment, signal);
      startGrass(game, mapId(path), data.grass, signal);
      if (entries.length && !signal.aborted)
        await startEffects(game, await particleLibrary(game, signal), entries, signal, {map: true});
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
        const buffer = await source.asset(game, texturePath(name), signal);
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
    const attached = (await effectPlacements(game, signal)).models[path];
    if (attached && !signal.aborted)
      await startEffects(game, await particleLibrary(game, signal), [{...attached, position: [0, 0, 0]}], signal);
  } catch (error) {
    if (!signal.aborted) status(error.message, true);
  }
}

async function selectGame(initial = false) {
  catalogRequest?.abort();
  modelRequest?.abort();
  resetPlayback();
  clearEffects();
  clearWeather();
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
  const kind = {maps: 'map', meshes: 'mesh', effects: 'effect'}[catalogMode];
  byId('asset-kind').textContent = {maps: 'Map', meshes: 'Model', effects: 'Effect'}[catalogMode];
  byId('model-name').textContent = 'No ' + (kind === 'mesh' ? 'model' : kind) + ' open';
  const article = kind === 'effect' ? 'an ' : 'a ';
  byId('empty').textContent = 'Select ' + article + kind + ' from the catalog.';
  byId('search-label').textContent = 'Find ' + article + kind;
  catalog.setAttribute('aria-label', catalogMode);
  byId('mesh-views').hidden = catalogMode !== 'meshes';
  for (const [id, mode] of [['mesh-catalog', 'meshes'], ['map-catalog', 'maps'], ['effect-catalog', 'effects']])
    byId(id).setAttribute('aria-pressed', String(catalogMode === mode));
  canvas.classList.remove('loaded');
  for (const id of ['stats', 'materials', 'view-tools', 'hint']) byId(id).hidden = true;
  status('');
  byId('results').textContent = 'Loading catalog…';
  render();
  setUrl();
  try {
    const catalogPaths = await source.catalog(game, catalogMode === 'maps', signal);
    if (signal.aborted) return;
    paths = catalogMode === 'effects' ? (await particleLibrary(game, signal)).names : catalogPaths;
    if (signal.aborted) return;
    let first;
    if (initial) {
      if (catalogMode === 'maps') first = paths.find(path => mapId(path) === startingUrl.searchParams.get('map'));
      else if (catalogMode === 'effects') first = startingUrl.searchParams.get('effect');
      else first = startingUrl.searchParams.get('model') ?? (game === 'soc' ? sakharov : null);
    }
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
for (const [id, mode] of [['mesh-catalog', 'meshes'], ['map-catalog', 'maps'], ['effect-catalog', 'effects']]) {
  byId(id).addEventListener('click', () => {
    if (catalogMode === mode) return;
    catalogMode = mode;
    void selectGame();
  });
}
games.addEventListener('change', () => { void selectGame(); });

try {
  const installed = await source.games();
  for (const {id, name} of installed) games.add(new Option(name, id));
  const requested = startingUrl.searchParams.get('game');
  if (installed.some(game => game.id === requested)) games.value = requested;
  await selectGame(true);
} catch (error) {
  byId('results').textContent = error.message;
}
