import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { RunCancelled } from "../src/errors";
import { JsonlSnapshotLimitError } from "../src/jsonl-snapshot";
import { encodeClassicEncryptUin } from "../src/qq-music/classic-encrypt-uin";
import { normalizeUserInput, QQMusicApiError } from "../src/qq-music/client";
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
  assert.equal(first.targetLabel, "QQ 123456789");
  const enrichedFirst = await waitForJob(fixture.manager, (job) => job.targetIdentity?.nickname === "synthetic-profile");
  assert.deepEqual(enrichedFirst.targetIdentity, {
    kind: "qq-number",
    label: "QQ 123456789",
    nickname: "synthetic-profile",
    avatarUrl: "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100",
  });
  assert.equal(fixture.options.length, 1);
  assert.equal(fixture.options[0].target, "canonical-user");
  assert.equal(fixture.options[0].maxWorkers, 8);
  assert.equal(fixture.options[0].workersPerLane, 8);
  assert.equal(first.configuredWorkers, 8);
  assert.equal(fixture.options[0].requestBudget, 0);
  assert.equal(first.minDelayMs, 300);
  assert.equal(first.jitterMs, 100);
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

test("publishes full QQ, WeChat-user, and opaque target presentation without changing canonical task keys", async () => {
  const qq = "123456789012";
  const qqToken = encodeClassicEncryptUin(qq);
  const wxIdentifier = "1150000000000000472";
  const wxToken = encodeClassicEncryptUin(wxIdentifier);
  const opaque = "opaque-user_1234";
  const profileInputs: string[] = [];
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolveUser: async (input) => ({ input, encryptUin: normalizeUserInput(input).value }),
      getPublicUserProfile: async (input) => {
        profileInputs.push(input);
        return {
          input,
          encryptUin: input === qq ? qqToken : input === wxIdentifier ? wxToken : opaque,
          nickname: input === wxIdentifier ? "synthetic-wechat-user" : "synthetic-qq-user",
          avatarUrl: "https://thirdqq.qlogo.cn/synthetic-avatar",
        };
      },
    }),
  });

  const qqJob = await fixture.manager.start({ mode: "likes", target: qqToken, allowDirect: true, minDelayMs: 0, jitterMs: 0 });
  assert.equal(qqJob.targetLabel, `QQ ${qq}`);
  const enrichedQqJob = await waitForJob(fixture.manager, (job) => job.targetIdentity?.nickname === "synthetic-qq-user");
  assert.deepEqual(enrichedQqJob.targetIdentity, {
    kind: "qq-number",
    label: `QQ ${qq}`,
    nickname: "synthetic-qq-user",
    avatarUrl: `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=100`,
  });
  assert.equal(qqJob.generation?.target.value, qqToken);
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  const wxJob = await fixture.manager.start({ mode: "likes", target: wxToken, allowDirect: true, minDelayMs: 0, jitterMs: 0 });
  assert.equal(wxJob.targetLabel, "微信用户");
  assert.deepEqual(wxJob.targetIdentity, { kind: "wechat-user", label: "微信用户" });
  assert.equal(profileInputs.includes(wxIdentifier), false);
  assert.doesNotMatch(wxJob.targetLabel ?? "", /QQ|微信号/);
  assert.equal(wxJob.generation?.target.value, wxToken);
  fixture.finish(reportFor(fixture.options[1]));
  await fixture.settled();

  const opaqueJob = await fixture.manager.start({ mode: "likes", target: opaque, allowDirect: true, minDelayMs: 0, jitterMs: 0 });
  assert.equal(opaqueJob.targetLabel, `EncryptUin ${opaque}`);
  assert.equal(opaqueJob.targetIdentity?.kind, "encrypt-uin");
  const enrichedOpaqueJob = await waitForJob(fixture.manager, (job) => job.targetIdentity?.nickname === "synthetic-qq-user");
  assert.deepEqual(enrichedOpaqueJob.targetIdentity, {
    kind: "encrypt-uin",
    label: `EncryptUin ${opaque}`,
    nickname: "synthetic-qq-user",
    avatarUrl: "https://thirdqq.qlogo.cn/synthetic-avatar",
  });
  assert.equal(profileInputs.includes(opaque), true);
  assert.equal(opaqueJob.generation?.target.value, opaque);
  fixture.finish(reportFor(fixture.options[2]));
  await fixture.settled();

  assert.equal(new Set(fixture.options.map((options) => options.statePath)).size, 3);
});

