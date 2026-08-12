import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RequestGovernor } from "../src/governor";
import { CooldownRequired, PartialSongCatalogError, SourcePrivacyRestricted } from "../src/errors";
import { createFloorCheckpointBatcher } from "../src/comment-floor";
import { ProxyTransportGate } from "../src/proxy-transport-gate";
import { runCommentFinder, runPooledCommentFinder } from "../src/scanner";
import type {
  CommentPage,
  HistoryPage,
  LoginProfile,
  NcmClient,
  ScanOptions,
  SongCandidate,
} from "../src/types";

class FakeClient implements NcmClient {
  commentCalls: Array<{ songId: string; pageSize: number; pageNo: number; cursor: string }> = [];

  async getLoginProfile(): Promise<LoginProfile | undefined> {
    return undefined;
  }

  async getUserRecord(): Promise<SongCandidate[]> {
    return [
      { id: "1", name: "one", sources: ["record"], sourceRank: 1, playCount: 9 },
      { id: "2", name: "two", sources: ["record"], sourceRank: 2, playCount: 4 },
    ];
  }

  async getLikedSongs(): Promise<SongCandidate[]> {
    return [
      { id: "2", sources: ["likes"], sourceRank: 1 },
      { id: "3", sources: ["likes"], sourceRank: 2 },
    ];
  }

  async getSongComments(songId: string, _limit: number, offset: number): Promise<CommentPage> {
    return { comments: [], hotComments: [], more: false };
  }

  async getSongCommentsByCursor(songId: string, pageSize: number, pageNo: number, cursor: string) {
    this.commentCalls.push({ songId, pageSize, pageNo, cursor });
    if (songId === "1" && pageNo === 1) {
      return {
        comments: [
          { commentId: "c1", userId: "42", content: "first" },
          { commentId: "other", userId: "9", content: "ignore" },
        ],
        hasMore: true,
        nextCursor: "100",
        total: 3,
      };
    }
    if (songId === "1") {
      return {
        comments: [{ commentId: "c2", userId: "42", content: "second" }],
        hasMore: false,
        nextCursor: "90",
        total: 0,
      };
    }
    return { comments: [], hasMore: false };
  }

  async getUserCommentHistory(): Promise<HistoryPage> {
    return { comments: [], hasMore: false };
  }
}

function governor(budget: number): RequestGovernor {
  return new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: budget,
  });
}

test("floor checkpoint batching keeps one forced write in flight without losing concurrent dirty pages", async () => {
  let stateRevision = 0;
  let activeWrites = 0;
  let peakWrites = 0;
  const persistedRevisions: number[] = [];
  const releases: Array<() => void> = [];
  const batcher = createFloorCheckpointBatcher(async (force) => {
    if (!force) return;
    activeWrites += 1;
    peakWrites = Math.max(peakWrites, activeWrites);
    persistedRevisions.push(stateRevision);
    await new Promise<void>((resolve) => releases.push(resolve));
    activeWrites -= 1;
  }, { now: () => 0 });

  const completions = Array.from({ length: 32 }, () => {
    stateRevision += 1;
    return batcher.pageCompleted();
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  assert.deepEqual(persistedRevisions, [4]);
  releases.shift()!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 1);
  assert.deepEqual(persistedRevisions, [4, 32]);
  releases.shift()!();
  await Promise.all(completions);

  assert.equal(peakWrites, 1);
  assert.deepEqual(persistedRevisions, [4, 32]);
});

test("floor checkpoint batching forces the next completed page after 400ms", async () => {
  let now = 0;
  const forcedRevisions: number[] = [];
  let stateRevision = 0;
  const batcher = createFloorCheckpointBatcher(async (force) => {
    if (force) forcedRevisions.push(stateRevision);
  }, { now: () => now });

  for (let index = 0; index < 3; index += 1) {
    stateRevision += 1;
    await batcher.pageCompleted();
  }
  assert.deepEqual(forcedRevisions, []);
  now = 400;
  stateRevision += 1;
  await batcher.pageCompleted();
  assert.deepEqual(forcedRevisions, [4]);
});

test("floor checkpoint batching restores claimed dirty pages after a failed forced write", async () => {
  let stateRevision = 0;
  let forceAttempts = 0;
  const persistedRevisions: number[] = [];
  const batcher = createFloorCheckpointBatcher(async (force) => {
    if (!force) return;
    forceAttempts += 1;
    if (forceAttempts === 1) throw new Error("checkpoint failed");
    persistedRevisions.push(stateRevision);
  }, { now: () => 0 });

  for (let index = 0; index < 3; index += 1) {
    stateRevision += 1;
    await batcher.pageCompleted();
  }
  stateRevision += 1;
  await assert.rejects(batcher.pageCompleted(), /checkpoint failed/);
  stateRevision += 1;
  await batcher.pageCompleted();

  assert.equal(forceAttempts, 2);
  assert.deepEqual(persistedRevisions, [5]);
});

async function options(directory: string): Promise<ScanOptions> {
  return {
    uid: "42",
    strategy: "scan",
    source: "both",
    recordScope: "all",
    commentScope: "root-and-floor-v1",
    statePath: join(directory, "state.json"),
    outputPath: join(directory, "comments.jsonl"),
    commentPageSize: 2,
    historyPageSize: 10,
    maxCommentPagesPerSong: 0,
    maxSongs: 0,
    stopAfterFirst: false,
    fresh: false,
    dryRun: false,
  };
}

test("merges sources, scans in record order, and de-duplicates hot comments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-test-"));
  const client = new FakeClient();
  const config = await options(directory);
  const liveMatches: string[] = [];
  config.onMatch = (comment) => liveMatches.push(comment.commentId);

  const report = await runCommentFinder(client, governor(20), config);

  assert.equal(report.status, "complete");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.songs, 3);
  assert.equal(report.matches, 2);
  assert.equal(report.commentsInspected, 3);
  assert.deepEqual(client.commentCalls.map(({ songId, pageSize, pageNo }) => ({ songId, pageSize, pageNo })), [
    { songId: "1", pageSize: 2, pageNo: 1 },
    { songId: "1", pageSize: 2, pageNo: 2 },
    { songId: "2", pageSize: 2, pageNo: 1 },
    { songId: "3", pageSize: 2, pageNo: 1 },
  ]);
  assert.equal(client.commentCalls[1].cursor, "100");

  const lines = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.commentId), ["c1", "c2"]);
  assert.deepEqual(liveMatches, ["c1", "c2"]);
  assert.deepEqual(records[0].sources, ["record"]);

  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.finished, true);
  assert.equal(state.songIndex, 3);
  assert.equal(state.songProgress[0].totalComments, 3);
});

test("atomically expands comment floors before advancing the root cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-scan-"));
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", name: "nested-song", sources: ["record"] }];
  client.getLikedSongs = async () => [];
  client.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 3 }],
    hasMore: false,
    total: 4,
  });
  const floorTimes: number[] = [];
  client.getCommentFloor = async (_songId, parentCommentId, _limit, time) => {
    floorTimes.push(time);
    return time === -1
      ? {
        parentCommentId,
        comments: [
          { commentId: "reply-1", parentCommentId, userId: "42", content: "first reply" },
          { commentId: "reply-2", parentCommentId, userId: "8", content: "other reply" },
        ],
        hasMore: true,
        nextTime: 10,
        total: 3,
      }
      : {
        parentCommentId,
        comments: [{ commentId: "reply-3", parentCommentId, userId: "42", content: "last reply" }],
        hasMore: false,
        total: 0,
      };
  };
  const config = await options(directory);
  config.source = "record";
  const report = await runCommentFinder(client, governor(20), config);
  assert.equal(report.status, "complete");
  assert.equal(report.commentsInspected, 4);
  assert.equal(report.replyCommentsInspected, 3);
  assert.equal(report.pagesProcessed, 1);
  assert.equal(report.floorPagesProcessed, 2);
  assert.deepEqual(floorTimes, [-1, 10]);
  const records = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.commentId), ["reply-1", "reply-3"]);
  assert.ok(records.every((record) => record.route === "song-comment-floor" && record.parentCommentId === "root"));
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.version, 4);
  assert.equal(state.commentScope, "root-and-floor-v1");
  assert.equal(state.songProgress[0].commentOffset, 1);
  assert.equal(state.songProgress[0].replyCommentsProcessed, 3);
  assert.equal(state.songProgress[0].floorPagesProcessed, 2);
});

test("does not advance a root page when its comment floor is interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-replay-"));
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getLikedSongs = async () => [];
  client.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 1 }],
    hasMore: false,
    total: 2,
  });
  client.getCommentFloor = async () => { throw new Error("floor interrupted"); };
  const config = await options(directory);
  config.source = "record";
  await assert.rejects(runCommentFinder(client, governor(20), config), /floor interrupted/);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress[0].pageInSong, 0);
  assert.equal(state.songProgress[0].commentOffset, 0);
  assert.equal(state.floorPagesProcessed, 0);
});

