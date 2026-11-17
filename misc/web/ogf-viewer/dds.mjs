// DDS uses top-first rows. Keep that ordering so OGF's original UVs work.
export function readDds(buffer, maxSize = 4096) {
  const view = new DataView(buffer);
  if (view.byteLength < 128 || view.getUint32(0, true) !== 0x20534444 ||
      view.getUint32(4, true) !== 124 || view.getUint32(76, true) !== 32)
    throw new Error('Invalid DDS header');

  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  if (!width || !height || width > maxSize || height > maxSize)
    throw new Error('DDS dimensions must be between 1 and ' + maxSize + ' pixels');

  const flags = view.getUint32(80, true), bits = view.getUint32(88, true);
  if ((flags & 0x40) && !(flags & 4) && (bits === 24 || bits === 32)) {
    const bytesPerPixel = bits / 8;
    const pitch = view.getUint32(8, true) & 8 ? view.getUint32(20, true) : width * bytesPerPixel;
    if (pitch < width * bytesPerPixel || 128 + pitch * height > view.byteLength)
      throw new Error('Truncated DDS image');
    const shifts = [92, 96, 100, 104].map(offset => {
      const mask = view.getUint32(offset, true);
      if (!mask) return -1;
      for (let shift = 0; shift < bits; shift += 8) if (mask === (255 << shift >>> 0)) return shift;
      throw new Error('Unsupported DDS channel mask');
    });
    return {view, width, height, bytesPerPixel, pitch, shifts, format: 'RGB'};
  }

  const format = String.fromCharCode(...new Uint8Array(buffer, 84, 4));
  if (!['DXT1', 'DXT3', 'DXT5'].includes(format))
    throw new Error('Use a DXT1, DXT3 or DXT5 DDS, or a PNG or JPEG texture');

  const blockSize = format === 'DXT1' ? 8 : 16;
  const columns = Math.ceil(width / 4), rows = Math.ceil(height / 4);
  if (128 + columns * rows * blockSize > view.byteLength)
    throw new Error('Truncated DDS image');

  const mipCount = Math.min(view.getUint32(28, true) || 1, 1 + Math.floor(Math.log2(Math.max(width, height))));
  return {view, height, width, format, blockSize, columns, rows, mipCount};
}

export function decodeDds(buffer, maxSize) {
  const {view, height, width, format, blockSize, columns, rows, bytesPerPixel, pitch, shifts} = readDds(buffer, maxSize);
  const pixels = new Uint8Array(width * height * 4);
  if (format === 'RGB') {
    const source = new Uint8Array(buffer);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = 128 + y * pitch + x * bytesPerPixel, target = (y * width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
          const shift = shifts[channel];
          pixels[target + channel] = shift >= 0 ? source[offset + shift / 8] : channel === 3 ? 255 : 0;
        }
      }
    }
    return {width, height, pixels};
  }
  const colors = new Uint8Array(16);
  const alphas = new Uint8Array(8);
  const rgb565 = (index, value) => {
    colors[index] = Math.round(((value >>> 11) & 31) * 255 / 31);
    colors[index + 1] = Math.round(((value >>> 5) & 63) * 255 / 63);
    colors[index + 2] = Math.round((value & 31) * 255 / 31);
    colors[index + 3] = 255;
  };

  let offset = 128;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++, offset += blockSize) {
      const colorOffset = offset + blockSize - 8;
      const a = view.getUint16(colorOffset, true), b = view.getUint16(colorOffset + 2, true);
      const colorBits = view.getUint32(colorOffset + 4, true);
      rgb565(0, a);
      rgb565(4, b);
      const transparent = format === 'DXT1' && a <= b;
      for (let c = 0; c < 3; c++) {
        colors[8 + c] = transparent ? (colors[c] + colors[4 + c]) >> 1 :
          Math.floor((2 * colors[c] + colors[4 + c]) / 3);
        colors[12 + c] = transparent ? 0 : Math.floor((colors[c] + 2 * colors[4 + c]) / 3);
      }
      colors[11] = 255;
      colors[15] = transparent ? 0 : 255;

      let alphaLow = 0, alphaHigh = 0;
      if (format === 'DXT5') {
        alphas[0] = view.getUint8(offset);
        alphas[1] = view.getUint8(offset + 1);
        const steps = alphas[0] > alphas[1] ? 7 : 5;
        for (let i = 1; i < steps; i++)
          alphas[i + 1] = Math.floor(((steps - i) * alphas[0] + i * alphas[1]) / steps);
        if (steps === 5) {
          alphas[6] = 0;
          alphas[7] = 255;
        }
        alphaLow = view.getUint32(offset + 2, true);
        alphaHigh = view.getUint16(offset + 6, true);
      }

      for (let i = 0; i < 16; i++) {
        const x = column * 4 + i % 4, y = row * 4 + (i >> 2);
        if (x >= width || y >= height) continue;
        const source = ((colorBits >>> (i * 2)) & 3) * 4;
        const dest = (y * width + x) * 4;
        pixels.set(colors.subarray(source, source + 4), dest);
        if (format === 'DXT3')
          pixels[dest + 3] = ((view.getUint8(offset + (i >> 1)) >>> ((i & 1) * 4)) & 15) * 17;
        if (format === 'DXT5') {
          const bit = i * 3;
          const alphaIndex = bit < 32 ? ((alphaLow >>> bit) | (bit === 30 ? alphaHigh << 2 : 0)) :
            alphaHigh >>> (bit - 32);
          pixels[dest + 3] = alphas[alphaIndex & 7];
        }
      }
    }
  }
  return {width, height, pixels};
}

// DDS cubemap faces are stored in +X, -X, +Y, -Y, +Z, -Z order. Each
// face includes its mip chain before the next face begins.
export function decodeDdsCube(buffer) {
  const info = readDds(buffer);
  const {view, width, height, blockSize, bytesPerPixel, pitch} = info;
  const faces = view.getUint32(112, true);
  if ((faces & 0xfe00) !== 0xfe00 || width !== height) throw new Error('Expected a complete DDS cubemap');
  const mips = Math.min(view.getUint32(28, true) || 1, 1 + Math.floor(Math.log2(width)));
  const base = blockSize ? Math.ceil(width / 4) * Math.ceil(height / 4) * blockSize : pitch * height;
  let stride = base;
  for (let i = 1; i < mips; i++) {
    const w = Math.max(1, width >> i);
    stride += blockSize ? Math.ceil(w / 4) ** 2 * blockSize : w * w * bytesPerPixel;
  }
  if (128 + stride * 6 > view.byteLength) throw new Error('Truncated DDS cubemap');

  const face = new Uint8Array(128 + base);
  face.set(new Uint8Array(buffer, 0, 128));
  return Array.from({length: 6}, (_, i) => {
    face.set(new Uint8Array(buffer, 128 + i * stride, base), 128);
    return decodeDds(face.buffer);
  });
}
