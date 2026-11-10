addToLibrary({
  $xrayAudioWorklets: {},

  xray_audio_worklet_start__sig: 'ipi',
  xray_audio_worklet_start__proxy: 'sync',
  xray_audio_worklet_start__deps: ['$xrayAudioWorklets'],
  xray_audio_worklet_start: (pointer, voices) => {
    const reportError = (message, error) => {
      Module['printErr']?.(message + (error ? ' ' + (error.message || String(error)) : ''));
      console.error(message, error);
    };
    const offset = Number(pointer);
    const buffer = wasmMemory.buffer;
    if (!globalThis.AudioContext || !globalThis.AudioWorkletNode || !(buffer instanceof SharedArrayBuffer)) {
      reportError('Web audio requires AudioWorklet and shared Wasm memory.');
      return 0;
    }

    let context;
    try {
      context = new AudioContext({latencyHint: 'interactive'});
    } catch (error) {
      reportError('Could not open the browser audio output:', error);
      return 0;
    }
    if (!context.audioWorklet) {
      context.close().catch(() => {});
      reportError('The browser audio context could not provide an AudioWorklet.');
      return 0;
    }

    const input = new AbortController();
    const record = {context, input, node: null, closing: false};
    xrayAudioWorklets[offset] = record;
    const resume = () => {
      if (context.state === 'suspended') context.resume().catch(error => console.warn('Could not resume browser audio:', error));
    };
    for (const event of ['pointerdown', 'keydown', 'touchstart'])
      document.addEventListener(event, resume, {signal: input.signal, passive: true, capture: true});
    if (navigator.userActivation?.hasBeenActive) resume();

    // The fixed mixer allocation predates this view. Growing shared Wasm
    // memory later keeps this range backed by the same shared bytes.
    context.audioWorklet.addModule(new URL('./audio-worklet.mjs', import.meta.url)).then(() => {
      if (record.closing) return;
      const node = new AudioWorkletNode(context, 'xray-audio', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
        processorOptions: {buffer, offset, voices},
      });
      node.onprocessorerror = event => reportError('X-Ray audio worklet stopped:', event);
      node.connect(context.destination);
      record.node = node;
      Module['print']?.('SOUND: Browser AudioWorklet ready.');
    }).catch(error => {
      if (!record.closing) reportError('Could not start the X-Ray audio worklet:', error);
    });
    return 1;
  },

  xray_audio_worklet_stop__sig: 'vp',
  xray_audio_worklet_stop__proxy: 'async',
  xray_audio_worklet_stop__deps: ['$xrayAudioWorklets', 'free'],
  xray_audio_worklet_stop: (pointer) => {
    const offset = Number(pointer);
    const record = xrayAudioWorklets[offset];
    if (!record || record.closing) return;
    record.closing = true;
    record.input.abort();
    record.node?.disconnect();
    const stopped = record.context.state === 'closed' ? Promise.resolve() : record.context.close();
    stopped.then(() => {
      delete xrayAudioWorklets[offset];
      _free({{{ to64('offset') }}});
    }).catch(error => console.error('Could not close the X-Ray audio worklet:', error));
  },
});
