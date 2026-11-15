import assert from "node:assert/strict";
import test from "node:test";
import { CanvasReadback } from "./backend.js";

test("canvas fallback removes GPU row padding and drops pending frames during resize", async () => {
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, COPY_SRC: 2 };
  globalThis.GPUBufferUsage = { COPY_DST: 1, MAP_READ: 2 };
  globalThis.GPUMapMode = { READ: 1 };
  const canvas = { width: 3, height: 2 };
  const painted = [];
  const context = {
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: image => painted.push([...image.data]),
  };
  const device = {
    createTexture: ({size: [width, height]}) => ({width, height, createView: () => ({}), destroy() {}}),
    createBuffer: ({size}) => ({
      size, mapState: "unmapped", data: new Uint8Array(size),
      async mapAsync() { this.mapState = "mapped"; },
      getMappedRange() { return this.data.buffer; },
      unmap() { this.mapState = "unmapped"; },
      destroy() {},
    }),
  };
  const encoder = {
    copyTextureToBuffer(_source, {buffer, bytesPerRow}, [width, height]) {
      assert.equal(bytesPerRow, 256);
      for (let row = 0; row < height; row++)
        buffer.data.fill(row + 1, row * bytesPerRow, row * bytesPerRow + width * 4);
    },
  };

  const presenter = new CanvasReadback(canvas, device, context);
  presenter.view();
  const first = presenter.copy(encoder);
  assert.equal(presenter.copy(encoder), undefined);
  await first();
  assert.deepEqual(painted, [[...Array(12).fill(1), ...Array(12).fill(2)]]);

  const oldSize = presenter.copy(encoder);
  canvas.width = 5;
  presenter.view();
  assert.equal(presenter.copy(encoder), undefined);
  await oldSize();
  assert.equal(painted.length, 1);

  await presenter.copy(encoder)();
  assert.deepEqual(painted[1], [...Array(20).fill(1), ...Array(20).fill(2)]);
});
