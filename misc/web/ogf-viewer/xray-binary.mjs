// Little-endian chunks and zero-terminated strings shared by X-Ray assets.
export class Reader {
  constructor(bytes) {
    if (!bytes) throw new Error('Missing X-Ray chunk');
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.at = 0;
  }
  get remaining() { return this.bytes.length - this.at; }
  take(n) {
    if (n < 0 || n > this.remaining) throw new Error('Truncated X-Ray data');
    const start = this.at;
    this.at += n;
    return this.bytes.subarray(start, this.at);
  }
  u8() { return this.take(1)[0]; }
  u16() { const at = this.at; this.take(2); return this.view.getUint16(at, true); }
  u32() { const at = this.at; this.take(4); return this.view.getUint32(at, true); }
  i32() { const at = this.at; this.take(4); return this.view.getInt32(at, true); }
  f32() { const at = this.at; this.take(4); return this.view.getFloat32(at, true); }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  string() {
    const end = this.bytes.indexOf(0, this.at);
    if (end < 0 || end - this.at > 65535) throw new Error('Invalid X-Ray string');
    return decoder.decode(this.take(end - this.at + 1).subarray(0, -1));
  }
}

const decoder = new TextDecoder();

export function chunks(bytes) {
  const result = new Map();
  const reader = new Reader(bytes);
  while (reader.remaining) {
    const id = reader.u32();
    result.set(id, reader.take(reader.u32()));
  }
  return result;
}
