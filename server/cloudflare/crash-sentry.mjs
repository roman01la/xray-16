const kinds = new Set(['assertion', 'worker', 'gpu-lost', 'launch']);
const clean = value => value
  .replace(/https?:\/\/[^\s)]+/gi, address => {
    const position = address.match(/:\d+:\d+$/)?.[0] ?? '';
    const url = position ? address.slice(0, -position.length) : address;
    try { return (new URL(url).pathname.split('/').pop() || '[URL]') + position; }
    catch { return '[URL]'; }
  })
  .replace(/(?:[A-Z]:[\\/]|\/|\\)(?:[^\n<>:"|?*]+[\\/])+([^\s\\/]+)/gi, '$1');

function crashContext(input) {
  if (!input || typeof input !== 'object') return {};
  const context = {};
  for (const [key, allowed] of Object.entries({
    phase: ['startup', 'level-loading', 'gameplay'],
    browser: ['Chrome', 'Edge', 'Firefox', 'Opera', 'Safari'],
    os: ['Windows', 'macOS', 'Linux', 'Android', 'iOS'],
    gpuPresentation: ['direct', 'readback'],
  })) {
    if (allowed.includes(input[key])) context[key] = input[key];
  }
  for (const [key, maximum] of Object.entries({
    browserMajor: 999, renderWidth: 32768, renderHeight: 32768,
    renderedFrames: 1_000_000_000, validationErrors: 1_000_000_000,
  })) {
    if (Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= maximum)
      context[key] = input[key];
  }
  for (const key of ['gpuVendor', 'gpuArchitecture']) {
    if (typeof input[key] === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(input[key]))
      context[key] = input[key];
  }
  for (const key of ['gpuFallback', 'gpuCanvasImportFailed']) {
    if (typeof input[key] === 'boolean') context[key] = input[key];
  }
  return context;
}

export function crashEnvelope(report, dsn) {
  if (!report || !['soc', 'cop', 'cs'].includes(report.game) ||
      typeof report.release !== 'string' || !/^[a-f0-9]{64}$/.test(report.release) ||
      !kinds.has(report.kind) || typeof report.message !== 'string' || !report.message.trim() ||
      report.message.length > 1500 || typeof report.stack !== 'string' || report.stack.length > 6000)
    return null;

  const { game, release, kind } = report;
  const level = typeof report.level === 'string' && /^[a-z0-9_]+[\\/]?$/i.test(report.level) && report.level.length <= 64
    ? report.level.replace(/[\\/]$/, '') : undefined;
  const message = clean(report.message).trim();
  const context = crashContext(report.context);
  const frames = [];
  for (const line of report.stack.split('\n').slice(0, 40)) {
    // Chromium can include the module URL or a wasm:// alias. Firefox can
    // omit the module entirely. The release points to the exact game Wasm.
    const wasm = line.match(/wasm-function\[(\d{1,10})\]:(0x[a-f0-9]+)\b/i);
    const wasmModule = line.match(/([\w.-]+\.wasm):(?:wasm-function|0x)/i)?.[1];
    const legacyWasm = line.match(/xr_3da\.wasm:(0x[a-f0-9]+)\b/i);
    if (wasm || legacyWasm) {
      const filename = wasmModule ?? 'xr_3da.wasm';
      frames.push({ filename, instruction_addr: wasm?.[2] ?? legacyWasm[1], in_app: true,
        ...(wasm && { function: `wasm-function[${wasm[1]}]` }) });
      continue;
    }
    const js = clean(line).trim().replace(/^at\s+/, '').match(/^(.*?)\s*(?:\(|@)?([\w.-]+\.m?js):(\d+):(\d+)\)?$/);
    if (js) frames.push({ function: js[1].trim(), filename: js[2], lineno: Number(js[3]), colno: Number(js[4]), in_app: true });
  }
  const assertion = message.match(/Expression\s*:\s*([^\n]+)[\s\S]*?Function\s*:\s*([^\n]+)/);
  const description = kind === 'assertion' && message.match(/Description\s*:\s*([^\n]+)/)?.[1];
  const value = description ? description + '\n\n' + message : message;
  const firstWasm = frames.find(frame => frame.filename === 'xr_3da.wasm')?.instruction_addr;
  const event_id = crypto.randomUUID().replaceAll('-', '');
  const event = {
    event_id, release, environment: 'production', platform: 'javascript', level: 'fatal',
    timestamp: Date.now() / 1000, tags: { game, kind, ...(level && { map: level }), ...(context.phase && { phase: context.phase }) },
    ...(Object.keys(context).length && { contexts: { xray: context } }),
    fingerprint: [game, kind, ...(assertion ? assertion.slice(1) : [message.split('\n')[0].slice(0, 160), ...(firstWasm ? [release, firstWasm] : [])])],
    exception: { values: [{ type: 'X-Ray ' + kind, value,
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
