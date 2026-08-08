import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { RunCancelled } from "../src/errors";
import { JsonlSnapshotLimitError } from "../src/jsonl-snapshot";
import { QQMusicProxyError } from "../src/qq-music/proxy-fetch";
import {
  QQJobManager,
  QQJobManagerError,
  type QQJobManagerOptions,
} from "../src/qq-job-manager";
import type {
  QQMusicFoundComment,
  QQMusicPlatformClient,
  QQMusicScanOptions,
  QQMusicScanReport,
} from "../src/qq-music/types";
import { TaskCoordinator } from "../src/task-coordinator";

test("resolves a canonical QQ target before deriving stable non-identifying task paths", async () => {
  const fixture = await managerFixture();
  const first = await fixture.manager.start({
    mode: "likes",
    target: "123456789",
    pageSize: 25,
    likedPageSize: 500,
    allowDirect: true,
  });
  assert.equal(first.status, "running");
  assert.deepEqual(first.generation?.target, { kind: "encryptUin", value: "canonical-user" });
  assert.equal(fixture.options.length, 1);
  assert.equal(fixture.options[0].target, "canonical-user");
  assert.equal(fixture.options[0].maxWorkers, 8);
  assert.equal(fixture.options[0].requestBudget, 0);
  assert.doesNotMatch(basename(fixture.options[0].statePath), /canonical|123456789/);
  assert.doesNotMatch(basename(fixture.options[0].outputPath), /canonical|123456789/);

  const firstPaths = [fixture.options[0].statePath, fixture.options[0].outputPath];
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  const second = await fixture.manager.start({
    mode: "likes",
    target: "canonical-user",
    allowDirect: true,
  });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    [fixture.options[1].statePath, fixture.options[1].outputPath],
    firstPaths,
  );
  fixture.finish(reportFor(fixture.options[1]));
  await fixture.settled();
});

test("publishes the actual dynamic QQ transport profile for likes while song stays serial", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-dynamic-gate-"));
  const entries = Array.from({ length: 8 }, (_, index) => ({
    name: `lane-${index + 1}`,
    endpoint: `http://127.0.0.1:${18100 + index}`,
    egressIp: `192.0.2.${index + 1}`,
    latencyMs: 10,
    ncmLatencyMs: 10,
    ncmVerified: true,
  }));
  const coordinator = new TaskCoordinator();
  let finish = (_report: QQMusicScanReport): void => {};
  let activeOptions: QQMusicScanOptions | undefined;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    poolReader: async () => ({
      version: 1, generatedAt: "2000-01-01T00:00:00.000Z", source: "external", active: true, entries,
    }),
    poolVerifier: async () => entries,
    clientFactory: () => fakeClient(),
    runner: async (lanes, options) => {
      assert.equal(lanes.length, 8);
      activeOptions = options;
      return new Promise<QQMusicScanReport>((resolve) => { finish = resolve; });
    },
  });

  const likes = await manager.start({
    mode: "likes", target: "canonical-user", workersPerProxy: 4, hostConcurrency: 32,
  });
  assert.equal(likes.configuredWorkers, 32);
  assert.equal(likes.proxyTransportMaxConcurrent, 32);
  assert.equal(likes.proxyTransportStartDelayMs, 80);
  finish(reportFor(activeOptions!));
  while (coordinator.isBusy()) await new Promise<void>((resolve) => setImmediate(resolve));

  const song = await manager.start({
    mode: "song", target: "canonical-user", songId: "7", workersPerProxy: 4, hostConcurrency: 32,
  });
  assert.equal(song.configuredWorkers, 1);
  assert.equal(song.proxyTransportMaxConcurrent, 1);
  assert.equal(song.proxyTransportStartDelayMs, 250);
  finish(reportFor(activeOptions!));
  while (coordinator.isBusy()) await new Promise<void>((resolve) => setImmediate(resolve));
});

