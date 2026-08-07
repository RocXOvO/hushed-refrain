import assert from "node:assert/strict";
import { test } from "node:test";
import { AsyncWorkQueue } from "../src/work-queue";

test("keeps idle workers waiting for page-level work to be requeued", async () => {
  const queue = new AsyncWorkQueue([1]);
  const first = await queue.take();
  assert.equal(first, 1);
  const waitingWorker = queue.take();

  queue.complete(first);
  assert.equal(await waitingWorker, 1);
  queue.complete();
  assert.equal(await queue.take(), undefined);
});

test("wakes waiting workers when scheduling stops", async () => {
  const queue = new AsyncWorkQueue([1]);
  assert.equal(await queue.take(), 1);
  const waitingWorker = queue.take();
  queue.stop();
  assert.equal(await waitingWorker, undefined);
  queue.complete();
});

test("fans adaptive split work out to multiple waiting workers", async () => {
  const queue = new AsyncWorkQueue([1]);
  assert.equal(await queue.take(), 1);
  const waitingA = queue.take();
  const waitingB = queue.take();
  queue.complete([2, 3]);
  assert.deepEqual(await Promise.all([waitingA, waitingB]), [2, 3]);
  queue.complete();
  queue.complete();
});
