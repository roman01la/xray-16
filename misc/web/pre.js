if (typeof WorkerGlobalScope !== 'undefined' && !globalThis.__xrayErrorHook) {
  globalThis.__xrayErrorHook = true;
  addEventListener('error', (e) => {
    const stack = e.error && e.error.stack ? e.error.stack : '(no stack)';
    console.error('[worker trap] ' + e.message + '\n' + stack);
  });
}

// The page and SDL both request pointer lock through the game canvas.
// Keep the raw-input preference local to that canvas.
if (typeof Module['canvas']?.requestPointerLock === 'function') {
  const canvas = Module['canvas'];
  const request = canvas.requestPointerLock.bind(canvas);
  let preferRaw = true;
  let pending;

  async function capture() {
    if (preferRaw) {
      try {
        return await request({ unadjustedMovement: true });
      } catch (error) {
        if (error.name !== 'NotSupportedError') throw error;
        preferRaw = false;
      }
    }
    return request();
  }

  canvas.requestPointerLock = () => {
    if (pending) return pending;
    if (canvas.ownerDocument.pointerLockElement === canvas) return Promise.resolve();
    pending = capture().finally(() => { pending = undefined; });
    // Emscripten's SDL bridge calls this method without awaiting the result.
    pending.catch(() => {});
    return pending;
  };
}
