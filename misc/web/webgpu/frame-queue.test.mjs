import test from 'node:test';
import assert from 'node:assert/strict';
import { GPUFrontend } from './backend.js';

test('frame queue yields until the oldest submission completes and retires failures', async () => {
  const renderer = Object.create(GPUFrontend.prototype);
  const completions = [];
  renderer.pendingFrames = [];
  renderer.device = { queue: { onSubmittedWorkDone() {
    return new Promise((resolve, reject) => completions.push({ resolve, reject }));
  } } };
  renderer.trackSubmittedFrame();
  assert.equal(completions.length, 0);
  assert.equal(renderer.pendingFrameCompletion(), null);
  renderer.trackSubmittedFrame();
  assert.equal(renderer.pendingFrameCompletion(), null);
  renderer.trackSubmittedFrame();
  const oldest = renderer.pendingFrameCompletion();
  assert.ok(oldest instanceof Promise);
  completions[0].resolve();
  await oldest;
  assert.equal(renderer.pendingFrameCompletion(), null);
  renderer.trackSubmittedFrame();
  completions[1].reject(new Error('device lost'));
  await Promise.resolve();
  assert.equal(renderer.pendingFrameCompletion(), null);
  completions[2].resolve();
  await Promise.resolve();
  assert.equal(renderer.pendingFrames.length, 0);
});