test("rejects malformed QQ user targets before creating lanes or clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-target-input-"));
  const coordinator = new TaskCoordinator();
  let clientCalls = 0;
  let runnerCalls = 0;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => { clientCalls += 1; return fakeClient(); },
    runner: async () => { runnerCalls += 1; throw new Error("scanner must not start"); },
  });
  for (const target of ["http://[", "https://y.qq.com/n/ryqq/profile/not-a-number", "<invalid>"]) {
    await assert.rejects(
      manager.start({ mode: "likes", target, allowDirect: true }),
      (error) => error instanceof QQJobManagerError && error.status === 400,
    );
  }
  assert.equal(clientCalls, 0);
  assert.equal(runnerCalls, 0);
  assert.equal(coordinator.isBusy(), false);
});

test("binds results and match events to the exact QQ job generation", async () => {
  const fixture = await managerFixture();
  const snapshot = await fixture.manager.start({
    mode: "song",
    target: "canonical-user",
    songId: "900719925474099312345",
    allowDirect: true,
  });
  const jobId = snapshot.id!;
  const comment = foundComment();
  await mkdir(join(fixture.options[0].outputPath, ".."), { recursive: true });
  await writeFile(fixture.options[0].outputPath, `${JSON.stringify(comment)}\n`, "utf8");
  const events: unknown[] = [];
  const unsubscribe = fixture.manager.subscribeMatches(jobId, (event) => events.push(event));
  fixture.options[0].onMatch?.(comment);

  const result = await fixture.manager.results(jobId, 10);
  assert.equal(result.generation.jobId, jobId);
  assert.equal(result.generation.mode, "song");
  assert.deepEqual(result.results, [comment]);
  assert.equal((events[0] as { generation: { jobId: string } }).generation.jobId, jobId);
  assert.equal((events[0] as { comment: QQMusicFoundComment }).comment.commentId, comment.commentId);
  assert.throws(
    () => fixture.manager.subscribeMatches("00000000-0000-4000-8000-000000000000", () => {}),
    (error) => error instanceof QQJobManagerError && error.status === 409,
  );
  await assert.rejects(
    fixture.manager.results("00000000-0000-4000-8000-000000000000", 10),
    (error) => error instanceof QQJobManagerError && error.status === 409,
  );
  unsubscribe();
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();
});

test("rejects a report if another generation starts while its JSONL snapshot is being read", async () => {
  let releaseRead = (): void => {};
  let readStarted = (): void => {};
  const reading = new Promise<void>((resolve) => { readStarted = resolve; });
  const blockedRead = new Promise<QQMusicFoundComment[]>((resolve) => { releaseRead = () => resolve([foundComment()]); });
  const fixture = await managerFixture({ reportSnapshotReader: async () => {
    readStarted();
    return blockedRead;
  } });
  const first = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  const reportPromise = fixture.manager.report({
    platform: "qq",
    mode: "likes",
    jobId: first.id!,
    target: { kind: "encryptUin", value: "canonical-user" },
  });
  await reading;
  const second = await fixture.manager.start({ mode: "song", target: "canonical-user", songId: "7", allowDirect: true });
  releaseRead();
  await assert.rejects(
    reportPromise,
    (error) => error instanceof QQJobManagerError && error.status === 409,
  );
  fixture.finish(reportFor(fixture.options[1]));
  await fixture.settled();
  assert.notEqual(second.id, first.id);
});

test("maps an oversized QQ report snapshot to an explicit HTTP 413 manager error", async () => {
  const fixture = await managerFixture({
    reportSnapshotReader: async () => { throw new JsonlSnapshotLimitError("records"); },
  });
  const snapshot = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  await assert.rejects(
    fixture.manager.report(snapshot.generation!),
    (error) => error instanceof QQJobManagerError && error.status === 413,
  );
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();
});

test("stops a QQ task during target resolution and never launches the scanner", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-stop-"));
  let resolving = (): void => {};
  const resolvingStarted = new Promise<void>((resolve) => { resolving = resolve; });
  let runnerCalls = 0;
  const client = fakeClient({
    resolveUser: async (_input, signal) => {
      resolving();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
      });
    },
  });
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => client,
    runner: async () => { runnerCalls += 1; throw new Error("scanner must not start"); },
  });
  const starting = manager.start({ mode: "likes", target: "123456789", allowDirect: true });
  await resolvingStarted;
  assert.equal((await manager.stop()).status, "stopping");
  assert.equal((await starting).status, "stopped");
  assert.equal(runnerCalls, 0);
  assert.equal((await manager.status()).status, "stopped");
});