test("keeps optional QQ profile failure from poisoning the scan lane", async () => {
  const target = "opaque-user_1234";
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolveUser: async (input) => ({ input, encryptUin: target }),
      getPublicUserProfile: async () => {
        throw new QQMusicApiError("synthetic optional profile block", 403, undefined, false);
      },
    }),
  });

  const job = await fixture.manager.start({
    mode: "likes",
    target,
    allowDirect: true,
    minDelayMs: 0,
    jitterMs: 0,
  });
  assert.equal(job.status, "running");
  assert.equal(job.targetLabel, `EncryptUin ${target}`);
  assert.equal(fixture.options.length, 1);
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();
});

test("starts the QQ scanner without waiting for a stalled optional profile", async () => {
  const target = "opaque-user_1234";
  let scannerStarted = false;
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolvesOpaqueLocally: true,
      getPublicUserProfile: async () => new Promise(() => {}),
    }),
    runner: async (_lanes, options) => {
      scannerStarted = true;
      fixture.options.push(options);
      return new Promise<QQMusicScanReport>((resolve) => {
        fixture.finish = resolve;
      });
    },
  });

  const job = await fixture.manager.start({ mode: "likes", target, allowDirect: true });
  assert.equal(job.status, "running");
  assert.equal(job.targetLabel, `EncryptUin ${target}`);
  assert.equal(scannerStarted, true);
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();
});

test("keeps production opaque EncryptUin URLs independent from the classic decoding experiment", async () => {
  const canonicalTarget = "opaque-token_32.segment";
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolveUser: async (input) => {
        const normalized = normalizeUserInput(input);
        return {
          input,
          encryptUin: normalized.kind === "encrypt-uin" ? normalized.value : "resolved-numeric-user",
        };
      },
    }),
  });

  const raw = await fixture.manager.start({ mode: "likes", target: canonicalTarget, allowDirect: true });
  assert.deepEqual(raw.generation?.target, { kind: "encryptUin", value: canonicalTarget });
  const rawPaths = [fixture.options[0].statePath, fixture.options[0].outputPath];
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();

  const profile = await fixture.manager.start({
    mode: "likes",
    target: `https://y.qq.com/n/ryqq_v2/profile?uin=${encodeURIComponent(canonicalTarget)}`,
    allowDirect: true,
  });
  assert.deepEqual(profile.generation?.target, { kind: "encryptUin", value: canonicalTarget });
  assert.deepEqual([fixture.options[1].statePath, fixture.options[1].outputPath], rawPaths);
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
    mode: "likes", target: "canonical-user", workersPerProxy: 1, hostConcurrency: 32,
  });
  assert.equal(likes.configuredWorkers, 32);
  assert.equal(likes.workersPerLane, 4);
  assert.equal(activeOptions?.workersPerLane, 4);
  assert.equal(activeOptions?.maxWorkers, 32);
  assert.equal(likes.proxyTransportMaxConcurrent, 32);
  assert.equal(likes.proxyTransportStartDelayMs, 50);
  finish(reportFor(activeOptions!));
  while (coordinator.isBusy()) await new Promise<void>((resolve) => setImmediate(resolve));

  const song = await manager.start({
    mode: "song", target: "canonical-user", songId: "7", workersPerProxy: 4, hostConcurrency: 32,
  });
  assert.equal(song.configuredWorkers, 1);
  assert.equal(song.proxyTransportMaxConcurrent, 1);
  assert.equal(song.proxyTransportStartDelayMs, 50);
  finish(reportFor(activeOptions!));
  while (coordinator.isBusy()) await new Promise<void>((resolve) => setImmediate(resolve));
});

