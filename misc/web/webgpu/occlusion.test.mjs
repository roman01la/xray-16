import test from "node:test";
import assert from "node:assert/strict";
import { OcclusionQueries } from "./occlusion.js";

globalThis.GPUBufferUsage = {
  QUERY_RESOLVE: 1,
  COPY_SRC: 2,
  COPY_DST: 4,
  MAP_READ: 8,
};
globalThis.GPUMapMode = { READ: 1 };
function fixture(values) {
  const device = {
    createQuerySet: () => ({}),
    createBuffer: ({ size }) => ({
      data: new ArrayBuffer(size),
      async mapAsync() {},
      getMappedRange() {
        return this.data;
      },
      unmap() {},
    }),
  };
  const encoder = {
    resolveQuerySet(set, start, count, dst) {
      new BigUint64Array(dst.data).set(values.slice(0, count));
    },
    copyBufferToBuffer(src, offset, dst, destOffset, size) {
      new Uint8Array(dst.data, destOffset, size).set(
        new Uint8Array(src.data, offset, size),
      );
    },
  };
  const pass = { beginOcclusionQuery() {}, endOcclusionQuery() {} };
  return { queries: new OcclusionQueries(device, 16), encoder, pass };
}
test("occlusion readback combines segments without blocking the engine", async () => {
  const { queries, encoder, pass } = fixture([0n, 7n]);
  const query = {};
  queries.begin(pass, query);
  queries.suspend(pass);
  queries.resume(pass);
  queries.end(pass);
  assert.equal(query.available, false);
  await queries.resolve(encoder)();
  assert.equal(query.available, true);
  assert.equal(query.result, 1);
});
test("occluded queries return zero and reused queries ignore stale results", async () => {
  const { queries, encoder, pass } = fixture([0n]);
  const query = {};
  queries.begin(pass, query);
  queries.end(pass);
  await queries.resolve(encoder)();
  assert.equal(query.result, 0);
  queries.begin(pass, query);
  queries.end(pass);
  const readback = queries.resolve(encoder);
  queries.begin(pass, query);
  queries.end(pass);
  await readback();
  assert.equal(query.available, false);
});
