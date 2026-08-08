import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rename, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AtomicWriteError,
  readAtomicJson,
  writeAtomicBuffer,
  writeAtomicJson,
} from "../src/atomic-file";

test("retries a transient Windows rename lock and eventually commits", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-retry-"));
  const path = join(root, "state.json");
  let attempts = 0;

  await writeAtomicJson(path, { generation: 2 }, {
    randomId: () => "retry-test",
    retryDelaysMs: [0, 0],
    sleep: async () => {},
    renameFile: async (source, destination) => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("locked"), { code: attempts === 1 ? "EPERM" : "EBUSY" });
      }
      await rename(source, destination);
    },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { generation: 2 });
});

test("atomically writes binary PDF output", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-buffer-"));
  const path = join(root, "report.pdf");
  const pdfHeader = Buffer.from("%PDF-1.7\n", "ascii");
  await writeAtomicBuffer(path, pdfHeader, { randomId: () => "pdf" });
  assert.deepEqual(await readFile(path), pdfHeader);
  assert.equal((await readdir(root)).filter((name) => name.includes(".tmp-")).length, 0);
});

test("aborting a binary write during rename backoff cannot replace the official file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-abort-"));
  const path = join(root, "report.pdf");
  await writeFile(path, "%PDF-old", "ascii");
  const controller = new AbortController();
  let waiting!: () => void;
  const enteredBackoff = new Promise<void>((resolve) => { waiting = resolve; });
  const write = writeAtomicBuffer(path, Buffer.from("%PDF-new", "ascii"), {
    randomId: () => "aborted",
    signal: controller.signal,
    retryDelaysMs: [60_000],
    renameFile: async () => {
      throw Object.assign(new Error("locked"), { code: "EBUSY" });
    },
    sleep: async () => {
      waiting();
      await new Promise<void>(() => {});
    },
  });
  await enteredBackoff;
  controller.abort(new Error("timed out"));
  await assert.rejects(write, /timed out/);
  assert.equal(await readFile(path, "ascii"), "%PDF-old");
  assert.equal((await readdir(root)).filter((name) => name.includes(".tmp-")).length, 0);
});

test("concurrent writes to one path use distinct temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-concurrent-"));
  const path = join(root, "state.json");
  const sources = new Set<string>();
  let arrivals = 0;
  let releaseBarrier!: () => void;
  const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
  let renameTail = Promise.resolve();
  const renameFile = async (source: string, destination: string): Promise<void> => {
    sources.add(source);
    arrivals += 1;
    if (arrivals === 2) releaseBarrier();
    await barrier;
    const operation = renameTail.then(() => rename(source, destination));
    renameTail = operation.catch(() => {});
    await operation;
  };

  await Promise.all([
    writeAtomicJson(path, { writer: "first" }, { randomId: () => "writer-a", renameFile }),
    writeAtomicJson(path, { writer: "second" }, { randomId: () => "writer-b", renameFile }),
  ]);

  assert.equal(sources.size, 2);
  assert.equal((await readdir(root)).filter((name) => name.includes(".tmp-")).length, 0);
  assert.match((await readFile(path, "utf8")), /"writer": "(?:first|second)"/);
});

test("keeps the official checkpoint and recovers a newer completed temp after final lock failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-recovery-"));
  const path = join(root, "state.json");
  await writeFile(path, '{"generation":1}\n', "utf8");
  await utimes(path, new Date(0), new Date(0));

  await assert.rejects(
    writeAtomicJson(path, { generation: 2 }, {
      randomId: () => "recoverable",
      retryDelaysMs: [0, 0],
      sleep: async () => {},
      renameFile: async () => {
        throw Object.assign(new Error("locked"), { code: "EACCES" });
      },
    }),
    (error) => {
      assert.ok(error instanceof AtomicWriteError);
      assert.equal(error.code, "EACCES");
      assert.doesNotMatch(error.message, /state\.json|generation/);
      return true;
    },
  );

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { generation: 1 });
  assert.equal((await readdir(root)).filter((name) => name.startsWith("state.json.tmp-")).length, 1);
  assert.deepEqual(await readAtomicJson(path, (value) => value as { generation: number }), { generation: 2 });
});

test("recognizes the legacy fixed sibling temp left by an older Windows client", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-legacy-"));
  const path = join(root, "state.json");
  await writeFile(path, '{"generation":1}\n', "utf8");
  await utimes(path, new Date(0), new Date(0));
  await writeFile(`${path}.tmp`, '{"generation":2}\n', "utf8");

  assert.deepEqual(await readAtomicJson(path, (value) => value as { generation: number }), { generation: 2 });
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { generation: 1 });
});

test("does not hide an unsupported primary schema behind an older temp", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-schema-"));
  const path = join(root, "state.json");
  const temporary = `${path}.tmp-old`;
  await writeFile(temporary, '{"version":1}\n', "utf8");
  await utimes(temporary, new Date(0), new Date(0));
  await writeFile(path, '{"version":2}\n', "utf8");

  await assert.rejects(
    readAtomicJson(path, (value) => {
      if ((value as { version?: number }).version !== 1) throw new Error("unsupported schema");
      return value;
    }),
    /unsupported schema/,
  );
});

test("does not ignore an unsupported newer completed temp", async () => {
  const root = await mkdtemp(join(tmpdir(), "ncm-atomic-temp-schema-"));
  const path = join(root, "state.json");
  await writeFile(path, '{"version":1}\n', "utf8");
  await utimes(path, new Date(0), new Date(0));
  await writeFile(`${path}.tmp-future`, '{"version":2}\n', "utf8");

  await assert.rejects(
    readAtomicJson(path, (value) => {
      if ((value as { version?: number }).version !== 1) throw new Error("unsupported schema");
      return value;
    }),
    /unsupported schema/,
  );
});
