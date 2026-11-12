// Collect fatal signals only. The renderer never calls this on a normal frame.
export function installCrashReporter(game) {
  const release = location.pathname.match(/^\/releases\/([a-f0-9]{64})\//)?.[1];
  if (!release) return;
  let pending, timer, sent = false, level;

  function flush() {
    if (!pending || sent) return;
    clearTimeout(timer);
    sent = true;
    const body = JSON.stringify({ game, release, level, ...pending });
    const blob = new Blob([body], { type: 'application/json' });
    try {
      if (navigator.sendBeacon?.('/crash-report', blob)) return;
    } catch { /* Fall back to a keepalive request. */ }
    fetch('/crash-report', { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }

  window.addEventListener('xray-engine-log', ({ detail }) => {
    const prefix = 'XRAY_CRASH_LEVEL ';
    if (detail.startsWith(prefix)) level = detail.slice(prefix.length).trim();
  });
  window.addEventListener('xray-crash', ({ detail }) => {
    if (sent || !detail?.message) return;
    const report = {
      kind: detail.kind,
      message: String(detail.message).slice(0, 1500),
      stack: String(detail.stack ?? '').slice(0, 3500),
    };
    // A native assertion usually precedes a second, generic WASM trap.
    if (!pending || report.kind === 'assertion') {
      if (!report.stack && pending) report.stack = pending.stack;
      pending = report;
    } else if (!pending.stack) {
      pending.stack = report.stack;
    }
    if (!timer) timer = setTimeout(flush, 120);
  });
  window.addEventListener('pagehide', flush);
}