test("keeps the previous result generation intact when a new startup preflight fails", async () => {
  let resolveCalls = 0;
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolveUser: async (input) => {
        resolveCalls += 1;
        if (resolveCalls > 1) throw Object.assign(new Error("resolve failed"), { status: 400 });
        return { input, encryptUin: "canonical-user" };
      },
    }),
  });
  const first = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  const comment = foundComment();
  await mkdir(join(fixture.options[0].outputPath, ".."), { recursive: true });
  await writeFile(fixture.options[0].outputPath, `${JSON.stringify(comment)}\n`, "utf8");
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  await assert.rejects(
    fixture.manager.start({ mode: "likes", target: "123456789", allowDirect: true }),
    /resolve failed/,
  );
  assert.equal((await fixture.manager.status()).id, first.id);
  assert.deepEqual((await fixture.manager.results(first.id!, 10)).results, [comment]);
});

test("cancels an in-flight song lookup and releases its global QQ lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-lookup-"));
  let lookupStarted = (): void => {};
  const started = new Promise<void>((resolve) => { lookupStarted = resolve; });
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => fakeClient({
      getSongInfo: async (_songId, signal) => {
        lookupStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
        });
      },
    }),
  });
  const lookup = manager.lookupSong("7", undefined, true);
  await started;
  await manager.stop();
  await assert.rejects(lookup, RunCancelled);
  assert.equal(coordinator.isBusy(), false);
});

test("search lookup is generation-independent and leaves completed task results selected", async () => {
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      searchSongs: async () => [{ id: "7", name: "Search Song", artists: ["Artist"] }],
    }),
  });
  const started = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();
  const before = await fixture.manager.status();

  assert.deepEqual(await fixture.manager.searchSongs("search song", 5, undefined, true), [
    { id: "7", name: "Search Song", artists: ["Artist"] },
  ]);
  const after = await fixture.manager.status();
  assert.equal(after.id, started.id);
  assert.deepEqual(after.generation, before.generation);
  assert.equal(after.status, before.status);
});

test("cancels an in-flight QQ song search and releases its global lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-search-cancel-"));
  let searchStarted = (): void => {};
  const started = new Promise<void>((resolve) => { searchStarted = resolve; });
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => fakeClient({
      searchSongs: async (_query, _limit, signal) => {
        searchStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
        });
      },
    }),
  });
  const search = manager.searchSongs("search song", 10, undefined, true);
  await started;
  await manager.stop();
  await assert.rejects(search, RunCancelled);
  assert.equal(coordinator.isBusy(), false);
});

test("rotates failed proxy lanes for QQ song search without creating a direct client", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-search-failclosed-"));
  const entries = ["lane-a", "lane-b"].map((name, index) => ({
    name,
    endpoint: `http://127.0.0.1:${18080 + index}`,
    egressIp: `192.0.2.${10 + index}`,
    latencyMs: 10,
    ncmLatencyMs: 10,
    ncmVerified: true,
  }));
  const endpoints: Array<string | undefined> = [];
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    poolReader: async () => ({
      version: 1, generatedAt: "2000-01-01T00:00:00.000Z", source: "external", active: true, entries,
    }),
    poolVerifier: async () => entries,
    clientFactory: (endpoint) => {
      endpoints.push(endpoint);
      return fakeClient({
        searchSongs: async () => { throw new QQMusicProxyError("CONNECT rejected", 407); },
      });
    },
  });

  await assert.rejects(manager.searchSongs("search song", 10, undefined, true), /CONNECT rejected/);
  assert.deepEqual(endpoints, entries.map((entry) => entry.endpoint));
  assert.equal(endpoints.includes(undefined), false);
  assert.equal(coordinator.isBusy(), false);
});

