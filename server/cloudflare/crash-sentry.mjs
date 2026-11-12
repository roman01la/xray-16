const kinds = new Set(['assertion', 'worker', 'gpu-lost', 'launch']);
const clean = value => value
  .replace(/https?:\/\/[^\s)]+/gi, address => {
    const position = address.match(/:\d+:\d+$/)?.[0] ?? '';
    const url = position ? address.slice(0, -position.length) : address;
    try { return (new URL(url).pathname.split('/').pop() || '[URL]') + position; }
    catch { return '[URL]'; }
  })
  .replace(/(?:[A-Z]:[\\/]|\/|\\)(?:[^\n<>:"|?*]+[\\/])+([^\s\\/]+)/gi, '$1');

export function crashEnvelope(report, dsn) {
  if (!report || !['soc', 'cop'].includes(report.game) ||
      typeof report.release !== 'string' || !/^[a-f0-9]{64}$/.test(report.release) ||
      !kinds.has(report.kind) || typeof report.message !== 'string' || !report.message.trim() ||
      report.message.length > 1500 || typeof report.stack !== 'string' || report.stack.length > 3500)
    return null;

  const { game, release, kind } = report;
  const level = typeof report.level === 'string' && /^[a-z0-9_]+[\\/]?$/i.test(report.level) && report.level.length <= 64
    ? report.level.replace(/[\\/]$/, '') : undefined;
  const message = clean(report.message);
  const stack = clean(report.stack);
  const frames = [];
  for (const line of stack.split('\n')) {
    const wasm = line.match(/(xr_3da\.wasm)(?:\s+\[wasm-function\[\d+\]\])?:(0x[a-f0-9]+)/i);
    if (wasm) {
      frames.push({ filename: wasm[1], instruction_addr: wasm[2], in_app: true });
      continue;
    }
    const js = line.trim().replace(/^at\s+/, '').match(/^(.*?)\s*(?:\(|@)?([\w.-]+\.m?js):(\d+):(\d+)\)?$/);
    if (js) frames.push({ function: js[1].trim(), filename: js[2], lineno: Number(js[3]), colno: Number(js[4]), in_app: true });
  }
  const assertion = message.match(/Expression\s*:\s*([^\n]+)[\s\S]*?Function\s*:\s*([^\n]+)/);
  const firstWasm = frames.find(frame => frame.instruction_addr)?.instruction_addr;
  const event_id = crypto.randomUUID().replaceAll('-', '');
  const event = {
    event_id, release, environment: 'production', platform: 'javascript', level: 'fatal',
    timestamp: Date.now() / 1000, tags: { game, kind, ...(level && { map: level }) },
    fingerprint: [game, kind, ...(assertion ? assertion.slice(1) : [message.split('\n')[0].slice(0, 160), ...(firstWasm ? [release, firstWasm] : [])])],
    exception: { values: [{ type: 'X-Ray ' + kind, value: message,
      ...(frames.length && { stacktrace: { frames: frames.reverse() } }) }] },
  };
  return [JSON.stringify({ event_id, dsn, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n') + '\n';
}

export function sentryEndpoint(dsn) {
  const match = typeof dsn === 'string' &&
    dsn.match(/^https:\/\/[a-f0-9]+@(o\d+\.ingest(?:\.[a-z]+)?\.sentry\.io)\/(\d+)$/);
  return match ? `https://${match[1]}/api/${match[2]}/envelope/` : null;
}
