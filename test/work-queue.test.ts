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

test("publishes closure when queued and in-flight work is finished", async () => {
  const queue = new AsyncWorkQueue([1]);
  assert.equal(queue.isClosed(), false);
  assert.equal(await queue.take(), 1);
  let closed = false;
  const closure = queue.whenClosed().then(() => { closed = true; });
  queue.complete();
  await closure;
  assert.equal(closed, true);
  assert.equal(queue.isClosed(), true);
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

test("preserves FIFO order across internal compaction and requeued work", async () => {
  const initial = Array.from({ length: 2_100 }, (_, index) => index);
  const queue = new AsyncWorkQueue(initial);

  for (let expected = 0; expected < 1_500; expected += 1) {
    assert.equal(await queue.take(), expected);
    queue.complete();
  }

  assert.equal(await queue.take(), 1_500);
  queue.complete([2_100, 2_101]);

  const remaining: number[] = [];
  for (;;) {
    const item = await queue.take();
    if (item === undefined) break;
    remaining.push(item);
    queue.complete();
  }
  assert.deepEqual(remaining, [
    ...Array.from({ length: 599 }, (_, index) => index + 1_501),
    2_100,
    2_101,
  ]);
});