test("QQ song search requires an explicit safe route when the managed pool is absent", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-search-no-route-"));
  let clients = 0;
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => { clients += 1; return fakeClient(); },
  });
  await assert.rejects(
    manager.searchSongs("search song", 10),
    (error) => error instanceof QQJobManagerError && error.status === 409,
  );
  assert.equal(clients, 0);
  assert.equal(coordinator.isBusy(), false);
});

test("releases startup promptly when stop races a slow proxy-pool verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-pool-stop-"));
  const coordinator = new TaskCoordinator();
  let verificationStarted = (): void => {};
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  let finishVerification = (): void => {};
  const verification = new Promise<never[]>((resolve) => { finishVerification = () => resolve([]); });
  let clientCalls = 0;
  let runnerCalls = 0;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    poolReader: async () => ({
      version: 1,
      generatedAt: "2000-01-01T00:00:00.000Z",
      source: "external",
      active: true,
      entries: [{
        name: "old-lane",
        endpoint: "http://127.0.0.1:18080",
        egressIp: "192.0.2.10",
        latencyMs: 10,
        ncmLatencyMs: 10,
        ncmVerified: false,
      }],
    }),
    poolVerifier: async () => {
      verificationStarted();
      return verification;
    },
    clientFactory: () => { clientCalls += 1; return fakeClient(); },
    runner: async () => { runnerCalls += 1; throw new Error("scanner must not start"); },
  });
  const starting = manager.start({ mode: "likes", target: "canonical-user" });
  await started;
  await manager.stop();
  assert.equal((await starting).status, "stopped");
  assert.equal(coordinator.isBusy(), false);
  assert.equal(clientCalls, 0);
  assert.equal(runnerCalls, 0);
  finishVerification();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(clientCalls, 0);
});

test("keeps an explicitly stopped replacement job instead of jumping back to the old snapshot", async () => {
  let slowResolveStarted = (): void => {};
  const resolving = new Promise<void>((resolve) => { slowResolveStarted = resolve; });
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolveUser: async (input, signal) => {
        if (input !== "slow-user") return { input, encryptUin: "canonical-user" };
        slowResolveStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
        });
      },
    }),
  });
  const first = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  const replacement = fixture.manager.start({ mode: "likes", target: "slow-user", allowDirect: true });
  await resolving;
  await fixture.manager.stop();
  const stopped = await replacement;
  const current = await fixture.manager.status();
  assert.equal(stopped.status, "stopped");
  assert.equal(current.id, stopped.id);
  assert.notEqual(current.id, first.id);
  assert.equal(current.generation, undefined);
});

test("keeps memory state and the resume descriptor on the new generation after a post-write stop", async () => {
  let resumeCalls = 0;
  let secondWritten = (): void => {};
  const written = new Promise<void>((resolve) => { secondWritten = resolve; });
  let releaseSecond = (): void => {};
  const release = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const fixture = await managerFixture({
    resumeWriter: async (path, descriptor) => {
      resumeCalls += 1;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(descriptor), "utf8");
      if (resumeCalls === 2) {
        secondWritten();
        await release;
      }
    },
  });
  const first = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  const replacement = fixture.manager.start({ mode: "song", target: "canonical-user", songId: "7", allowDirect: true });
  await written;
  await fixture.manager.stop();
  releaseSecond();
  const stopped = await replacement;
  const current = await fixture.manager.status();
  const descriptor = JSON.parse(await readFile(fixture.paths.resumeTask, "utf8"));
  assert.equal(stopped.status, "stopped");
  assert.equal(current.id, stopped.id);
  assert.notEqual(current.id, first.id);
  assert.equal(current.generation?.jobId, current.id);
  assert.equal(current.generation?.mode, "song");
  assert.equal(descriptor.mode, "song");
  assert.equal(descriptor.input.songId, "7");
  assert.equal(fixture.options.length, 1);
});