test("resumes a persisted floor cursor without replaying its first page or duplicating JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-resume-"));
  const config = await options(directory);
  config.source = "record";
  const floorTimes: number[] = [];
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getLikedSongs = async () => [];
  let rootStillVisible = true;
  client.getSongCommentsByCursor = async () => ({
    comments: rootStillVisible
      ? [{ commentId: "root", userId: "9", content: "root", replyCount: 2 }]
      : [{ commentId: "replacement-root", userId: "9", content: "replacement" }],
    hasMore: false,
    total: 3,
  });
  let interruptSecondPage = true;
  client.getCommentFloor = async (_songId, parentCommentId, _limit, time) => {
    floorTimes.push(time);
    if (time === -1) {
      return {
        parentCommentId,
        comments: [{ commentId: "nested-1", parentCommentId, userId: "42", content: "first" }],
        hasMore: true,
        nextTime: 10,
        total: 2,
      };
    }
    if (interruptSecondPage) {
      interruptSecondPage = false;
      throw new Error("second floor page interrupted");
    }
    return {
      parentCommentId,
      comments: [{ commentId: "nested-2", parentCommentId, userId: "42", content: "second" }],
      hasMore: false,
      total: 0,
    };
  };

  await assert.rejects(runCommentFinder(client, governor(20), config), /second floor page interrupted/);
  const paused = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(paused.songProgress[0].pageInSong, 0);
  assert.equal(paused.songProgress[0].floorThreads[0].nextTime, 10);
  assert.equal(paused.songProgress[0].floorThreads[0].pagesProcessed, 1);

  rootStillVisible = false;
  const report = await runCommentFinder(client, governor(20), config);
  assert.equal(report.status, "complete");
  assert.deepEqual(floorTimes, [-1, 10, 10]);
  const records = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.commentId), ["nested-1", "nested-2"]);
  const completed = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(completed.songProgress[0].floorThreads[0].done, true);
  assert.equal(completed.songProgress[0].commentOffset, 1);
  assert.equal(completed.songProgress[0].replyCommentsProcessed, 2);
});

test("stops after the first matching floor page only after its cursor is durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-first-match-"));
  const config = await options(directory);
  config.source = "record";
  config.stopAfterFirst = true;
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getLikedSongs = async () => [];
  client.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 80 }],
    hasMore: false,
    total: 81,
  });
  const floorTimes: number[] = [];
  client.getCommentFloor = async (_songId, parentCommentId, _limit, time) => {
    floorTimes.push(time);
    return {
      parentCommentId,
      comments: [{ commentId: `nested-${time}`, parentCommentId, userId: "42", content: "match" }],
      hasMore: true,
      nextTime: time < 0 ? 10 : time + 10,
      total: 80,
    };
  };

  const report = await runCommentFinder(client, governor(20), config);
  assert.equal(report.status, "paused");
  assert.deepEqual(floorTimes, [-1]);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress[0].floorThreads[0].nextTime, 10);
  assert.equal(state.songProgress[0].floorThreads[0].pagesProcessed, 1);
  assert.equal(state.songProgress[0].floorThreads[0].done, false);
  assert.equal(state.finished, false);
});

test("a one-request serial resume advances a pending floor before refreshing or replaying roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-budget-one-"));
  const config = await options(directory);
  config.source = "record";
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getLikedSongs = async () => [];
  let rootCalls = 0;
  client.getSongCommentsByCursor = async () => {
    rootCalls += 1;
    return {
      comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 2 }],
      hasMore: false,
      total: 3,
    };
  };
  const floorTimes: number[] = [];
  client.getCommentFloor = async (_songId, parentCommentId, _limit, time) => {
    floorTimes.push(time);
    return time === -1
      ? { parentCommentId, comments: [], hasMore: true, nextTime: 10, total: 2 }
      : { parentCommentId, comments: [], hasMore: false, total: 0 };
  };

  assert.equal((await runCommentFinder(client, governor(2), config)).status, "paused");
  assert.deepEqual(floorTimes, []);
  assert.equal((await runCommentFinder(client, governor(1), config)).status, "paused");
  assert.deepEqual(floorTimes, [-1]);
  const afterFirstFloor = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(afterFirstFloor.songProgress[0].floorThreads[0].nextTime, 10);
  assert.equal((await runCommentFinder(client, governor(1), config)).status, "paused");
  assert.deepEqual(floorTimes, [-1, 10]);
  assert.equal(rootCalls, 1);
});

test("a one-request pooled resume globally prioritizes a later song's floor before earlier roots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pooled-floor-budget-one-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  let rootCalls = 0;
  let catalogExpanded = false;
  const floorTimes: number[] = [];
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => catalogExpanded
      ? [{ id: "0", sources: ["record"] }, { id: "1", sources: ["record"] }]
      : [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (songId) => {
      rootCalls += 1;
      if (songId === "0") return { comments: [], hasMore: false, total: 0 };
      return {
        comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 2 }],
        hasMore: false,
        total: 3,
      };
    },
    getCommentFloor: async (_songId, parentCommentId, _limit, time) => {
      floorTimes.push(time);
      return time === -1
        ? { parentCommentId, comments: [], hasMore: true, nextTime: 10, total: 2 }
        : { parentCommentId, comments: [], hasMore: false, total: 0 };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lane = () => ({ name: "lane", client, governor: governor(100) });

  assert.equal((await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1 })).status, "paused");
  const checkpoint = JSON.parse(await readFile(config.statePath, "utf8"));
  checkpoint.songProgress[0].rootDone = true;
  checkpoint.songProgress[0].done = false;
  checkpoint.finished = false;
  checkpoint.songs.unshift({ id: "0", sources: ["record"] });
  checkpoint.songProgress.unshift({
    commentOffset: 0,
    pageInSong: 0,
    commentCursor: String(Date.now()),
    commentPageNo: 1,
    commentEndTime: Date.now(),
    rootDone: false,
    done: false,
    floorThreads: [],
  });
  catalogExpanded = true;
  await writeFile(config.statePath, `${JSON.stringify(checkpoint)}\n`, "utf8");

  config.requestBudget = 1;
  assert.equal((await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1 })).status, "paused");
  assert.deepEqual(floorTimes, [-1]);
  assert.equal(rootCalls, 1);
  assert.equal((await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1 })).status, "paused");
  assert.deepEqual(floorTimes, [-1, 10]);
  assert.equal(rootCalls, 1);

  config.requestBudget = 100;
  const report = await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1 });
  assert.equal(report.status, "complete");
  assert.equal(rootCalls, 2);
});

test("pooled floor-first recovery honors pre-abort and interrupts a pending floor wait", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pooled-floor-abort-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  const calls = { catalog: 0, root: 0, floor: 0 };
  let floorStarted!: () => void;
  const floorRequestStarted = new Promise<void>((resolve) => { floorStarted = resolve; });
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => {
      calls.catalog += 1;
      return [{ id: "1", sources: ["record"] }];
    },
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      calls.root += 1;
      return {
        comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 1 }],
        hasMore: false,
        total: 2,
      };
    },
    getCommentFloor: async () => {
      calls.floor += 1;
      floorStarted();
      return new Promise<never>(() => {});
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lane = () => ({ name: "lane", client, governor: governor(100) });

  assert.equal((await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1 })).status, "paused");
  assert.deepEqual(calls, { catalog: 1, root: 1, floor: 0 });

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.equal((await runPooledCommentFinder([lane()], {
    ...config,
    workersPerLane: 1,
    signal: alreadyAborted.signal,
  })).status, "stopped");
  assert.deepEqual(calls, { catalog: 1, root: 1, floor: 0 });

  const controller = new AbortController();
  const running = runPooledCommentFinder([lane()], {
    ...config,
    workersPerLane: 1,
    signal: controller.signal,
  });
  await floorRequestStarted;
  controller.abort();
  const stopped = await Promise.race([
    running,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("floor abort timed out")), 250)),
  ]);
  assert.equal(stopped.status, "stopped");
  assert.deepEqual(calls, { catalog: 1, root: 1, floor: 1 });
});

test("pooled floor failover spends one logical budget per durable floor page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pooled-floor-budget-failover-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  let rootCalls = 0;
  const seedClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      rootCalls += 1;
      return {
        comments: [{ commentId: "root", userId: "9", content: "root", replyCount: 2 }],
        hasMore: false,
        total: 3,
      };
    },
    getCommentFloor: async () => { throw new Error("seed floor must remain budget-blocked"); },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  assert.equal((await runPooledCommentFinder([{
    name: "seed",
    client: seedClient,
    governor: governor(100),
  }], { ...config, workersPerLane: 1 })).status, "paused");

  const healthyTimes: number[] = [];
  const baseClient = (floor: NcmClient["getCommentFloor"]): NcmClient => ({
    ...seedClient,
    getCommentFloor: floor,
  });
  const cooldownClient = baseClient(async () => { throw new CooldownRequired(429, 60_000); });
  const healthyClient = baseClient(async (_songId, parentCommentId, _limit, time) => {
    healthyTimes.push(time);
    return time === -1
      ? { parentCommentId, comments: [], hasMore: true, nextTime: 10, total: 2 }
      : { parentCommentId, comments: [], hasMore: false, total: 0 };
  });
  config.requestBudget = 2;
  const report = await runPooledCommentFinder([
    { name: "cooldown", client: cooldownClient, governor: governor(100) },
    { name: "healthy", client: healthyClient, governor: governor(100) },
  ], { ...config, workersPerLane: 1, maxWorkers: 2 });

  assert.equal(report.status, "complete");
  assert.deepEqual(healthyTimes, [-1, 10]);
  assert.equal(rootCalls, 1);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress[0].floorThreads[0].done, true);
  assert.equal(state.songProgress[0].rootDone, true);
});

test("root-only source scope never discovers or requests comment floors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-root-only-source-"));
  const config = await options(directory);
  config.source = "record";
  config.commentScope = "root-only-v1";
  config.requestBudget = 10;
  let floorCalls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({
      comments: [{ commentId: "root-target", userId: "42", content: "root", replyCount: 99 }],
      hasMore: false,
      total: 100,
    }),
    getCommentFloor: async () => {
      floorCalls += 1;
      throw new Error("root-only scope must not request floors");
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([{
    name: "direct",
    client,
    governor: governor(100),
  }], { ...config, workersPerLane: 1 });

  assert.equal(report.status, "complete");
  assert.equal(report.floorPagesProcessed, 0);
  assert.equal(floorCalls, 0);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.commentScope, "root-only-v1");
  assert.deepEqual(state.songProgress[0].floorThreads, []);
});