test("runs the real QQ scanner with all 32 host Workers on one direct Lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-single-lane-host-cap-"));
  const coordinator = new TaskCoordinator();
  const songs = Array.from({ length: 32 }, (_unused, index) => ({
    id: String(index + 1),
    name: `song-${index + 1}`,
  }));
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => fakeClient({
      getLikedSongsPage: async () => ({
        songs,
        hasMore: false,
        nextOffset: songs.length,
        total: songs.length,
      }),
      getNewComments: async () => ({ comments: [], hasMore: false }),
    }),
  });

  const started = await manager.start({
    mode: "likes",
    target: "canonical-user",
    allowDirect: true,
    hostConcurrency: 32,
    minDelayMs: 0,
    jitterMs: 0,
  });
  assert.equal(started.configuredLanes, 1);
  assert.equal(started.configuredWorkers, 32);
  assert.equal(started.workersPerLane, 32);

  while (coordinator.isBusy()) await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const completed = await manager.status();
  assert.equal(completed.status, "complete");
  assert.equal(completed.configuredWorkers, 32);
  assert.equal(completed.participatedWorkers, 32);
  assert.equal(completed.songsProcessed, 32);
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
  for (const target of ["http://[", "https://y.qq.com/n/ryqq/profile/bad$value", "<invalid>"]) {
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
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      resolveUser: async (input) => {
        if (input === "123456789") throw Object.assign(new Error("resolve failed"), { status: 400 });
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

  const songJob = await fixture.manager.start({
    mode: "song",
    target: "canonical-user",
    songId: "7",
    allowDirect: true,
  });
  assert.equal(songJob.status, "running");
  assert.deepEqual(fixture.options[1].songMetadata, {
    id: "7",
    name: "Search Song",
    artists: ["Artist"],
  });
  fixture.finish(reportFor(fixture.options[1]));
  await fixture.settled();
});

test("QQ user and song preflight prefer direct without touching a running proxy pool", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-preflight-direct-"));
  const createdWith: Array<string | undefined> = [];
  const profileInputs: string[] = [];
  let poolReads = 0;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    poolReader: async () => {
      poolReads += 1;
      return {
        version: 1,
        generatedAt: new Date().toISOString(),
        lastCheckedAt: new Date().toISOString(),
        source: "external",
        active: true,
        entries: [{
          name: "managed-lane",
          endpoint: "http://127.0.0.1:18080",
          egressIp: "192.0.2.10",
          latencyMs: 10,
          ncmLatencyMs: 10,
          ncmVerified: true,
        }],
      };
    },
    clientFactory: (proxy) => {
      createdWith.push(proxy);
      return fakeClient({
        getPublicUserProfile: async (input) => {
          profileInputs.push(input);
          return { input, encryptUin: "canonical-user", nickname: "synthetic-preflight" };
        },
        searchSongs: async () => [{ id: "7", name: "Search Song", artists: ["Artist"] }],
      });
    },
  });

  const directProfile = await manager.lookupTarget("123456789", undefined, true, undefined, true);
  assert.deepEqual(
    { ...directProfile, elapsedMs: 0 },
    {
      platform: "qq",
      identity: {
        kind: "qq-number",
        label: "QQ 123456789",
        nickname: "synthetic-preflight",
        avatarUrl: "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100",
      },
      route: "direct",
      routeName: "本机直连",
      routeAttempts: 1,
      elapsedMs: 0,
    },
  );
  assert.equal(Number.isFinite(directProfile.elapsedMs), true);
  assert.deepEqual(
    await manager.searchSongs("search song", 5, undefined, true, undefined, true),
    [{ id: "7", name: "Search Song", artists: ["Artist"] }],
  );
  assert.deepEqual(createdWith, [undefined, undefined]);
  assert.deepEqual(profileInputs, ["123456789"]);
  assert.equal(poolReads, 0);
  assert.equal((await manager.status()).status, "idle");

  const wechat = encodeClassicEncryptUin("1150000000000000472");
  assert.deepEqual(await manager.lookupTarget(wechat, undefined, true, undefined, true), {
    platform: "qq",
    identity: { kind: "wechat-user", label: "微信用户" },
    route: "local",
    routeName: "本地识别",
    routeAttempts: 0,
    elapsedMs: 0,
  });
  assert.deepEqual(createdWith, [undefined, undefined]);
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