test("keeps activity rows stable, bounded, and present across request failures", async () => {
  const fixture = await managerFixture();
  await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  const callbacks = fixture.options[0];
  callbacks.onRequestActivity?.({
    phase: "start", operation: "comment-page", workerId: "worker-1", lane: "direct",
    songId: "retry-song", songName: "Retry", page: 1, startedAt: "2026-08-08T00:00:00.000Z",
  });
  callbacks.onRequestActivity?.({
    phase: "failure", operation: "comment-page", workerId: "worker-1", lane: "direct",
    songId: "retry-song", songName: "Retry", page: 1, startedAt: "2026-08-08T00:00:00.000Z", error: "failed",
  });
  assert.equal((await fixture.manager.status()).activeSongs.some((song) => song.id === "retry-song"), true);
  callbacks.onSongProgress?.({ songId: "retry-song", pages: 0, comments: 0, done: true, truncated: false });

  callbacks.onSongProgress?.({ songId: "a", pages: 1, comments: 25, done: false, truncated: false });
  callbacks.onSongProgress?.({ songId: "b", pages: 1, comments: 25, done: false, truncated: false });
  callbacks.onSongProgress?.({ songId: "a", pages: 2, comments: 50, done: false, truncated: false });
  for (let index = 0; index < 63; index += 1) {
    callbacks.onSongProgress?.({ songId: `extra-${index}`, pages: 1, comments: 25, done: false, truncated: false });
  }
  const bounded = await fixture.manager.status();
  assert.equal(bounded.activeSongs.length, 64);
  assert.equal(bounded.activeSongs.some((song) => song.id === "a"), false);
  assert.equal(bounded.activeSongs.some((song) => song.id === "b"), true);
  callbacks.onSongProgress?.({ songId: "b", pages: 2, comments: 50, done: true, truncated: false });
  assert.equal((await fixture.manager.status()).activeSongs.some((song) => song.id === "b"), false);
  fixture.finish(reportFor(callbacks));
  await fixture.settled();
});

test("rotates deterministic proxy-lane setup failures without ever falling back to direct", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-control-failover-"));
  const entries = ["lane-a", "lane-b"].map((name, index) => ({
    name,
    endpoint: `http://127.0.0.1:${18080 + index}`,
    egressIp: `192.0.2.${10 + index}`,
    latencyMs: 10,
    ncmLatencyMs: 10,
    ncmVerified: true,
  }));
  const endpoints: Array<string | undefined> = [];
  let scanOptions: QQMusicScanOptions | undefined;
  let finish = (_report: QQMusicScanReport): void => {};
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    poolReader: async () => ({
      version: 1, generatedAt: "2000-01-01T00:00:00.000Z", source: "external", active: true, entries,
    }),
    poolVerifier: async () => entries,
    clientFactory: (endpoint) => {
      endpoints.push(endpoint);
      return fakeClient({
        resolveUser: async (input) => {
          if (endpoint === entries[0].endpoint) throw new QQMusicProxyError("CONNECT rejected", 407);
          return { input, encryptUin: "canonical-user" };
        },
      });
    },
    runner: async (_lanes, options) => {
      scanOptions = options;
      return new Promise<QQMusicScanReport>((resolve) => { finish = resolve; });
    },
  });
  const snapshot = await manager.start({ mode: "likes", target: "123456789" });
  assert.equal(snapshot.status, "running");
  assert.deepEqual(endpoints, entries.map((entry) => entry.endpoint));
  assert.equal(endpoints.includes(undefined), false);
  finish(reportFor(scanOptions!));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("normalizes upstream EncryptUin values and rejects invalid canonical identities before launch", async () => {
  const normalized = await managerFixture({
    clientFactory: () => fakeClient({ resolveUser: async (input) => ({ input, encryptUin: "  canonical-user  " }) }),
  });
  const snapshot = await normalized.manager.start({ mode: "likes", target: "123456789", allowDirect: true });
  assert.equal(snapshot.generation?.target.value, "canonical-user");
  assert.equal(normalized.options[0].target, "canonical-user");
  normalized.finish(reportFor(normalized.options[0]));
  await normalized.settled();

  const invalid = await managerFixture({
    clientFactory: () => fakeClient({ resolveUser: async (input) => ({ input, encryptUin: "<invalid>" }) }),
  });
  await assert.rejects(
    invalid.manager.start({ mode: "likes", target: "123456789", allowDirect: true }),
    (error) => error instanceof QQJobManagerError && error.status === 502,
  );
  assert.equal(invalid.options.length, 0);
});