test("pooled floors use multiple lanes across parents while each parent stays single-flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-parallelism-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  const parents = Array.from({ length: 8 }, (_, index) => `parent-${index + 1}`);
  const seedClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({
      comments: parents.map((commentId) => ({ commentId, userId: "9", content: "root", replyCount: 1 })),
      hasMore: false,
      total: parents.length,
    }),
    getCommentFloor: async () => { throw new Error("seed budget must stop before floors"); },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  assert.equal((await runPooledCommentFinder([{
    name: "seed",
    client: seedClient,
    governor: governor(100),
  }], { ...config, workersPerLane: 1 })).status, "paused");

  let active = 0;
  let peak = 0;
  const activeParents = new Set<string>();
  const usedLanes = new Set<string>();
  const starts: Array<{ lane: string; at: number }> = [];
  config.requestBudget = parents.length;
  const transportGate = new ProxyTransportGate({ maxConcurrent: 4, minStartDelayMs: 50 });
  const lanes = Array.from({ length: 4 }, (_, index) => {
    const name = `lane-${index + 1}`;
    const client: NcmClient = {
      ...seedClient,
      getCommentFloor: async (_songId, parentCommentId) => {
        assert.equal(activeParents.has(parentCommentId), false);
        activeParents.add(parentCommentId);
        usedLanes.add(name);
        starts.push({ lane: name, at: Date.now() });
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 260));
        active -= 1;
        activeParents.delete(parentCommentId);
        return { parentCommentId, comments: [], hasMore: false, total: 1 };
      },
    };
    return {
      name,
      client,
      governor: new RequestGovernor({
        minDelayMs: 300,
        jitterMs: 100,
        maxRetries: 0,
        forbiddenCooldownMs: 60_000,
        requestBudget: 100,
      }),
      transportGate,
    };
  });

  const report = await runPooledCommentFinder(lanes, {
    ...config,
    workersPerLane: 1,
    maxWorkers: 4,
  });
  assert.equal(report.status, "complete");
  assert.equal(peak, 4);
  assert.equal(usedLanes.size, 4);
  const orderedStarts = starts.toSorted((left, right) => left.at - right.at);
  for (let index = 1; index < orderedStarts.length; index += 1) {
    assert.ok(orderedStarts[index].at - orderedStarts[index - 1].at >= 45);
  }
  for (const name of usedLanes) {
    const laneStarts = starts.filter((entry) => entry.lane === name).map((entry) => entry.at);
    for (let index = 1; index < laneStarts.length; index += 1) {
      assert.ok(laneStarts[index] - laneStarts[index - 1] >= 290);
    }
  }
});

test("eight exits and 32 workers sustain bounded floor throughput at 300ms plus 100ms jitter", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-eight-lane-throughput-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  const parents = Array.from({ length: 32 }, (_, index) => `parent-${index + 1}`);
  const seedClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({
      comments: parents.map((commentId) => ({ commentId, userId: "9", content: "root", replyCount: 40 })),
      hasMore: false,
      total: parents.length * 41,
    }),
    getCommentFloor: async () => { throw new Error("seed budget must stop before floors"); },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  assert.equal((await runPooledCommentFinder([{
    name: "seed",
    client: seedClient,
    governor: governor(100),
  }], { ...config, workersPerLane: 1 })).status, "paused");

  const responseMs = 200;
  const expectedReplies = parents.length * 40;
  const usedLanes = new Set<string>();
  const activeParents = new Set<string>();
  const starts: Array<{ lane: string; at: number }> = [];
  let active = 0;
  let peak = 0;
  config.requestBudget = parents.length;
  const transportGate = new ProxyTransportGate({ maxConcurrent: 32, minStartDelayMs: 50 });
  const lanes = Array.from({ length: 8 }, (_, index) => {
    const name = `lane-${index + 1}`;
    const client: NcmClient = {
      ...seedClient,
      getCommentFloor: async (_songId, parentCommentId) => {
        assert.equal(activeParents.has(parentCommentId), false);
        activeParents.add(parentCommentId);
        usedLanes.add(name);
        starts.push({ lane: name, at: Date.now() });
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, responseMs));
        active -= 1;
        activeParents.delete(parentCommentId);
        return {
          parentCommentId,
          comments: Array.from({ length: 40 }, (_, replyIndex) => ({
            commentId: `${parentCommentId}-reply-${replyIndex + 1}`,
            parentCommentId,
            userId: "9",
            content: "reply",
          })),
          hasMore: false,
          total: 40,
        };
      },
    };
    return {
      name,
      client,
      governor: new RequestGovernor({
        minDelayMs: 300,
        jitterMs: 100,
        maxRetries: 0,
        forbiddenCooldownMs: 60_000,
        requestBudget: 100,
      }),
      transportGate,
    };
  });

  const startedAt = Date.now();
  const report = await runPooledCommentFinder(lanes, {
    ...config,
    workersPerLane: 4,
    maxWorkers: 32,
  });
  const elapsedMs = Date.now() - startedAt;
  const repliesPerSecond = expectedReplies / (elapsedMs / 1_000);

  assert.equal(report.status, "complete");
  assert.equal(report.lanes, 8);
  assert.equal(report.workers, 32);
  assert.equal(report.floorPagesProcessed, parents.length);
  assert.equal(report.replyCommentsInspected, expectedReplies);
  assert.equal(usedLanes.size, 8);
  assert.ok(peak >= 3, `expected concurrent floor work, observed peak ${peak}`);
  assert.ok(
    repliesPerSecond >= 200,
    `expected at least 200 synthetic full-page replies/s, observed ${repliesPerSecond.toFixed(1)}`,
  );
  const orderedStarts = starts.toSorted((left, right) => left.at - right.at);
  for (let index = 1; index < orderedStarts.length; index += 1) {
    assert.ok(orderedStarts[index].at - orderedStarts[index - 1].at >= 45);
  }
  for (const name of usedLanes) {
    const laneStarts = starts.filter((entry) => entry.lane === name).map((entry) => entry.at);
    for (let index = 1; index < laneStarts.length; index += 1) {
      assert.ok(laneStarts[index] - laneStarts[index - 1] >= 290);
    }
  }
  context.diagnostic(
    `8 exits × 4 workers: ${expectedReplies} synthetic replies in ${elapsedMs}ms (${repliesPerSecond.toFixed(1)} replies/s)`,
  );
});

test("one floor cursor stays serial while successful pages rotate across exits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-lane-rotation-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  const seedClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({
      comments: [{ commentId: "parent", userId: "9", content: "root", replyCount: 4 }],
      hasMore: false,
      total: 5,
    }),
    getCommentFloor: async () => { throw new Error("seed budget must stop before floors"); },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  assert.equal((await runPooledCommentFinder([{
    name: "seed",
    client: seedClient,
    governor: governor(100),
  }], { ...config, workersPerLane: 1 })).status, "paused");

  const calls: Array<{ lane: string; time: number }> = [];
  let active = 0;
  let peak = 0;
  config.requestBudget = 4;
  const lanes = Array.from({ length: 4 }, (_, index) => {
    const name = `lane-${index + 1}`;
    const client: NcmClient = {
      ...seedClient,
      getCommentFloor: async (_songId, parentCommentId, _limit, time) => {
        active += 1;
        peak = Math.max(peak, active);
        calls.push({ lane: name, time });
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        const pageIndex = time === -1 ? 0 : time / 10;
        return {
          parentCommentId,
          comments: [],
          hasMore: pageIndex < 3,
          nextTime: pageIndex < 3 ? (pageIndex + 1) * 10 : undefined,
          total: 4,
        };
      },
    };
    return { name, client, governor: governor(100) };
  });

  const report = await runPooledCommentFinder(lanes, {
    ...config,
    workersPerLane: 1,
    maxWorkers: 4,
  });
  assert.equal(report.status, "complete");
  assert.equal(peak, 1);
  assert.deepEqual(calls.map((call) => call.time), [-1, 10, 20, 30]);
  assert.equal(new Set(calls.map((call) => call.lane)).size, 4);
});

test("pooled root failover reuses one logical page reservation and page-cap slot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pooled-root-budget-failover-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  config.maxCommentPagesPerSong = 1;
  let failedCalls = 0;
  let healthyCalls = 0;
  const baseClient = (): NcmClient => ({
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  });
  const failedClient: NcmClient = {
    ...baseClient(),
    getSongCommentsByCursor: async () => {
      failedCalls += 1;
      throw new Error("lane failed");
    },
  };
  const healthyClient: NcmClient = {
    ...baseClient(),
    getSongCommentsByCursor: async () => {
      healthyCalls += 1;
      return { comments: [], hasMore: false, total: 0 };
    },
  };

  const report = await runPooledCommentFinder([
    { name: "failed", client: failedClient, governor: governor(100) },
    { name: "healthy", client: healthyClient, governor: governor(100) },
  ], { ...config, workersPerLane: 1, maxWorkers: 1 });

  assert.equal(report.status, "complete");
  assert.equal(failedCalls, 1);
  assert.equal(healthyCalls, 1);
  assert.equal(report.pagesProcessed, 1);
});

test("serial request budget counts logical comment pages instead of catalog and retry attempts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-serial-logical-budget-"));
  const config = await options(directory);
  config.source = "record";
  config.requestBudget = 1;
  let rootAttempts = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      rootAttempts += 1;
      if (rootAttempts === 1) throw new Error("retry me");
      return { comments: [], hasMore: false, total: 0 };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const retryingGovernor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 1,
    forbiddenCooldownMs: 60_000,
    requestBudget: 0,
  });

  const report = await runCommentFinder(client, retryingGovernor, config);

  assert.equal(report.status, "complete");
  assert.equal(rootAttempts, 2);
  assert.equal(report.pagesProcessed, 1);
});