test("bounds ordinary QQ lookups to four seconds without changing scanner timeouts", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-search-timeout-"));
  const coordinator = new TaskCoordinator();
  let calls = 0;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    lookupTimeoutMs: 20,
    clientFactory: () => fakeClient({
      searchSongs: async () => {
        calls += 1;
        if (calls === 1) return new Promise(() => {});
        return [{ id: "7", name: "Recovered", artists: [] }];
      },
    }),
  });
  await assert.rejects(
    manager.searchSongs("search song", 10, undefined, true, undefined, true),
    (error) => error instanceof QQJobManagerError
      && error.status === 504
      && /4 秒/.test(error.message),
  );
  assert.equal(coordinator.isBusy(), false);
  assert.deepEqual(
    await manager.searchSongs("search song", 10, undefined, true, undefined, true),
    [{ id: "7", name: "Recovered", artists: [] }],
  );
  assert.equal(coordinator.isBusy(), false);
});

test("resolves bare and official-URL EncryptUin locally without preparing a client", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-encrypt-uin-local-"));
  let clientCreations = 0;
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => {
      clientCreations += 1;
      return fakeClient();
    },
  });
  const encryptUin = encodeClassicEncryptUin("123456789012");
  assert.deepEqual(await manager.resolveClassicEncryptUinInput(encryptUin), {
    inputKind: "raw-encrypt-uin",
    resolution: "local",
    format: "classic-qq-short",
    identityKind: "qq-number-candidate",
    encryptUin,
    identifier: "123456789012",
    maskedIdentifier: "12****12",
  });
  assert.deepEqual(
    await manager.resolveClassicEncryptUinInput(`https://y.qq.com/n/ryqq_v2/profile?uin=${encryptUin}`),
    {
      inputKind: "profile-url-encrypt-uin",
      resolution: "local",
      format: "classic-qq-short",
      identityKind: "qq-number-candidate",
      encryptUin,
      identifier: "123456789012",
      maskedIdentifier: "12****12",
    },
  );
  assert.equal(clientCreations, 0);
});

test("resolves numeric QQ and wxuin candidates through one governed public-profile request", async () => {
  const qqIdentifier = "123456789012";
  const qqEncryptUin = encodeClassicEncryptUin(qqIdentifier);
  const wxIdentifier = "1150000000000000472";
  const wxEncryptUin = encodeClassicEncryptUin(wxIdentifier);
  const requested: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "qq-manager-encrypt-uin-numeric-"));
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (input) => {
        requested.push(input);
        return { input, encryptUin: input === qqIdentifier ? qqEncryptUin : wxEncryptUin };
      },
    }),
  });
  assert.deepEqual(await manager.resolveClassicEncryptUinInput(qqIdentifier, undefined, true), {
    inputKind: "numeric-identifier",
    resolution: "network",
    format: "classic-qq-short",
    identityKind: "qq-number-candidate",
    encryptUin: qqEncryptUin,
    identifier: qqIdentifier,
    maskedIdentifier: "12****12",
  });
  assert.deepEqual(
    await manager.resolveClassicEncryptUinInput(
      `https://y.qq.com/portal/profile.html?uin=${wxIdentifier}`,
      undefined,
      true,
    ),
    {
      inputKind: "profile-url-numeric",
      resolution: "network",
      format: "wechat-28",
      identityKind: "wxuin-candidate",
      encryptUin: wxEncryptUin,
      identifier: wxIdentifier,
      maskedIdentifier: "115***472",
    },
  );
  assert.deepEqual(requested, [qqIdentifier, wxIdentifier]);
});

test("cancels numeric EncryptUin resolution and releases its lookup lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-encrypt-uin-resolve-cancel-"));
  let requestStarted = (): void => {};
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (_input, signal) => {
        requestStarted();
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(new RunCancelled());
          signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
        });
      },
    }),
  });
  const controller = new AbortController();
  const resolution = manager.resolveClassicEncryptUinInput("123456789012", undefined, true, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(resolution, RunCancelled);
  assert.equal(coordinator.isBusy(), false);
});

