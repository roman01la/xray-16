// Detail slots are expanded in a worker. GPU mesh buffers and the atlas are
// reused as the visible terrain region changes.
export function createGrassViewer({game, level, source, renderer, passable, signal, invalidate, report}) {
  const meshes = [], textures = new Map();
  let worker, loading = false, ready = false, failed = false, disposed = false;
  let desired, sent, pending = false, result;

  function release() {
    worker?.terminate();
    for (const mesh of meshes) renderer.deleteMesh(mesh);
    meshes.length = 0;
    for (const texture of textures.values()) renderer.deleteTexture(texture);
    textures.clear();
  }

  function error(message) {
    if (signal.aborted || disposed) return;
    failed = true;
    release();
    report('Ground cover unavailable');
    console.warn('Terrain ground cover:', message);
    invalidate();
  }

  function requestView() {
    if (!ready || pending || !desired || desired.key === sent) return;
    sent = desired.key;
    pending = true;
    worker.postMessage({type: 'view', ...desired});
  }

  async function loadAtlas(name) {
    const path = name.toLowerCase().replaceAll('\\', '/').replace(/\.(?:dds|tga|bmp)$/, '') + '.dds';
    let bytes;
    try {
      bytes = await source.asset(game, 'levels/' + level + '/' + path, signal);
    } catch (error) {
      signal.throwIfAborted();
      bytes = await source.asset(game, 'textures/' + path, signal);
    }
    signal.throwIfAborted();
    if (disposed) return;
    textures.set(name, renderer.terrainTexture(bytes));
  }

  async function finishSetup(prototypes) {
    for (const prototype of prototypes) {
      const mesh = renderer.createMesh(prototype.vertices, prototype.indices, true, prototype.wind);
      mesh.grass = true;
      mesh.shader = prototype.shader;
      mesh.name = prototype.texture;
      meshes.push(mesh);
    }
    await Promise.all([...new Set(meshes.map(mesh => mesh.name))].map(loadAtlas));
    if (disposed || signal.aborted) return;
    for (const mesh of meshes) mesh.texture = textures.get(mesh.name);
    ready = true;
    requestView();
    report('');
    invalidate();
  }

  async function prepare() {
    loading = true;
    report('Loading ground cover…');
    try {
      const path = 'levels/' + level + '/level';
      const [details, collision] = await Promise.all([
        source.asset(game, path + '.details', signal),
        source.asset(game, path + '.cform', signal),
      ]);
      if (disposed || signal.aborted) return;
      worker = new Worker(new URL('./grass-worker.mjs', import.meta.url), {type: 'module'});
      worker.onerror = event => error(event.message);
      worker.onmessage = ({data}) => {
        if (disposed || failed || signal.aborted) return;
        if (data.type === 'ready') {
          void finishSetup(data.prototypes).catch(cause => error(cause.message));
        } else if (data.type === 'instances') {
          pending = false;
          result = data;
          requestView();
          invalidate();
        } else if (data.type === 'error') error(data.message);
      };
      worker.postMessage({type: 'load', details, collision, passable}, [details, collision]);
    } catch (cause) {
      error(cause.message);
    }
  }

  return {
    forView(view) {
      const distance = view.radius / view.zoom;
      if (distance > 145 || disposed || failed) return [];
      const center = [view.center[0], view.center[2]].map(value => Math.round(value / 8) * 8);
      const radius = Math.max(24, Math.min(72, Math.ceil(distance * 1.35 / 8) * 8));
      desired = {key: [radius, ...center].join(','), center, radius};
      if (!loading) void prepare();
      requestView();
      if (result) {
        for (const [i, items] of result.items.entries()) renderer.updateGrassInstances(meshes[i], items);
        result = undefined;
      }
      return meshes;
    },
    dispose() {
      disposed = true;
      release();
    },
  };
}