test("pooled stop-after-first persists a root match before floors and restarts with zero network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-pooled-root-first-match-"));
  const config = await options(directory);
  config.source = "record";
  config.stopAfterFirst = true;
  const calls = { catalog: 0, root: 0, floor: 0 };
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => {
      calls.catalog += 1;
      return [{ id: "1", sources: ["record"] }];
    },
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      calls.root += 1;
      return {
        comments: [{ commentId: "target-root", userId: "42", content: "match", replyCount: 9_999 }],
        hasMore: false,
        total: 10_000,
      };
    },
    getCommentFloor: async (_songId, parentCommentId) => {
      calls.floor += 1;
      return { parentCommentId, comments: [], hasMore: false, total: 9_999 };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lane = () => ({ name: "lane", client, governor: governor(100) });

  const first = await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1, requestBudget: 100 });
  assert.equal(first.status, "paused");
  assert.deepEqual(calls, { catalog: 1, root: 1, floor: 0 });
  const second = await runPooledCommentFinder([lane()], { ...config, workersPerLane: 1, requestBudget: 100 });
  assert.equal(second.status, "paused");
  assert.deepEqual(calls, { catalog: 1, root: 1, floor: 0 });
});

test("upgrades a root-only v3 checkpoint by rescanning from the song's own end time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-floor-v3-upgrade-"));
  const config = await options(directory);
  config.source = "record";
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getLikedSongs = async () => [];
  let includeFloor = false;
  const requestedCursors: string[] = [];
  client.getSongCommentsByCursor = async (_songId, _pageSize, _pageNo, cursor) => {
    requestedCursors.push(cursor);
    return {
      comments: [{
        commentId: "root",
        userId: "9",
        content: "root",
        replyCount: includeFloor ? 1 : 0,
      }],
      hasMore: false,
      total: includeFloor ? 2 : 1,
    };
  };
  client.getCommentFloor = async (_songId, parentCommentId) => ({
    parentCommentId,
    comments: [{ commentId: "legacy-nested", parentCommentId, userId: "42", content: "nested" }],
    hasMore: false,
    total: 1,
  });

  await runCommentFinder(client, governor(20), config);
  const legacy = JSON.parse(await readFile(config.statePath, "utf8"));
  const songEndTime = 1_900_000_000_000;
  legacy.version = 3;
  delete legacy.commentScope;
  delete legacy.floorPagesProcessed;
  delete legacy.replyCommentsInspected;
  legacy.songProgress[0].commentEndTime = songEndTime;
  delete legacy.songProgress[0].floorPagesProcessed;
  delete legacy.songProgress[0].replyCommentsProcessed;
  delete legacy.songProgress[0].floorThreads;
  await writeFile(config.statePath, `${JSON.stringify(legacy)}\n`, "utf8");

  includeFloor = true;
  const report = await runCommentFinder(client, governor(20), config);
  assert.equal(report.status, "complete");
  assert.equal(requestedCursors.at(-1), String(songEndTime));
  assert.equal(report.replyCommentsInspected, 1);
  const records = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.commentId), ["legacy-nested"]);
  const upgraded = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(upgraded.version, 4);
  assert.equal(upgraded.songProgress[0].floorThreads[0].done, true);
});

test("combines all-time and weekly ranks with likes and user playlists without rescanning duplicate songs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-all-sources-"));
  const client = new FakeClient();
  const recordScopes: string[] = [];
  client.getUserRecord = async (_uid, scope) => {
    recordScopes.push(scope);
    return scope === "all"
      ? [{ id: "1", name: "one", sources: ["record"] }, { id: "2", sources: ["record"] }]
      : [{ id: "2", name: "two", sources: ["record-week"] }, { id: "3", sources: ["record-week"] }];
  };
  client.getLikedSongs = async () => [{ id: "3", sources: ["likes"] }, { id: "4", sources: ["likes"] }];
  client.getTargetUserPlaylistPage = async (_uid, offset) => offset === 0
    ? { playlists: [{ id: "80", name: "public", trackCount: 2 }], more: false, nextOffset: 1 }
    : { playlists: [], more: false, nextOffset: offset };
  client.getTargetUserPlaylistSongs = async () => [
    { id: "4", sources: ["playlists"] },
    { id: "5", sources: ["playlists"] },
  ];
  const config = await options(directory);
  config.source = "all";
  config.recordScope = "both";
  config.dryRun = true;

  const report = await runCommentFinder(client, governor(30), config);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));

  assert.equal(report.status, "dry-run");
  assert.equal(report.songs, 5);
  assert.deepEqual(recordScopes, ["all", "week"]);
  assert.deepEqual(state.songs.map((song: SongCandidate) => ({ id: song.id, sources: song.sources })), [
    { id: "1", sources: ["record"] },
    { id: "2", sources: ["record", "record-week"] },
    { id: "3", sources: ["record-week", "likes"] },
    { id: "4", sources: ["likes", "playlists"] },
    { id: "5", sources: ["playlists"] },
  ]);
  assert.deepEqual(
    state.songs.find((song: SongCandidate) => song.id === "4").memberships.map((item: { source: string }) => item.source),
    ["likes", "playlists"],
  );
});

test("treats a private or absent weekly ranking as optional when all-time ranking succeeded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-empty-week-"));
  const client = new FakeClient();
  client.getUserRecord = async (_uid, scope) => {
    if (scope === "week") throw new SourcePrivacyRestricted("目标用户未公开最近一周听歌排行");
    return [{ id: "1", name: "one", sources: ["record"] }];
  };
  const config = await options(directory);
  config.source = "record";
  config.recordScope = "both";
  config.dryRun = true;

  const report = await runCommentFinder(client, governor(20), config);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));

  assert.equal(report.status, "dry-run");
  assert.equal(report.songs, 1);
  assert.deepEqual(report.sourceErrors, []);
  assert.deepEqual(report.sourceNotices, [
    "听歌排行不可访问：目标用户未公开最近一周听歌排行，本次已跳过该来源。",
  ]);
  assert.equal(report.coverageComplete, false);
  assert.deepEqual(state.songs[0].sources, ["record"]);
});

test("a private listening rank is skipped with a notice instead of failing the task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-private-record-"));
  const client = new FakeClient();
  client.getUserRecord = async () => {
    throw new SourcePrivacyRestricted("目标用户未公开全部时间听歌排行");
  };
  const config = await options(directory);
  config.source = "record";
  config.dryRun = true;

  const report = await runCommentFinder(client, governor(10), config);

  assert.equal(report.status, "dry-run");
  assert.equal(report.songs, 0);
  assert.deepEqual(report.sourceErrors, []);
  assert.deepEqual(report.sourceNotices, [
    "听歌排行不可访问：目标用户未公开全部时间听歌排行，本次已跳过该来源。",
  ]);
  assert.equal(report.coverageComplete, false);
});

test("pooled combined sources keep public songs and turn private likes into a notice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-private-likes-"));
  const client = new FakeClient();
  let likedCalls = 0;
  client.getLikedSongs = async () => {
    likedCalls += 1;
    throw new SourcePrivacyRestricted("目标用户未公开喜欢的音乐");
  };
  const config = await options(directory);
  config.source = "both";
  config.dryRun = true;

  const report = await runPooledCommentFinder([
    { name: "lane-a", client, governor: governor(20) },
    { name: "lane-b", client, governor: governor(20) },
  ], { ...config, workersPerLane: 1, requestBudget: 0 });

  assert.equal(report.status, "dry-run");
  assert.equal(report.songs, 2);
  assert.deepEqual(report.sourceErrors, []);
  assert.deepEqual(report.sourceNotices, [
    "喜欢的音乐不可访问：目标用户未公开该歌单，本次已跳过该来源。",
  ]);
  assert.equal(likedCalls, 1);
  assert.equal(report.coverageComplete, false);
});

test("a fresh source checkpoint counts a rediscovered JSONL match without appending it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-existing-output-"));
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", name: "one", sources: ["record"] }];
  client.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "existing", userId: "42", content: "already persisted" }],
    hasMore: false,
  });
  const config = await options(directory);
  config.source = "record";
  config.fresh = true;
  config.stopAfterFirst = true;
  await writeFile(config.outputPath, `${JSON.stringify({ commentId: "existing" })}\n`, "utf8");

  const report = await runCommentFinder(client, governor(20), config);

  assert.equal(report.status, "paused");
  assert.equal(report.matches, 1);
  assert.equal((await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/).length, 1);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.deepEqual(state.seenCommentIds, ["existing"]);
  assert.equal(state.matchCount, 1);
});

test("pauses on budget and resumes at the exact comment cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-resume-"));
  const client = new FakeClient();
  const config = await options(directory);

  const first = await runCommentFinder(client, governor(3), config);
  assert.equal(first.status, "paused");
  assert.deepEqual(client.commentCalls.map(({ songId, pageNo }) => ({ songId, pageNo })), [{ songId: "1", pageNo: 1 }]);

  const second = await runCommentFinder(client, governor(20), config);
  assert.equal(second.status, "complete");
  assert.deepEqual(client.commentCalls.map(({ songId, pageNo }) => ({ songId, pageNo })), [
    { songId: "1", pageNo: 1 },
    { songId: "1", pageNo: 2 },
    { songId: "2", pageNo: 1 },
    { songId: "3", pageNo: 1 },
  ]);
  assert.equal(client.commentCalls[1].cursor, "100");

  const lines = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
});

test("uses large cursor pages and advances with the server cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-large-page-"));
  const client = new FakeClient();
  const config = await options(directory);
  config.source = "record";
  config.commentPageSize = 1_000;

  const report = await runCommentFinder(client, governor(20), config);

  assert.equal(report.status, "complete");
  assert.ok(client.commentCalls.every((call) => call.pageSize === 1_000));
  assert.deepEqual(client.commentCalls.slice(0, 2).map(({ pageNo, cursor }) => ({ pageNo, cursor })), [
    { pageNo: 1, cursor: client.commentCalls[0].cursor },
    { pageNo: 2, cursor: "100" },
  ]);
  assert.ok(Number(client.commentCalls[0].cursor) > 100);
});

