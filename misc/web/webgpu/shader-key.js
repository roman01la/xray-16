// Synchronous SHA-256 for the engine's synchronous linkProgram ABI.
// Must match the offline compiler's SHA-256("v3" + JSON.stringify(request)).
const K = new Uint32Array(64);
const initial = new Uint32Array(8);
let found = 0;
for (let n = 2; found < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++)
    if (n % d === 0) {
      prime = false;
      break;
    }
  if (!prime) continue;
  if (found < 8) initial[found] = (Math.sqrt(n) % 1) * 2 ** 32;
  K[found++] = (Math.cbrt(n) % 1) * 2 ** 32;
}
const rotate = (x, n) => (x >>> n) | (x << (32 - n));
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
  view.setUint32(padded.length - 4, bytes.length * 8);
  const h = initial.slice(),
    w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
        w[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, j] = h;
    for (let i = 0; i < 64; i++) {
      const t1 =
        (j +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          K[i] +
          w[i]) >>>
        0;
      const t2 =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) >>>
        0;
      j = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, j].forEach((v, i) => (h[i] = (h[i] + v) >>> 0));
  }
  return Array.from(h, (n) => n.toString(16).padStart(8, "0")).join("");
}
export const shaderKey = (request) => sha256("v3" + JSON.stringify(request));
