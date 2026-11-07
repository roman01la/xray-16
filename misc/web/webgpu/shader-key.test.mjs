import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256, shaderKey } from "./shader-key.js";
test("synchronous shader keys match offline SHA-256 across padding and UTF-8", () => {
  for (const input of [
    "",
    "abc",
    "é🎮",
    ...[55, 56, 63, 64, 65, 100000].map((n) => "x".repeat(n)),
  ])
    assert.equal(
      sha256(input),
      createHash("sha256").update(input).digest("hex"),
    );
  const request = { sources: { vert: "hello", frag: "world" }, attributes: [] };
  assert.equal(
    shaderKey(request),
    createHash("sha256")
      .update("v3" + JSON.stringify(request))
      .digest("hex"),
  );
});