test("migrates an incomplete legacy offset checkpoint without skipping pages or duplicating JSONL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-legacy-state-"));
  const config = await options(directory);
  config.source = "record";
  config.commentPageSize = 1_000;
  const createdAt = "2026-08-01T00:00:00.000Z";
  await writeFile(config.outputPath, `${JSON.stringify({ commentId: "existing" })}\n`, "utf8");
  await writeFile(config.statePath, `${JSON.stringify({
    version: 1,
    uid: config.uid,
    strategy: "scan",
    strategyResolved: true,
    source: config.source,
    recordScope: config.recordScope,
    sourcesLoaded: true,
    songs: [{ id: "1", sources: ["record"] }],
    songProgress: [{ commentOffset: 100, pageInSong: 1, done: true }],
    sourceSongCount: 1,
    sourceTruncated: false,
    sourceErrors: [],
    songIndex: 1,
    commentOffset: 0,
    pageInSong: 0,
    historyTime: 0,
    seenCommentIds: ["existing"],
    matchCount: 1,
    requestCount: 2,
    pagesProcessed: 1,
    truncatedSongIds: ["1"],
    finished: true,
    coverageComplete: false,
    createdAt,
    updatedAt: createdAt,
  }, null, 2)}\n`, "utf8");

  const client = new FakeClient();
  client.getUserRecord = async () => { throw new Error("legacy checkpoint should retain its song list"); };
  client.getSongCommentsByCursor = async (songId, pageSize, pageNo, cursor) => {
    client.commentCalls.push({ songId, pageSize, pageNo, cursor });
    return {
      comments: [
        { commentId: "existing", userId: "42", content: "already stored" },
        { commentId: "new", userId: "42", content: "new match" },
      ],
      hasMore: false,
    };
  };

  const report = await runCommentFinder(client, governor(20), config);

  assert.equal(report.status, "complete");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.matches, 2);
  assert.deepEqual(client.commentCalls, [{
    songId: "1",
    pageSize: 1_000,
    pageNo: 1,
    cursor: String(Date.parse(createdAt)),
  }]);
  const lines = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/);
  assert.deepEqual(lines.map((line) => JSON.parse(line).commentId), ["existing", "new"]);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.commentPagination, "cursor-v1");
  assert.equal(state.commentPageSize, 1_000);
  assert.equal(state.pagesProcessed, 1);
  assert.deepEqual(state.truncatedSongIds, []);
});

test("rejects resuming a cursor checkpoint with a different page size", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-page-size-state-"));
  const firstConfig = await options(directory);
  firstConfig.source = "record";
  firstConfig.commentPageSize = 1_000;
  await runCommentFinder(new FakeClient(), governor(20), firstConfig);

  const changedConfig = { ...firstConfig, commentPageSize: 2_000 };
  await assert.rejects(
    runCommentFinder(new FakeClient(), governor(20), changedConfig),
    /commentPageSize.*--fresh/,
  );
});

test("keeps an invalid server cursor resumable instead of claiming completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-invalid-cursor-"));
  const config = await options(directory);
  config.source = "record";
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getSongCommentsByCursor = async (_songId, _pageSize, _pageNo, cursor) => ({
    comments: [{ commentId: "bad-cursor", userId: "42", content: "not committed" }],
    hasMore: true,
    nextCursor: cursor,
  });

  await assert.rejects(
    runCommentFinder(client, governor(20), config),
    /cursor did not advance/,
  );
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.finished, false);
  assert.equal(state.coverageComplete, false);
  assert.equal(state.songProgress[0].pageInSong, 0);
});

test("continues past an empty cursor page when the server still has more", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-empty-cursor-page-"));
  const config = await options(directory);
  config.source = "record";
  let calls = 0;
  const client = new FakeClient();
  client.getUserRecord = async () => [{ id: "1", sources: ["record"] }];
  client.getSongCommentsByCursor = async (_songId, _pageSize, _pageNo, cursor) => {
    calls += 1;
    return calls === 1
      ? { comments: [], hasMore: true, nextCursor: String(Number(cursor) - 1) }
      : {
          comments: [{ commentId: "after-empty", userId: "42", content: "found later" }],
          hasMore: false,
        };
  };

  const report = await runCommentFinder(client, governor(20), config);
  assert.equal(report.status, "complete");
  assert.equal(report.matches, 1);
  assert.equal(calls, 2);
});

test("auto strategy uses direct history only for the logged-in UID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-history-"));
  const config = await options(directory);
  config.strategy = "auto";
  config.source = "record";
  config.cookie = "MUSIC_U=test";

  let historyCalls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => ({ userId: "42" }),
    getUserRecord: async () => [],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => {
      historyCalls += 1;
      return {
        comments: [{
          commentId: "self-1",
          userId: "42",
          content: "history",
          songId: "99",
        }],
        hasMore: false,
      };
    },
  };

  const report = await runCommentFinder(client, governor(10), config);
  assert.equal(report.strategy, "history");
  assert.equal(report.matches, 1);
  assert.equal(report.commentsInspected, 1);
  assert.equal(report.pagesProcessed, 1);
  assert.equal(historyCalls, 1);
});

test("both mode keeps the available source and reports partial coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-fallback-"));
  const config = await options(directory);
  config.dryRun = true;

  const client = new FakeClient();
  client.getUserRecord = async () => {
    throw { status: 400, body: { code: -2, msg: "private" } };
  };

  const report = await runCommentFinder(client, governor(10), config);
  assert.equal(report.status, "dry-run");
  assert.equal(report.songs, 2);
  assert.equal(report.coverageComplete, false);
  assert.equal(report.sourceErrors.length, 1);
  assert.match(report.sourceErrors[0], /^record:/);
});

test("an initial source failure persists an unloaded catalog instead of a confirmed zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-unloaded-catalog-"));
  const config = await options(directory);
  config.source = "record";
  let lastCheckpoint: Parameters<NonNullable<ScanOptions["onCheckpoint"]>>[0] | undefined;
  config.onCheckpoint = (activity) => { lastCheckpoint = activity; };
  const client = new FakeClient();
  client.getUserRecord = async () => { throw new Error("catalog unavailable"); };

  await assert.rejects(
    runCommentFinder(client, governor(10), config),
    /catalog unavailable/,
  );
  assert.equal(lastCheckpoint?.catalogLoaded, false);
  assert.equal(lastCheckpoint?.catalogSongs, 0);
  const saved = JSON.parse(await readFile(config.statePath, "utf8")) as { sourcesLoaded?: boolean };
  assert.equal(saved.sourcesLoaded, false);
});

test("an empty source list is refreshed on the next normal start without comment requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-empty-"));
  const config = await options(directory);
  config.source = "record";
  let sourceCalls = 0;
  const client = new FakeClient();
  client.getUserRecord = async () => {
    sourceCalls += 1;
    return [];
  };

  const first = await runCommentFinder(client, governor(10), config);
  const second = await runCommentFinder(client, governor(10), config);

  assert.equal(first.status, "complete");
  assert.equal(second.status, "complete");
  assert.equal(sourceCalls, 2);
  assert.deepEqual(client.commentCalls, []);
});

test("persists cooldown when auto strategy login probing receives 403", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-auto-cooldown-"));
  const config = await options(directory);
  config.strategy = "auto";
  config.cookie = "MUSIC_U=test";
  let profileCalls = 0;

  const client = new FakeClient();
  client.getLoginProfile = async () => {
    profileCalls += 1;
    throw { status: 403 };
  };

  const first = await runCommentFinder(client, governor(10), config);
  const second = await runCommentFinder(client, governor(10), config);

  assert.equal(first.status, "cooldown");
  assert.equal(second.status, "cooldown");
  assert.equal(profileCalls, 1);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.strategyResolved, false);
  assert.ok(Date.parse(state.blockedUntil) > Date.now());
});

test("operator stop is checkpointed as a resumable state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-stop-"));
  const config = await options(directory);
  const stoppedGovernor = governor(10);
  stoppedGovernor.cancel();

  const report = await runCommentFinder(new FakeClient(), stoppedGovernor, config);

  assert.equal(report.status, "stopped");
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.finished, false);
  assert.equal(state.requestCount, 0);
});

