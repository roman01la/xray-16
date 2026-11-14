// Collect fatal signals only. The renderer never calls this on a normal frame.
export function installCrashReporter(game) {
  const release = location.pathname.match(/^\/releases\/([a-f0-9]{64})\//)?.[1];
  if (!release) return;
  let pending, timer, sent = false, level, rendererContext;
  let phase = 'startup';
  const ua = navigator.userAgent;
  const browser = ua.match(/(Edg|OPR|Firefox|Chrome|Version)\/(\d+)/);
  const browserNames = {Edg: 'Edge', OPR: 'Opera', Firefox: 'Firefox', Chrome: 'Chrome', Version: 'Safari'};
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' :
    /iPhone|iPad/.test(ua) ? 'iOS' : /Mac/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : undefined;

  function flush() {
    if (!pending || sent) return;
    clearTimeout(timer);
    sent = true;
    const context = {
      phase,
      browser: browserNames[browser?.[1]],
      browserMajor: browser && Number(browser[2]),
      os,
      ...rendererContext,
    };
    const body = JSON.stringify({ game, release, level, ...pending, context });
    const blob = new Blob([body], { type: 'application/json' });
    try {
      if (navigator.sendBeacon?.('/crash-report', blob)) return;
    } catch { /* Fall back to a keepalive request. */ }
    fetch('/crash-report', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }

  window.addEventListener('xray-engine-log', ({ detail }) => {
    const prefix = 'XRAY_CRASH_LEVEL ';
    if (typeof detail !== 'string') return;
    if (detail.startsWith(prefix)) {
      level = detail.slice(prefix.length).trim();
      phase = 'level-loading';
    } else if (level && detail.includes('End of synchronization')) {
      phase = 'gameplay';
    }
  });
  window.addEventListener('xray-crash', ({ detail }) => {
    if (sent || !detail?.message) return;
    if (detail.context) rendererContext = detail.context;
    const report = {
      kind: detail.kind,
      message: String(detail.message).slice(0, 1500),
      stack: String(detail.stack ?? '').slice(0, 6000),
    };
    // A native assertion usually precedes a second, generic WASM trap.
    if (!pending || report.kind === 'assertion') {
      if (pending && (!report.stack || (!/wasm-function/.test(report.stack) && /wasm-function/.test(pending.stack))))
        report.stack = pending.stack;
      pending = report;
    } else if (!pending.stack || (!/wasm-function/.test(pending.stack) && /wasm-function/.test(report.stack))) {
      pending.stack = report.stack;
    }
    if (!timer) timer = setTimeout(flush, 120);
  });
  window.addEventListener('pagehide', flush);
}