test("verifies a classic EncryptUin match or mismatch without changing the selected generation", async () => {
  const classicQQ = "123456789012";
  const classicEncryptUin = encodeClassicEncryptUin(classicQQ);
  let profileCalls = 0;
  const fixture = await managerFixture({
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (input) => {
        assert.ok(input === classicEncryptUin || input === classicQQ);
        profileCalls += 1;
        return {
          input,
          encryptUin: profileCalls === 4 ? "different-classic-id" : `  ${classicEncryptUin}  `,
          nickname: "synthetic-profile",
          avatarUrl: profileCalls === 4 ? "https://example.invalid/avatar-b" : "https://example.invalid/avatar-a",
        };
      },
    }),
  });
  const started = await fixture.manager.start({ mode: "likes", target: "canonical-user", allowDirect: true });
  fixture.finish(reportFor(fixture.options[0]));
  await fixture.settled();
  const before = await fixture.manager.status();

  assert.deepEqual(
    await fixture.manager.verifyClassicEncryptUin(classicEncryptUin, undefined, true),
    {
      format: "classic-qq-short",
      identityKind: "qq-number-candidate",
      status: "match",
      maskedIdentifier: "12****12",
      checks: { encryptUin: true, nickname: true, avatar: true },
    },
  );
  assert.deepEqual(
    await fixture.manager.verifyClassicEncryptUin(classicEncryptUin, undefined, true),
    {
      format: "classic-qq-short",
      identityKind: "qq-number-candidate",
      status: "mismatch",
      maskedIdentifier: "12****12",
      checks: { encryptUin: false, nickname: true, avatar: false },
    },
  );
  const after = await fixture.manager.status();
  assert.equal(after.id, started.id);
  assert.deepEqual(after.generation, before.generation);
});

test("verifies a synthetic 28-character WeChat token through both public profile identities", async () => {
  const internalId = "1150000000000000472";
  const encryptUin = "oK6koenzoenzoenzoenzoevloc**";
  const requestedInputs: string[] = [];
  const root = await mkdtemp(join(tmpdir(), "qq-manager-wechat-verify-"));
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (input) => {
        requestedInputs.push(input);
        return {
          input,
          encryptUin,
          nickname: "synthetic-wechat-profile",
          avatarUrl: "https://example.invalid/wechat-avatar",
        };
      },
    }),
  });

  assert.deepEqual(await manager.verifyClassicEncryptUin(encryptUin, undefined, true), {
    format: "wechat-28",
    identityKind: "wxuin-candidate",
    status: "match",
    maskedIdentifier: "115***472",
    checks: { encryptUin: true, nickname: true, avatar: true },
  });
  assert.deepEqual(requestedInputs, [encryptUin, internalId]);
});

test("rejects a malformed upstream EncryptUin during classic online verification", async () => {
  const classicEncryptUin = encodeClassicEncryptUin("123456789012");
  const root = await mkdtemp(join(tmpdir(), "qq-manager-classic-verify-invalid-upstream-"));
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (input) => ({
        input,
        encryptUin: "invalid upstream identity!",
        nickname: "synthetic-profile",
        avatarUrl: "https://example.invalid/avatar",
      }),
    }),
  });

  await assert.rejects(
    manager.verifyClassicEncryptUin(classicEncryptUin, undefined, true),
    (error: unknown) => {
      assert.ok(error instanceof QQJobManagerError);
      assert.equal(error.status, 502);
      assert.match(error.message, /无效的 EncryptUin/);
      assert.doesNotMatch(error.message, /123456789012/);
      return true;
    },
  );
});

test("classifies classic EncryptUin online verification upstream failure without leaking identifiers", async () => {
  const classicQQ = "123456789012";
  const classicEncryptUin = encodeClassicEncryptUin(classicQQ);
  const root = await mkdtemp(join(tmpdir(), "qq-manager-classic-verify-failure-"));
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => fakeClient({
      getPublicUserProfile: async () => {
        throw new QQMusicApiError("synthetic upstream rejection", 400, undefined, false);
      },
    }),
  });

  await assert.rejects(
    manager.verifyClassicEncryptUin(classicEncryptUin, undefined, true),
    (error: unknown) => {
      assert.ok(error instanceof QQJobManagerError);
      assert.equal(error.status, 502);
      assert.match(error.message, /在线验证请求失败/);
      assert.doesNotMatch(error.message, new RegExp(`${classicQQ}|${classicEncryptUin}`));
      return true;
    },
  );
});