test("pooled source scan processes songs concurrently across proxy lanes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-pool-"));
  const config = await options(directory);
  config.source = "record";
  config.commentPageSize = 100;
  const activities: Array<{ songId: string; songName?: string; workerId?: string; pageInSong: number; requestingPage?: number; commentsProcessed: number; totalComments?: number; coveragePercent?: number; done?: boolean }> = [];
  const requestActivities: Array<{ phase: string; songId?: string; songName?: string; workerId?: string; startedAt?: string }> = [];
  config.onSongProgress = (activity) => activities.push(activity);
  config.onRequestActivity = (activity) => requestActivities.push(activity);
  const tracker = { active: 0, maxActive: 0, calls: [] as string[] };
  const songs: SongCandidate[] = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1),
    name: `song-${index + 1}`,
    sources: ["record"],
    sourceRank: index + 1,
  }));
  const makeClient = (name: string): NcmClient => ({
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (songId) => {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      tracker.calls.push(`${name}:${songId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracker.active -= 1;
      return {
        comments: songId === "3" ? [{ commentId: "pool-match", userId: "42", content: "found" }] : [],
        hasMore: false,
        total: songId === "3" ? 1 : 0,
      };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  });

  const report = await runPooledCommentFinder([
    { name: "lane-a", client: makeClient("a"), governor: governor(100) },
    { name: "lane-b", client: makeClient("b"), governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(report.status, "complete");
  assert.equal(report.lanes, 2);
  assert.equal(report.workers, 2);
  assert.equal(report.songsProcessed, 4);
  assert.equal(report.pagesProcessed, 4);
  assert.equal(report.matches, 1);
  assert.equal(tracker.maxActive, 2);
  assert.equal(tracker.calls.length, 4);
  assert.ok(tracker.calls.some((call) => call.startsWith("a:")));
  assert.ok(tracker.calls.some((call) => call.startsWith("b:")));
  assert.deepEqual(new Set(activities.map((activity) => activity.songId)), new Set(songs.map((song) => song.id)));
  assert.ok(activities.some((activity) => activity.pageInSong === 0 && activity.requestingPage === 1));
  assert.ok(activities.some((activity) => activity.pageInSong === 1 && activity.requestingPage === undefined));
  assert.ok(activities.every((activity) => /^worker-\d+$/.test(activity.workerId ?? "")));
  assert.ok(activities.some((activity) => activity.songId === "3" && activity.commentsProcessed === 1 && activity.totalComments === 1));
  assert.ok(activities.filter((activity) => activity.done).every((activity) => activity.coveragePercent === 100));
  assert.ok(requestActivities.some((activity) => activity.phase === "start" && activity.songId === "3" && activity.songName === "song-3" && /^worker-\d+$/.test(activity.workerId ?? "")));
  assert.ok(requestActivities.filter((activity) => activity.phase === "start").every((activity) => Number.isFinite(Date.parse(activity.startedAt ?? ""))));
});

test("trailing-publishes a pooled-source page burst while the next request is still running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-live-checkpoints-"));
  const config = await options(directory);
  config.source = "record";
  const songs: SongCandidate[] = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1),
    name: `song-${index + 1}`,
    sources: ["record"],
  }));
  let pageCalls = 0;
  let thirdPageFinished = false;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      pageCalls += 1;
      if (pageCalls === 3) await new Promise((resolve) => setTimeout(resolve, 400));
      if (pageCalls === 3) thirdPageFinished = true;
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const pages: number[] = [];
  let sawBurstBeforeThirdFinished = false;
  config.onCheckpoint = (activity) => {
    pages.push(activity.pagesProcessed);
    if (activity.pagesProcessed === 2 && !thirdPageFinished) sawBurstBeforeThirdFinished = true;
  };

  await runPooledCommentFinder([{
    name: "lane-1",
    client,
    governor: governor(100),
  }], { ...config, workersPerLane: 1, maxWorkers: 1, requestBudget: 100 });

  assert.equal(sawBurstBeforeThirdFinished, true);
  assert.equal(pages.at(-1), 4);
});

test("hydrates unnamed liked songs in a batch when resuming an old pooled checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-metadata-resume-"));
  const config = await options(directory);
  config.source = "likes";
  config.cookie = "session-cookie";
  config.dryRun = true;
  const baseClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => [
      { id: "2", sources: ["likes"], sourceRank: 1 },
      { id: "3", sources: ["likes"], sourceRank: 2 },
    ],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const initial = await runPooledCommentFinder([
    { name: "lane-a", client: baseClient, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });
  assert.equal(initial.status, "dry-run");
  const oldState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.ok(oldState.songs.every((song: SongCandidate) => !song.name));

  const metadataBatches: string[][] = [];
  const catalogs: SongCandidate[][] = [];
  const metadataClient: NcmClient = {
    ...baseClient,
    getLikedSongs: async () => { throw new Error("resume should retain the checkpoint song list"); },
    getSongInfos: async (songIds) => {
      metadataBatches.push([...songIds]);
      return songIds.map((id) => ({ id, name: `name-${id}`, artists: [`artist-${id}`] }));
    },
  };
  config.onSongCatalog = (songs) => catalogs.push(songs.map((song) => ({ ...song })));

  const resumed = await runPooledCommentFinder([
    { name: "lane-a", client: metadataClient, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(resumed.status, "dry-run");
  assert.deepEqual(metadataBatches, [["2", "3"]]);
  const hydratedState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.deepEqual(hydratedState.songs.map((song: SongCandidate) => [song.id, song.name, song.artists]), [
    ["2", "name-2", ["artist-2"]],
    ["3", "name-3", ["artist-3"]],
  ]);
  assert.deepEqual(catalogs.at(-1)?.map((song) => song.name), ["name-2", "name-3"]);
});

test("keeps scanning with an ID fallback when optional song metadata fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-metadata-fallback-"));
  const config = await options(directory);
  config.source = "likes";
  config.cookie = "session-cookie";
  let commentCalls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => [{ id: "4", sources: ["likes"] }],
    getSongInfos: async () => { throw { status: 403 }; },
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([
    { name: "lane-a", client, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(report.status, "complete");
  assert.equal(commentCalls, 1);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songs[0].id, "4");
  assert.equal(state.songs[0].name, undefined);
});

test("serial source scanning also continues after optional song metadata is rate-limited", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-serial-metadata-fallback-"));
  const config = await options(directory);
  config.source = "likes";
  config.cookie = "session-cookie";
  let commentCalls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => [{ id: "serial-song", sources: ["likes"] }],
    getSongInfos: async () => { throw { status: 403 }; },
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runCommentFinder(client, governor(100), config);

  assert.equal(report.status, "complete");
  assert.equal(commentCalls, 1);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songs[0].id, "serial-song");
  assert.equal(state.songs[0].name, undefined);
});

test("checkpoints successful metadata batches when a later pooled batch fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-metadata-partial-checkpoint-"));
  const config = await options(directory);
  config.source = "likes";
  config.cookie = "session-cookie";
  config.dryRun = true;
  const songs = Array.from({ length: 501 }, (_, index) => ({
    id: String(index + 1),
    sources: ["likes" as const],
  }));
  let metadataCalls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => songs,
    getSongInfos: async (songIds) => {
      metadataCalls += 1;
      if (metadataCalls === 2) throw new Error("second metadata batch failed");
      return songIds.map((id) => ({ id, name: `name-${id}` }));
    },
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([
    { name: "lane-a", client, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(report.status, "dry-run");
  assert.equal(metadataCalls, 2);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songs.filter((song: SongCandidate) => Boolean(song.name)).length, 500);
  assert.equal(state.songs[0].name, "name-1");
  assert.equal(state.songs[500].name, undefined);
});

test("pooled metadata hydration skips a lane after its optional cooldown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-metadata-lane-session-"));
  const config = await options(directory);
  config.source = "likes";
  config.cookie = "session-cookie";
  config.dryRun = true;
  const songs = Array.from({ length: 1_001 }, (_, index) => ({
    id: String(index + 1),
    sources: ["likes" as const],
  }));
  let blockedMetadataCalls = 0;
  let healthyMetadataCalls = 0;
  const baseClient: Omit<NcmClient, "getSongInfos"> = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => songs,
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const blockedClient: NcmClient = {
    ...baseClient,
    getSongInfos: async () => {
      blockedMetadataCalls += 1;
      throw { status: 429 };
    },
  };
  const healthyClient: NcmClient = {
    ...baseClient,
    getSongInfos: async (songIds) => {
      healthyMetadataCalls += 1;
      return songIds.map((id) => ({ id, name: `name-${id}` }));
    },
  };

  const report = await runPooledCommentFinder([
    { name: "lane-blocked", client: blockedClient, governor: governor(100) },
    { name: "lane-healthy", client: healthyClient, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(report.status, "dry-run");
  assert.equal(blockedMetadataCalls, 1);
  assert.equal(healthyMetadataCalls, 3);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songs.filter((song: SongCandidate) => Boolean(song.name)).length, 1_001);
});

test("pooled liked-song discovery stops after the first authentication failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-auth-required-"));
  const config = await options(directory);
  config.source = "likes";
  config.cookie = "expired-cookie";
  let calls = 0;
  const makeClient = (): NcmClient => ({
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => {
      calls += 1;
      throw { status: 301, body: { code: 301 } };
    },
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  });

  await assert.rejects(
    runPooledCommentFinder([
      { name: "lane-a", client: makeClient(), governor: governor(100) },
      { name: "lane-b", client: makeClient(), governor: governor(100) },
    ], { ...config, workersPerLane: 1, requestBudget: 100 }),
    /二维码登录/,
  );
  assert.equal(calls, 1);
});

test("pooled source scan uses multiple workers on one proxy lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-workers-"));
  const config = await options(directory);
  config.source = "record";
  const tracker = { active: 0, maxActive: 0 };
  const songs: SongCandidate[] = Array.from({ length: 4 }, (_, index) => ({
    id: String(index + 1),
    sources: ["record"],
  }));
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracker.active -= 1;
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([
    { name: "lane-a", client, governor: governor(100) },
  ], { ...config, workersPerLane: 2, requestBudget: 100 });

  assert.equal(report.status, "complete");
  assert.equal(report.lanes, 1);
  assert.equal(report.workers, 2);
  assert.equal(report.pagesProcessed, 4);
  assert.equal(tracker.maxActive, 2);
});

test("hard-caps an eighteen-worker source topology at the host worker limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-eighteen-workers-"));
  const config = await options(directory);
  config.source = "record";
  const songs: SongCandidate[] = Array.from({ length: 24 }, (_, index) => ({
    id: String(index + 1),
    name: `song-${index + 1}`,
    sources: ["record"],
  }));
  const tracker = { active: 0, maxActive: 0, maxDistinctSongs: 0 };
  const activeSongsByWorker = new Map<string, string>();
  const usedLanes = new Set<string>();
  config.onRequestActivity = (activity) => {
    if (!activity.workerId) return;
    if (activity.phase === "start") {
      activeSongsByWorker.set(activity.workerId, activity.songId);
      usedLanes.add(activity.lane);
    }
    else activeSongsByWorker.delete(activity.workerId);
    tracker.maxDistinctSongs = Math.max(tracker.maxDistinctSongs, new Set(activeSongsByWorker.values()).size);
  };
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      tracker.active -= 1;
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lanes = Array.from({ length: 6 }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: new RequestGovernor({
      minDelayMs: 0,
      jitterMs: 0,
      concurrency: 3,
      maxRetries: 0,
      forbiddenCooldownMs: 60_000,
      requestBudget: 100,
    }),
  }));

  const report = await runPooledCommentFinder(lanes, {
    ...config,
    workersPerLane: 3,
    maxWorkers: 4,
    requestBudget: 100,
  });

  assert.equal(report.status, "complete");
  assert.equal(report.lanes, 6);
  assert.equal(report.workers, 4);
  assert.equal(tracker.maxActive, 4);
  assert.equal(tracker.maxDistinctSongs, 4);
  assert.deepEqual(usedLanes, new Set(lanes.map((lane) => lane.name)));
});

test("governs target liked-playlist discovery and track loading as separate requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-target-likes-governor-"));
  const config = await options(directory);
  config.source = "likes";
  config.dryRun = true;
  const calls: string[] = [];
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => { throw new Error("two-step target path should be used"); },
    getTargetLikedPlaylist: async (uid) => { calls.push(`playlist:${uid}`); return { id: "9", trackCount: 1 }; },
    getTargetLikedPlaylistSongs: async (uid, playlist) => {
      calls.push(`tracks:${uid}:${playlist.id}`);
      return [{ id: "song-1", sources: ["likes"] }];
    },
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const report = await runPooledCommentFinder([{
    name: "lane-1",
    client,
    governor: governor(20),
  }], { ...config, workersPerLane: 1, maxWorkers: 1, requestBudget: 20 });
  assert.equal(report.status, "dry-run");
  assert.equal(report.requestsThisRun, 2);
  assert.deepEqual(calls, ["playlist:42", "tracks:42:9"]);
});

test("pooled discovery scans an accessible partial liked catalog without retrying other lanes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-partial-likes-"));
  const config = await options(directory);
  config.source = "likes";
  config.dryRun = true;
  const catalogActivity: Array<{ message: string; requestsUsed: number }> = [];
  config.onCatalogActivity = (activity) => catalogActivity.push(activity);
  let playlistCalls = 0;
  let trackCalls = 0;
  const client = new FakeClient();
  client.getTargetLikedPlaylist = async () => {
    playlistCalls += 1;
    return { id: "9", trackCount: 3 };
  };
  client.getTargetLikedPlaylistSongs = async () => {
    trackCalls += 1;
    throw new PartialSongCatalogError<SongCandidate>([
      { id: "101", sources: ["likes"], sourceRank: 1 },
      { id: "102", sources: ["likes"], sourceRank: 2 },
    ], 3, 1, "喜欢歌曲目录仅返回 2 / 3 首可访问歌曲；缺少的 1 首当前不可见。");
  };
  const lanes = Array.from({ length: 8 }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: governor(20),
  }));

  const report = await runPooledCommentFinder(lanes, {
    ...config,
    workersPerLane: 1,
    maxWorkers: 8,
    requestBudget: 20,
  });

  assert.equal(report.status, "dry-run");
  assert.equal(report.songs, 2);
  assert.equal(report.requestsThisRun, 2);
  assert.equal(report.coverageComplete, false);
  assert.deepEqual(report.sourceErrors, []);
  assert.deepEqual(report.sourceNotices, ["喜欢歌曲目录仅返回 2 / 3 首可访问歌曲；缺少的 1 首当前不可见。"]);
  assert.equal(playlistCalls, 1);
  assert.equal(trackCalls, 1, "deterministic partial catalogs must not retry or rotate lanes");
  assert.deepEqual(catalogActivity, [
    { message: "正在读取目标用户的喜欢歌曲目录…", requestsUsed: 0 },
    { message: "歌曲目录读取完成，正在准备评论扫描…", requestsUsed: 2 },
  ]);
});

test("pre-shards twelve songs across all eighteen workers and every selected exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-fill-host-capacity-"));
  const config = await options(directory);
  config.source = "record";
  const songs: SongCandidate[] = Array.from({ length: 12 }, (_, index) => ({
    id: String(index + 1),
    name: `song-${index + 1}`,
    sources: ["record"],
  }));
  const activeSongsByWorker = new Map<string, string>();
  const usedLanes = new Set<string>();
  let maxActiveWorkers = 0;
  let maxWorkersOnOneSong = 0;
  config.onRequestActivity = (activity) => {
    if (!activity.workerId) return;
    if (activity.phase === "start") {
      activeSongsByWorker.set(activity.workerId, activity.songId);
      usedLanes.add(activity.lane);
    } else {
      activeSongsByWorker.delete(activity.workerId);
    }
    maxActiveWorkers = Math.max(maxActiveWorkers, activeSongsByWorker.size);
    const workersBySong = new Map<string, number>();
    for (const songId of activeSongsByWorker.values()) {
      workersBySong.set(songId, (workersBySong.get(songId) ?? 0) + 1);
    }
    maxWorkersOnOneSong = Math.max(maxWorkersOnOneSong, ...workersBySong.values(), 0);
  };
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lanes = Array.from({ length: 6 }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: new RequestGovernor({
      minDelayMs: 0,
      jitterMs: 0,
      concurrency: 3,
      maxRetries: 0,
      forbiddenCooldownMs: 60_000,
      requestBudget: 100,
    }),
  }));

  const report = await runPooledCommentFinder(lanes, {
    ...config,
    workersPerLane: 3,
    requestBudget: 100,
  });

  assert.equal(report.status, "complete");
  assert.equal(report.workers, 18);
  assert.equal(maxActiveWorkers, 18);
  assert.ok(maxWorkersOnOneSong >= 2);
  assert.deepEqual(usedLanes, new Set(lanes.map((lane) => lane.name)));
});

test("does not publish a successful pooled page before its cursor is validated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-pooled-invalid-cursor-"));
  const config = await options(directory);
  config.source = "record";
  const requestPhases: string[] = [];
  config.onRequestActivity = (activity) => requestPhases.push(activity.phase);
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "1", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, _pageNo, cursor) => ({
      comments: [{ commentId: "invalid-cursor", userId: "9", content: "not accepted" }],
      hasMore: true,
      nextCursor: cursor,
    }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  await assert.rejects(
    runPooledCommentFinder([{
      name: "lane-1",
      client,
      governor: governor(100),
    }], { ...config, workersPerLane: 1, requestBudget: 100 }),
    /cursor did not advance/,
  );
  assert.deepEqual(requestPhases, ["start", "failure"]);
});

test("a late concurrent success revives a source lane after clustered failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-late-lane-success-"));
  const config = await options(directory);
  config.source = "record";
  const songs: SongCandidate[] = Array.from({ length: 6 }, (_, index) => ({
    id: String(index + 1),
    name: `song-${index + 1}`,
    sources: ["record"],
  }));
  let calls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
      const call = ++calls;
      if (call <= 5) throw { status: 502, body: { code: 502 } };
      if (call === 6) await new Promise((resolve) => setTimeout(resolve, 30));
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([{
    name: "recovering",
    client,
    governor: governor(100),
  }], { ...config, workersPerLane: 6, requestBudget: 100 });

  assert.equal(report.status, "complete");
  assert.equal(report.songsProcessed, 6);
  assert.ok(calls >= 11);
  assert.doesNotMatch(report.note ?? "", /连续网络失败/);
});

test("pooled source scan pre-shards one song across all waiting proxy lanes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-one-song-pool-"));
  const config = await options(directory);
  config.source = "record";
  const activities: Array<{ done?: boolean; coveragePercent?: number }> = [];
  config.onSongProgress = (activity) => activities.push(activity);
  const tracker = { active: 0, maxActive: 0, calls: [] as Array<{ pageNo: number; cursor: string }> };
  const makeClient = (): NcmClient => ({
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", name: "only", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, pageNo, cursor) => {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      tracker.calls.push({ pageNo, cursor });
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracker.active -= 1;
      return {
        comments: [{
          commentId: `match-${cursor}`,
          userId: "42",
          content: "found",
          time: Number(cursor) - 1,
        }],
        hasMore: false,
        total: 3,
      };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  });

  const report = await runPooledCommentFinder([
    { name: "lane-a", client: makeClient(), governor: governor(100) },
    { name: "lane-b", client: makeClient(), governor: governor(100) },
    { name: "lane-c", client: makeClient(), governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(report.status, "complete");
  assert.equal(report.songsProcessed, 1);
  assert.equal(report.pagesProcessed, 3);
  assert.equal(report.matches, 3);
  assert.equal(tracker.maxActive, 3);
  assert.equal(tracker.calls.length, 3);
  assert.equal(tracker.calls.filter((call) => call.pageNo === 2).length, 3);
  assert.equal(tracker.calls.filter((call) => call.pageNo === 1).length, 0);
  assert.equal(new Set(tracker.calls.map((call) => call.cursor)).size, 3);
  assert.equal(activities.at(-1)?.done, true);
  assert.equal(activities.at(-1)?.coveragePercent, 100);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress[0].commentShards.length, 3);
  assert.ok(state.songProgress[0].commentShards.every((shard: { done: boolean }) => shard.done));
});

test("a resumed source scan expands existing shards to the new transport capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-resume-expand-shards-"));
  const config = await options(directory);
  config.source = "record";
  let active = 0;
  let maxActive = 0;
  const pageNos: number[] = [];
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", name: "only", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, pageNo) => {
      pageNos.push(pageNo);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lanes = (count: number) => Array.from({ length: count }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: governor(100),
  }));

  const paused = await runPooledCommentFinder(lanes(3), { ...config, workersPerLane: 1, requestBudget: 1 });
  assert.equal(paused.status, "paused");
  const pausedState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(pausedState.songProgress[0].commentShards.length, 3);
  assert.equal(pausedState.songProgress[0].commentShards.filter((shard: { done: boolean }) => !shard.done).length, 2);
  for (const shard of pausedState.songProgress[0].commentShards) {
    if (!shard.done) shard.pageNo = 1;
  }
  await writeFile(config.statePath, `${JSON.stringify(pausedState)}\n`, "utf8");

  maxActive = 0;
  pageNos.length = 0;
  const completed = await runPooledCommentFinder(lanes(5), { ...config, workersPerLane: 1, requestBudget: 100 });
  assert.equal(completed.status, "complete");
  assert.equal(maxActive, 5);
  assert.ok(pageNos.every((pageNo) => pageNo >= 2));
  assert.ok(pageNos.includes(2), "newly split cursor chains restart with non-first-page semantics");
  const completedState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(completedState.songProgress[0].commentShards.length, 6);
  assert.ok(completedState.songProgress[0].commentShards.every((shard: { done: boolean }) => shard.done));
  assert.ok(completedState.songProgress[0].commentShards.every((shard: { pageNo: number }) => shard.pageNo >= 2));
});

test("a legacy explicit-cursor shard resumes with non-first-page semantics without capacity expansion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-resume-legacy-page-one-"));
  const config = await options(directory);
  config.source = "record";
  const pageNos: number[] = [];
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, pageNo) => {
      pageNos.push(pageNo);
      return { comments: [], hasMore: false };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lanes = (count: number) => Array.from({ length: count }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: governor(100),
  }));

  const paused = await runPooledCommentFinder(lanes(2), { ...config, workersPerLane: 1, requestBudget: 1 });
  assert.equal(paused.status, "paused");
  const legacy = JSON.parse(await readFile(config.statePath, "utf8"));
  const unfinished = legacy.songProgress[0].commentShards.filter((shard: { done: boolean }) => !shard.done);
  assert.equal(unfinished.length, 1);
  for (const shard of unfinished) shard.pageNo = 1;
  await writeFile(config.statePath, `${JSON.stringify(legacy)}\n`, "utf8");

  pageNos.length = 0;
  const completed = await runPooledCommentFinder(lanes(2), { ...config, workersPerLane: 1, requestBudget: 100 });
  assert.equal(completed.status, "complete");
  assert.deepEqual(pageNos.sort(), [2, 2]);
  const migrated = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.ok(migrated.songProgress[0].commentShards.every((shard: { pageNo: number }) => shard.pageNo >= 2));
});

test("a song added to an old checkpoint keeps its own immutable time-coverage upper bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-new-song-coverage-bound-"));
  const config = await options(directory);
  config.source = "record";
  const initialClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "old-song", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  assert.equal((await runCommentFinder(initialClient, governor(10), config)).status, "complete");
  const oldState = JSON.parse(await readFile(config.statePath, "utf8"));
  oldState.createdAt = new Date(Date.UTC(2020, 0, 1)).toISOString();
  await writeFile(config.statePath, `${JSON.stringify(oldState)}\n`, "utf8");

  const activities: Array<{ songId: string; coveragePercent?: number; done?: boolean }> = [];
  config.onSongProgress = (activity) => activities.push(activity);
  let requestedCursor = "";
  const refreshedClient: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [
      { id: "old-song", sources: ["record"] },
      { id: "new-song", sources: ["record"], publishTime: Date.UTC(2022, 0, 1) },
    ],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (songId, _pageSize, _pageNo, cursor) => {
      assert.equal(songId, "new-song");
      requestedCursor = cursor;
      return {
        comments: [{ commentId: "other", userId: "9", content: "other", time: Date.UTC(2023, 0, 1) + 1 }],
        hasMore: true,
        nextCursor: String(Date.UTC(2023, 0, 1)),
      };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const paused = await runCommentFinder(refreshedClient, governor(2), config);
  assert.equal(paused.status, "paused");
  const newSongActivity = activities.filter((activity) => activity.songId === "new-song").at(-1);
  assert.ok((newSongActivity?.coveragePercent ?? 0) > 0);
  assert.ok((newSongActivity?.coveragePercent ?? 100) < 100);
  const pausedState = JSON.parse(await readFile(config.statePath, "utf8"));
  const newSongIndex = pausedState.songs.findIndex((song: { id: string }) => song.id === "new-song");
  assert.equal(pausedState.songProgress[newSongIndex].commentEndTime, Number(requestedCursor));
  assert.equal(pausedState.songProgress[newSongIndex].coverageStartTime, Date.UTC(2022, 0, 1));
  assert.ok(pausedState.songProgress[newSongIndex].commentEndTime > Date.parse(pausedState.createdAt));
});

test("pooled source shard scheduling keeps the per-song page cap exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-one-song-cap-"));
  const config = await options(directory);
  config.source = "record";
  config.maxCommentPagesPerSong = 2;
  const activities: Array<{ done?: boolean; truncated?: boolean; coveragePercent?: number }> = [];
  config.onSongProgress = (activity) => activities.push(activity);
  let calls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, _pageNo, cursor) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        comments: [{ commentId: "other", userId: "9", content: "other", time: Number(cursor) - 1 }],
        hasMore: true,
        nextCursor: String(Number(cursor) - 2),
      };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([
    { name: "lane-a", client, governor: governor(100) },
    { name: "lane-b", client, governor: governor(100) },
    { name: "lane-c", client, governor: governor(100) },
    { name: "lane-d", client, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(calls, 2);
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.coverageComplete, false);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.deepEqual(state.truncatedSongIds, ["only-song"]);
  assert.equal(activities.at(-1)?.done, true);
  assert.equal(activities.at(-1)?.truncated, true);
  assert.equal(activities.at(-1)?.coveragePercent, undefined);
});

test("a song that naturally ends on its page cap is not marked truncated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-natural-cap-end-"));
  const config = await options(directory);
  config.source = "record";
  config.maxCommentPagesPerSong = 1;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({ comments: [], hasMore: false }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };

  const report = await runPooledCommentFinder([
    { name: "lane-a", client, governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(report.status, "complete");
  assert.equal(report.pagesProcessed, 1);
  assert.equal(report.coverageComplete, true);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.deepEqual(state.truncatedSongIds, []);
  assert.equal(state.songProgress[0].done, true);
});

test("a serial source scan resumes unfinished one-song shards without restarting completed ranges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-one-song-resume-"));
  const config = await options(directory);
  config.source = "record";
  const calls: string[] = [];
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, pageNo, cursor) => {
      calls.push(`${pageNo}:${cursor}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        comments: [{ commentId: `match-${cursor}`, userId: "42", content: "found", time: Number(cursor) - 1 }],
        hasMore: false,
      };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lanes = () => ["a", "b", "c"].map((name) => ({ name, client, governor: governor(100) }));

  const paused = await runPooledCommentFinder(lanes(), { ...config, workersPerLane: 1, requestBudget: 2 });
  assert.equal(paused.status, "paused");
  const afterPause = JSON.parse(await readFile(config.statePath, "utf8"));
  const completedShards = afterPause.songProgress[0].commentShards.filter((shard: { done: boolean }) => shard.done);
  assert.equal(completedShards.length, 2);
  const completedCursors = new Set(completedShards.map((shard: { endTime: number }) => String(shard.endTime)));
  const callsAtPause = calls.length;

  const completed = await runCommentFinder(client, governor(100), config);
  assert.equal(completed.status, "complete");
  assert.equal(completed.pagesProcessed, 3);
  assert.equal(completed.matches, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.slice(callsAtPause).every((call) => !completedCursors.has(call.split(":")[1])));
  const finalState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.ok(finalState.songProgress[0].commentShards.every((shard: { done: boolean }) => shard.done));
});

test("a failed in-flight shard releases its page permit without prematurely truncating the song", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-shard-cap-failure-"));
  const config = await options(directory);
  config.source = "record";
  let shardAttempts = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, _pageNo, cursor) => {
      shardAttempts += 1;
      if (shardAttempts === 1) throw new Error("temporary proxy failure");
      return {
        comments: [{ commentId: "success", userId: "9", content: "other", time: Number(cursor) - 1 }],
        hasMore: true,
        nextCursor: String(Number(cursor) - 2),
      };
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const lanes = () => ["a", "b", "c"].map((name) => ({ name, client, governor: governor(100) }));

  const prepared = await runPooledCommentFinder(lanes(), { ...config, workersPerLane: 1, requestBudget: 2 });
  assert.equal(prepared.status, "paused");
  config.maxCommentPagesPerSong = 2;
  const completed = await runPooledCommentFinder(lanes(), { ...config, workersPerLane: 1, requestBudget: 100 });

  assert.equal(shardAttempts, 3);
  assert.equal(completed.pagesProcessed, 2);
  assert.equal(completed.coverageComplete, false);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.deepEqual(state.truncatedSongIds, ["only-song"]);
  assert.equal(state.songProgress[0].pageInSong, 2);
});

test("pooled source scan checkpoints capped songs before pausing on budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-pool-cap-"));
  const config = await options(directory);
  config.source = "record";
  config.maxCommentPagesPerSong = 1;
  const songs: SongCandidate[] = ["1", "2", "3"].map((id) => ({ id, sources: ["record"] }));
  const makeClient = (): NcmClient => ({
    getLoginProfile: async () => undefined,
    getUserRecord: async () => songs,
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async (_songId, _pageSize, _pageNo, cursor) => ({
      comments: [{ commentId: crypto.randomUUID(), userId: "9", content: "other" }],
      hasMore: true,
      nextCursor: String(Number(cursor) - 1),
    }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  });

  const report = await runPooledCommentFinder([
    { name: "lane-a", client: makeClient(), governor: governor(100) },
    { name: "lane-b", client: makeClient(), governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 2 });

  assert.equal(report.status, "paused");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.songsProcessed, 2);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress.filter((item: { done: boolean }) => item.done).length, 2);
  assert.equal(state.truncatedSongIds.length, 2);
});
