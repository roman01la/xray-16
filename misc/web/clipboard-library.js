addToLibrary({
  $xrayClipboardInput: { listeners: null },

  xray_web_enable_clipboard__proxy: 'sync',
  xray_web_enable_clipboard__deps: [
    '$xrayClipboardInput', '$withStackSave', '$stringToUTF8OnStack', 'xray_web_paste_text',
  ],
  xray_web_enable_clipboard: (enabled) => {
    if (!enabled) {
      xrayClipboardInput.listeners?.abort();
      xrayClipboardInput.listeners = null;
      return;
    }
    const canvas = Module['canvas'];
    if (!canvas || xrayClipboardInput.listeners) return;
    const document = canvas.ownerDocument;
    const focused = () => document.activeElement === canvas;
    const listeners = new AbortController();
    xrayClipboardInput.listeners = listeners;
    const options = { capture: true, signal: listeners.signal };

    // SDL consumes Ctrl+V as a navigation shortcut. Keep the browser's
    // default action so it can deliver the native Paste event.
    document.defaultView.addEventListener('keydown', event => {
      if (!focused() || event.altKey) return;
      const paste = !event.shiftKey && (event.ctrlKey || event.metaKey) &&
        (event.code === 'KeyV' || event.key.toLowerCase() === 'v');
      const insert = event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === 'Insert';
      if (paste || insert) event.stopImmediatePropagation();
    }, options);

    document.addEventListener('paste', event => {
      if (!event.isTrusted || !focused()) return;
      const text = event.clipboardData?.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      // The game uses single-line fields. Clipboard line breaks are text,
      // never Enter presses.
      const line = text.slice(0, 4096).replace(/\r\n|[\x00-\x1f\x7f\u2028\u2029]/g, ' ');
      withStackSave(() => {
        const pointer = stringToUTF8OnStack(line);
        _xray_web_paste_text({{{ to64('pointer') }}});
      });
    }, options);
  },
});