test("rejects proxy URLs with path or query components before creating clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-proxy-input-"));
  let clients = 0;
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root), coordinator,
    clientFactory: () => { clients += 1; return fakeClient(); },
  });
  await assert.rejects(
    manager.start({ mode: "likes", target: "canonical-user", proxy: "http://127.0.0.1:8080/path?x=1" }),
    (error) => error instanceof QQJobManagerError && error.status === 400,
  );
  assert.equal(clients, 0);
  assert.equal(coordinator.isBusy(), false);
});

test("releases lanes, gates, and the global lease when the scanner throws synchronously", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-sync-runner-"));
  const coordinator = new TaskCoordinator();
  let laneSignal: AbortSignal | undefined;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => fakeClient(),
    runner: (lanes) => {
      laneSignal = lanes[0]?.transportGate.signal;
      throw new Error("synchronous scanner launch failure");
    },
  });
  await assert.rejects(
    manager.start({ mode: "likes", target: "canonical-user", allowDirect: true }),
    /synchronous scanner launch failure/,
  );
  assert.equal(laneSignal?.aborted, true);
  assert.equal(coordinator.isBusy(), false);
  assert.equal((await manager.status()).status, "error");
});

async function managerFixture(overrides: Partial<QQJobManagerOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-"));
  const managerPaths = paths(root);
  const options: QQMusicScanOptions[] = [];
  const coordinator = new TaskCoordinator();
  let resolveRun = (_report: QQMusicScanReport): void => {};
  let activeRun = Promise.resolve();
  const manager = new QQJobManager({
    paths: managerPaths,
    coordinator,
    clientFactory: () => fakeClient(),
    idFactory: sequentialIds(),
    runner: async (_lanes, scanOptions) => {
      options.push(scanOptions);
      const pending = new Promise<QQMusicScanReport>((resolve) => { resolveRun = resolve; });
      activeRun = pending.then(() => undefined);
      return pending;
    },
    ...overrides,
  });
  return {
    manager,
    paths: managerPaths,
    options,
    finish: (report: QQMusicScanReport) => resolveRun(report),
    settled: async () => {
      await activeRun;
      while (coordinator.isBusy()) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function paths(root: string) {
  return {
    data: join(root, "data"),
    pool: join(root, ".ncm", "proxy-pool.json"),
    resumeTask: join(root, "data", "resume-task.json"),
  };
}

function fakeClient(overrides: Partial<QQMusicPlatformClient> = {}): QQMusicPlatformClient {
  return {
    searchSongs: async () => [],
    resolveUser: async (input) => ({ input, encryptUin: "canonical-user" }),
    getSongInfo: async (songId) => ({ id: songId, name: "song" }),
    getLikedSongsPage: async () => ({ songs: [], hasMore: false, nextOffset: 0 }),
    getNewComments: async () => ({ comments: [], hasMore: false }),
    ...overrides,
  };
}

function reportFor(options: QQMusicScanOptions): QQMusicScanReport {
  return {
    status: "complete",
    mode: options.mode,
    targetEncryptUin: options.target,
    songs: options.mode === "song" ? 1 : 0,
    songsComplete: options.mode === "song" ? 1 : 0,
    lanes: 1,
    workers: 1,
    pagesProcessed: 0,
    commentsInspected: 0,
    matches: 0,
    requestsThisRun: 0,
    requestsTotal: 0,
    coverageComplete: true,
    elapsedMs: 1,
    statePath: options.statePath,
    outputPath: options.outputPath,
  };
}

function foundComment(): QQMusicFoundComment {
  return {
    platform: "qq",
    targetEncryptUin: "canonical-user",
    songId: "7",
    commentId: "comment-1",
    seqNo: "10",
    authorEncryptUin: "canonical-user",
    content: "hello",
    capturedAt: "2026-08-08T00:00:00.000Z",
  };
}

function sequentialIds(): () => string {
  let next = 1;
  return () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
