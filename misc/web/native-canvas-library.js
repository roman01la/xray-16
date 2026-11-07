// Emscripten 7's pthread/HTML5 code uses the historical $GL symbol solely to
// transfer OffscreenCanvas ownership and locate its shared size record. Supply
// that transport table without linking Emscripten's WebGL implementation.
// No contexts, resources, entry points or procedure lookup are provided.
addToLibrary({
  $GL__deps: [],
  $GL__postset: '',
  $GL: { offscreenCanvases: {} },
});

// Native size changes retain the upstream shared-memory/thread handoff, but the
// renderer owns viewport updates. Based on Emscripten libhtml5.js (MIT license).
addToLibrary({
  $setCanvasElementSizeCallingThread: (target, width, height) => {
    var canvas = findCanvasEventTarget(target);
    if (!canvas) return {{{ cDefs.EMSCRIPTEN_RESULT_UNKNOWN_TARGET }}};
    if (canvas.canvasSharedPtr) {
      {{{ makeSetValue('canvas.canvasSharedPtr', 0, 'width', 'i32') }}};
      {{{ makeSetValue('canvas.canvasSharedPtr', 4, 'height', 'i32') }}};
    }
    if (canvas.offscreenCanvas || !canvas.controlTransferredOffscreen) {
      if (canvas.offscreenCanvas) canvas = canvas.offscreenCanvas;
      canvas.width = width;
      canvas.height = height;
    } else if (canvas.canvasSharedPtr) {
      var targetThread = {{{ makeGetValue('canvas.canvasSharedPtr', 8, '*') }}};
      setOffscreenCanvasSizeOnTargetThread(targetThread, target, width, height);
      return {{{ cDefs.EMSCRIPTEN_RESULT_DEFERRED }}};
    } else {
      return {{{ cDefs.EMSCRIPTEN_RESULT_UNKNOWN_TARGET }}};
    }
    return {{{ cDefs.EMSCRIPTEN_RESULT_SUCCESS }}};
  },
});

// Preserve the SDK's fullscreen style/event logic, removing only its optional
// WebGL viewport calls. Fail at build time if the pinned SDK changes this shape.
for (const key of ['$JSEvents_resizeCanvasForFullscreen', '$registerRestoreOldStyle', '$softFullscreenResizeWebGLRenderTarget']) {
  const original = LibraryManager.library[key].toString();
  const native = original.replace(/(?:canvas|target)\.GLctxObject\?\.GLctx\.viewport\([^;]+\);/g, '');
  if (native === original || /GLctx/.test(native)) throw Error('Native canvas SDK adapter needs review: ' + key);
  LibraryManager.library[key] = Function('return (' + native + ')')();
}
