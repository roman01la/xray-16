// Installed only for a separate diagnostic capture, after ordinary benchmarks.
export function installQueueProbe() {
  const queue = globalThis.__xrayWebGPU.device.queue;
  const originalWrite = queue.writeBuffer;
  const originalSubmit = queue.submit;
  const totals = new Map();
  const slowCalls = [];
  function record(label, start, bytes) {
    const elapsed = performance.now() - start;
    let total = totals.get(label);
    if (!total) {
      total = { calls: 0, bytes: 0, ms: 0, maxMs: 0 };
      totals.set(label, total);
    }
    total.calls++;
    total.bytes += bytes;
    total.ms += elapsed;
    total.maxMs = Math.max(total.maxMs, elapsed);
    if (elapsed > 5 && slowCalls.length < 200) {
      slowCalls.push({ label, start, ms: elapsed, bytes, stack: new Error().stack });
    }
  }
  queue.writeBuffer = function(buffer, offset, data, dataOffset, size) {
    const start = performance.now();
    const bytes = size === undefined
      ? data.byteLength - (dataOffset || 0) * (data.BYTES_PER_ELEMENT || 1)
      : size * (data.BYTES_PER_ELEMENT || 1);
    const result = originalWrite.call(this, buffer, offset, data, dataOffset, size);
    record(buffer.label || 'unlabelled writeBuffer', start, bytes);
    return result;
  };
  queue.submit = function(commands) {
    const start = performance.now();
    const result = originalSubmit.call(this, commands);
    record('submit', start, 0);
    return result;
  };
  globalThis.__stopQueueProbe = () => {
    queue.writeBuffer = originalWrite;
    queue.submit = originalSubmit;
    return { totals: Object.fromEntries(totals), slowCalls };
  };
}