test("cancels classic EncryptUin online verification and releases its lookup lease", async () => {
  const classicEncryptUin = encodeClassicEncryptUin("123456789012");
  const root = await mkdtemp(join(tmpdir(), "qq-manager-classic-verify-cancel-"));
  let verificationStarted = (): void => {};
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  const coordinator = new TaskCoordinator();
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator,
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (_input, signal) => {
        verificationStarted();
        return new Promise((_resolve, reject) => {
          if (signal?.aborted) return reject(new RunCancelled());
          signal?.addEventListener("abort", () => reject(new RunCancelled()), { once: true });
        });
      },
    }),
  });
  const controller = new AbortController();
  const verification = manager.verifyClassicEncryptUin(
    classicEncryptUin,
    undefined,
    true,
    controller.signal,
  );
  await started;
  controller.abort();
  await assert.rejects(verification, RunCancelled);
  assert.equal(coordinator.isBusy(), false);
});

test("treats a missing public nickname or avatar as unverifiable instead of mismatch", async () => {
  const classicEncryptUin = encodeClassicEncryptUin("123456789012");
  const root = await mkdtemp(join(tmpdir(), "qq-manager-classic-verify-missing-profile-"));
  const manager = new QQJobManager({
    paths: paths(root),
    coordinator: new TaskCoordinator(),
    clientFactory: () => fakeClient({
      getPublicUserProfile: async (input) => ({ input, encryptUin: classicEncryptUin }),
    }),
  });

  await assert.rejects(
    manager.verifyClassicEncryptUin(classicEncryptUin, undefined, true),
    (error: unknown) => {
      assert.ok(error instanceof QQJobManagerError);
      assert.equal(error.status, 502);
      assert.match(error.message, /缺少可验证的昵称/);
      assert.doesNotMatch(error.message, /123456789012/);
      return true;
    },
  );
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
        if (input !== "123456789") return { input, encryptUin: "canonical-user" };
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

  const replacement = fixture.manager.start({ mode: "likes", target: "123456789", allowDirect: true });
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

test("keeps formal proxy lanes for scanning while canonical target resolution stays direct", async () => {
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
          assert.equal(endpoint, undefined);
          return {
            input,
            encryptUin: "canonical-user",
            nickname: "synthetic-user",
            avatarUrl: "https://example.invalid/avatar",
          };
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
  assert.deepEqual(endpoints, [...entries.map((entry) => entry.endpoint), undefined]);
  finish(reportFor(scanOptions!));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("keeps optional QQ target presentation off the formal proxy lanes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qq-manager-presentation-direct-"));
  const target = "opaque-user_1234";
  const entries = ["lane-a", "lane-b"].map((name, index) => ({
    name,
    endpoint: `http://127.0.0.1:${18180 + index}`,
    egressIp: `198.51.100.${10 + index}`,
    latencyMs: 10,
    ncmLatencyMs: 10,
    ncmVerified: true,
  }));
  const createdEndpoints: Array<string | undefined> = [];
  const profileEndpoints: Array<string | undefined> = [];
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
      createdEndpoints.push(endpoint);
      return fakeClient({
        getPublicUserProfile: async (input) => {
          profileEndpoints.push(endpoint);
          return { input, encryptUin: target, nickname: "direct-profile" };
        },
      });
    },
    runner: async (_lanes, options) => {
      scanOptions = options;
      return new Promise<QQMusicScanReport>((resolve) => { finish = resolve; });
    },
  });

  await manager.start({ mode: "likes", target });
  await waitForJob(manager, (job) => job.targetIdentity?.nickname === "direct-profile");
  assert.deepEqual(createdEndpoints, [...entries.map((entry) => entry.endpoint), undefined]);
  assert.deepEqual(profileEndpoints, [undefined]);
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
    getPublicUserProfile: async (input) => ({
      input,
      encryptUin: "canonical-user",
      nickname: "synthetic-profile",
      avatarUrl: "https://example.invalid/avatar",
    }),
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

async function waitForJob(
  manager: QQJobManager,
  predicate: (job: Awaited<ReturnType<QQJobManager["status"]>>) => boolean,
): Promise<Awaited<ReturnType<QQJobManager["status"]>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await manager.status();
    if (predicate(job)) return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for QQ presentation enrichment.");
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
