import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CooldownRequired } from "../src/errors";
import { RequestGovernor } from "../src/governor";
import { ProxyTransportGate } from "../src/proxy-transport-gate";
import {
  createTimeShards,
  loadParallelState,
  runParallelSongScan,
} from "../src/parallel-scanner";
import type {
  CommentPage,
  CursorCommentPage,
  HistoryPage,
  LoginProfile,
  NcmClient,
  ParallelSongScanOptions,
  SongCandidate,
  SongInfo,
} from "../src/types";

class ParallelFakeClient implements NcmClient {
  active = 0;
  maxActive = 0;

  async getLoginProfile(): Promise<LoginProfile | undefined> {
    return undefined;
  }

  async getUserRecord(): Promise<SongCandidate[]> {
    return [];
  }

  async getLikedSongs(): Promise<SongCandidate[]> {
    return [];
  }

  async getSongComments(): Promise<CommentPage> {
    return { comments: [], hotComments: [], more: false };
  }

  async getSongCommentsByCursor(
    _songId: string,
    _pageSize: number,
    _pageNo: number,
    cursor: string,
  ): Promise<CursorCommentPage> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    this.active -= 1;
    const upper = Number(cursor);
    const time = upper > 50 ? 75 : 25;
    return {
      comments: [{
        commentId: `comment-${time}`,
        userId: time === 75 ? "42" : "9",
        nickname: time === 75 ? "target" : "other",
        content: `at ${time}`,
        time,
      }],
      hasMore: false,
      nextCursor: String(time),
      total: 2,
    };
  }

  async getSongInfo(songId: string): Promise<SongInfo> {
    return { id: songId, name: "song", publishTime: 0 };
  }

  async getUserCommentHistory(): Promise<HistoryPage> {
    return { comments: [], hasMore: false };
  }
}

function governor(): RequestGovernor {
  return new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 100,
  });
}

async function options(directory: string): Promise<ParallelSongScanOptions> {
  return {
    uid: "42",
    songId: "186016",
    songName: "song",
    commentScope: "root-and-floor-v1",
    startTime: 0,
    endTime: 100,
    shardCount: 2,
    pageSize: 1000,
    workersPerLane: 2,
    requestBudget: 100,
    maxPages: 0,
    stopAfterFirst: false,
    fresh: false,
    statePath: join(directory, "state.json"),
    outputPath: join(directory, "results.jsonl"),
  };
}

test("creates non-overlapping half-open time shards", () => {
  assert.deepEqual(createTimeShards(0, 10, 3).map((shard) => [
    shard.startTime,
    shard.endTime,
  ]), [[0, 4], [4, 8], [8, 10]]);
});

test("scans time shards concurrently and writes a real match shape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  const liveMatches: string[] = [];
  const checkpoints: Array<{ shardsComplete: number; pagesProcessed: number; requestsTotal: number }> = [];
  config.onMatch = (comment) => liveMatches.push(comment.commentId);
  config.onCheckpoint = (activity) => checkpoints.push(activity);
  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "complete");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.commentsInspected, 2);
  assert.equal(report.totalComments, 2);
  assert.equal(report.matches, 1);
  assert.equal(client.maxActive, 2);
  const result = JSON.parse((await readFile(config.outputPath, "utf8")).trim());
  assert.equal(result.userId, "42");
  assert.equal(result.songId, "186016");
  assert.deepEqual(liveMatches, ["comment-75"]);
  assert.ok(checkpoints.some((activity) => activity.shardsComplete === 2 && activity.pagesProcessed === 2 && activity.requestsTotal === 2));
});

test("root-only parallel scope completes without requesting comment floors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-root-only-"));
  const config = await options(directory);
  config.commentScope = "root-only-v1";
  config.shardCount = 1;
  config.workersPerLane = 1;
  let floorCalls = 0;
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => ({
      comments: [{ commentId: "root", userId: "9", content: "root", time: 50, replyCount: 50 }],
      hasMore: false,
      total: 51,
    }),
    getCommentFloor: async () => {
      floorCalls += 1;
      throw new Error("root-only scope must not request floors");
    },
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  };
  const report = await runParallelSongScan([{
    name: "lane",
    client,
    governor: governor(),
  }], config);
  assert.equal(report.status, "complete");
  assert.equal(report.floorPagesProcessed, 0);
  assert.equal(floorCalls, 0);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.commentScope, "root-only-v1");
  assert.deepEqual(state.floorThreads, []);
});

test("parallel floors fan out across parents while duplicate parent work stays single-flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-floor-fanout-"));
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;
  config.maxWorkers = 4;
  const parents = Array.from({ length: 8 }, (_, index) => `parent-${index + 1}`);
  let active = 0;
  let peak = 0;
  const activeParents = new Set<string>();
  const usedLanes = new Set<string>();
  const lanes = Array.from({ length: 4 }, (_, index) => {
    const name = `lane-${index + 1}`;
    const client: NcmClient = {
      getLoginProfile: async () => undefined,
      getUserRecord: async () => [],
      getLikedSongs: async () => [],
      getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
      getSongCommentsByCursor: async () => ({
        comments: parents.map((commentId) => ({
          commentId,
          userId: "9",
          content: "root",
          time: 50,
          replyCount: 1,
        })),
        hasMore: false,
        total: parents.length,
      }),
      getCommentFloor: async (_songId, parentCommentId) => {
        assert.equal(activeParents.has(parentCommentId), false);
        activeParents.add(parentCommentId);
        usedLanes.add(name);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        activeParents.delete(parentCommentId);
        return { parentCommentId, comments: [], hasMore: false, total: 1 };
      },
      getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
    };
    return { name, client, governor: governor() };
  });

  const report = await runParallelSongScan(lanes, config);
  assert.equal(report.status, "complete");
  assert.equal(report.floorPagesProcessed, parents.length);
  assert.equal(peak, 4);
  assert.equal(usedLanes.size, 4);
});

test("parallel scanning expands floor replies before completing a shard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-floor-"));
  const client = new ParallelFakeClient();
  client.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "root", userId: "9", content: "root", time: 50, replyCount: 1 }],
    hasMore: false,
    total: 2,
  });
  client.getCommentFloor = async (_songId, parentCommentId) => ({
    parentCommentId,
    comments: [{ commentId: "nested", parentCommentId, userId: "42", content: "nested", time: 51 }],
    hasMore: false,
    total: 1,
  });
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;
  const report = await runParallelSongScan([{ name: "lane", client, governor: governor() }], config);
  assert.equal(report.status, "complete");
  assert.equal(report.pagesProcessed, 1);
  assert.equal(report.floorPagesProcessed, 1);
  assert.equal(report.commentsInspected, 2);
  assert.equal(report.replyCommentsInspected, 1);
  const record = JSON.parse((await readFile(config.outputPath, "utf8")).trim());
  assert.equal(record.route, "song-comment-floor");
  assert.equal(record.parentCommentId, "root");
  const state = await loadParallelState(config.statePath);
  assert.equal(state?.version, 2);
  assert.equal(state?.floorPagesProcessed, 1);
});

test("a floor cooldown belongs only to its owner lane while a healthy waiter takes over", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-floor-takeover-"));
  let announceOwner!: () => void;
  const ownerStarted = new Promise<void>((resolve) => { announceOwner = resolve; });
  let ownerFloorCalls = 0;
  let healthyFloorCalls = 0;

  const owner = new ParallelFakeClient();
  owner.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "shared-parent", userId: "9", content: "root", replyCount: 1 }],
    hasMore: false,
    total: 2,
  });
  owner.getCommentFloor = async () => {
    ownerFloorCalls += 1;
    announceOwner();
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new CooldownRequired(429, 60_000);
  };

  const healthy = new ParallelFakeClient();
  healthy.getSongCommentsByCursor = async () => {
    await ownerStarted;
    return {
      comments: [{ commentId: "shared-parent", userId: "9", content: "root", replyCount: 1 }],
      hasMore: false,
      total: 2,
    };
  };
  healthy.getCommentFloor = async (_songId, parentCommentId) => {
    healthyFloorCalls += 1;
    return {
      parentCommentId,
      comments: [{ commentId: "nested", parentCommentId, userId: "42", content: "match" }],
      hasMore: false,
      total: 1,
    };
  };

  const config = await options(directory);
  config.shardCount = 2;
  config.workersPerLane = 1;
  config.maxWorkers = 2;
  // Two root pages, one logical floor page, and one root replay after the
  // owner's interrupted transaction. The healthy takeover must reuse the
  // failed owner's floor reservation instead of consuming a fifth slot.
  config.requestBudget = 4;
  const report = await runParallelSongScan([
    { name: "cooldown-lane", client: owner, governor: governor() },
    { name: "healthy-lane", client: healthy, governor: governor() },
  ], config);

  assert.equal(report.status, "complete");
  assert.equal(ownerFloorCalls, 1);
  assert.equal(healthyFloorCalls, 1);
  const state = await loadParallelState(config.statePath);
  assert.equal(state?.floorThreads[0].done, true);
  assert.equal(state?.floorThreads[0].pagesProcessed, 1);
});

test("parallel root failover reuses one logical request and max-page reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-root-budget-failover-"));
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;
  config.maxWorkers = 1;
  config.requestBudget = 1;
  config.maxPages = 1;
  let failedCalls = 0;
  let healthyCalls = 0;
  const failed = new ParallelFakeClient();
  failed.getSongCommentsByCursor = async () => {
    failedCalls += 1;
    throw new Error("lane failed");
  };
  const healthy = new ParallelFakeClient();
  healthy.getSongCommentsByCursor = async () => {
    healthyCalls += 1;
    return { comments: [], hasMore: false, total: 0 };
  };

  const report = await runParallelSongScan([
    { name: "failed", client: failed, governor: governor() },
    { name: "healthy", client: healthy, governor: governor() },
  ], config);

  assert.equal(report.status, "complete");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.pagesProcessed, 1);
  assert.equal(failedCalls, 1);
  assert.equal(healthyCalls, 1);
});

test("parallel resume drains a persisted floor even when its parent leaves the replayed root page", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-floor-resume-"));
  const client = new ParallelFakeClient();
  let rootStillVisible = true;
  let rootCalls = 0;
  client.getSongCommentsByCursor = async () => {
    rootCalls += 1;
    return {
      comments: rootStillVisible
        ? [{ commentId: "root", userId: "9", content: "root", time: 50, replyCount: 2 }]
        : [{ commentId: "replacement", userId: "9", content: "replacement", time: 50 }],
      hasMore: false,
      total: 3,
    };
  };
  const floorTimes: number[] = [];
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
    return {
      parentCommentId,
      comments: [{ commentId: "nested-2", parentCommentId, userId: "42", content: "second" }],
      hasMore: false,
      total: 0,
    };
  };
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;
  config.requestBudget = 2;

  const pausedReport = await runParallelSongScan([{ name: "lane", client, governor: governor() }], config);
  assert.equal(pausedReport.status, "paused");
  const paused = await loadParallelState(config.statePath);
  assert.equal(paused?.finished, false);
  assert.equal(paused?.floorThreads[0].nextTime, 10);
  assert.equal(paused?.floorThreads[0].done, false);

  const checkpoint = JSON.parse(await readFile(config.statePath, "utf8"));
  checkpoint.rootDone = true;
  checkpoint.shards.forEach((shard: { done: boolean }) => { shard.done = true; });
  checkpoint.finished = false;
  await writeFile(config.statePath, `${JSON.stringify(checkpoint)}\n`, "utf8");
  rootStillVisible = false;
  config.requestBudget = 1;
  const report = await runParallelSongScan([{ name: "lane", client, governor: governor() }], config);
  assert.equal(report.status, "complete");
  assert.deepEqual(floorTimes, [-1, 10]);
  const completed = await loadParallelState(config.statePath);
  assert.equal(completed?.floorThreads[0].done, true);
  assert.equal(completed?.rootDone, true);
  assert.equal(completed?.finished, true);
  assert.equal(rootCalls, 1);
});

test("parallel stop-after-first skips a large floor when the root itself matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-root-first-match-"));
  const client = new ParallelFakeClient();
  let rootCalls = 0;
  let floorCalls = 0;
  client.getSongCommentsByCursor = async () => {
    rootCalls += 1;
    return {
      comments: [{ commentId: "target-root", userId: "42", content: "match", time: 50, replyCount: 9_999 }],
      hasMore: false,
      total: 10_000,
    };
  };
  client.getCommentFloor = async (_songId, parentCommentId) => {
    floorCalls += 1;
    return { parentCommentId, comments: [], hasMore: false, total: 9_999 };
  };
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;
  config.stopAfterFirst = true;

  assert.equal((await runParallelSongScan([{ name: "lane", client, governor: governor() }], config)).status, "matched");
  assert.equal((await runParallelSongScan([{ name: "lane", client, governor: governor() }], config)).status, "matched");
  assert.equal(rootCalls, 1);
  assert.equal(floorCalls, 0);
});

test("assigns comments without timestamps to the shard that returned them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-missing-time-"));
  const client = new ParallelFakeClient();
  client.getSongCommentsByCursor = async () => ({
    comments: [{ commentId: "missing-time", userId: "42", content: "still inspect me" }],
    hasMore: false,
    total: 1,
  });
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;

  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "complete");
  assert.equal(report.commentsInspected, 1);
  assert.equal(report.matches, 1);
  const result = JSON.parse((await readFile(config.outputPath, "utf8")).trim());
  assert.equal(result.commentId, "missing-time");
});

test("publishes stable worker identity, request timing, and song metadata for live activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-activity-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  const activities: Array<{ phase: string; workerId?: string; songId: string; songName?: string; startedAt?: string }> = [];
  config.onRequestActivity = (activity) => activities.push(activity);

  await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  const starts = activities.filter((activity) => activity.phase === "start");
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts.map((activity) => activity.workerId)), new Set(["worker-1", "worker-2"]));
  assert.ok(activities.every((activity) => activity.songId === "186016" && activity.songName === "song"));
  assert.ok(starts.every((activity) => Number.isFinite(Date.parse(activity.startedAt ?? ""))));
  for (const start of starts) {
    assert.ok(activities.some((activity) => activity.phase === "success" && activity.workerId === start.workerId));
  }
});

test("trailing-publishes a parallel page burst while the next request is still running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-live-checkpoints-"));
  const client = new ParallelFakeClient();
  const getPage = client.getSongCommentsByCursor.bind(client);
  let pageCalls = 0;
  let thirdPageFinished = false;
  client.getSongCommentsByCursor = async (...args) => {
    const call = ++pageCalls;
    if (call === 3) await new Promise((resolve) => setTimeout(resolve, 400));
    const page = await getPage(...args);
    if (call === 3) thirdPageFinished = true;
    return page;
  };
  const config = await options(directory);
  config.shardCount = 3;
  config.workersPerLane = 3;
  const pages: number[] = [];
  let sawBurstBeforeThirdFinished = false;
  config.onCheckpoint = (activity) => {
    pages.push(activity.pagesProcessed);
    if (activity.pagesProcessed === 2 && !thirdPageFinished) sawBurstBeforeThirdFinished = true;
  };

  await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(sawBurstBeforeThirdFinished, true);
  assert.equal(pages.at(-1), 3);
});

test("hard-caps parallel worker loops while rotating across every selected lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-worker-cap-"));
  const client = new ParallelFakeClient();
  const getPage = client.getSongCommentsByCursor.bind(client);
  let pageCalls = 0;
  client.getSongCommentsByCursor = async (...args) => {
    pageCalls += 1;
    const page = await getPage(...args);
    const cursor = args[3];
    const nextCursor = String(Number(cursor) - 10);
    return {
      ...page,
      hasMore: pageCalls <= 2,
      nextCursor,
    };
  };
  const config = await options(directory);
  config.shardCount = 8;
  config.workersPerLane = 3;
  config.maxWorkers = 2;
  const usedLanes = new Set<string>();
  config.onRequestActivity = (activity) => {
    if (activity.phase === "start") usedLanes.add(activity.lane);
  };
  const lanes = Array.from({ length: 4 }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: governor(),
  }));
  const report = await runParallelSongScan(lanes, config);
  assert.equal(report.status, "complete");
  assert.equal(report.workers, 2);
  assert.equal(client.maxActive, 2);
  assert.deepEqual(usedLanes, new Set(lanes.map((lane) => lane.name)));
});

test("materializes only enough fresh shards for actual worker capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-initial-shards-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  config.shardCount = 96;
  config.workersPerLane = 3;
  config.maxWorkers = 2;

  const report = await runParallelSongScan(Array.from({ length: 4 }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: governor(),
  })), config);
  const state = await loadParallelState(config.statePath);

  assert.equal(report.status, "complete");
  assert.equal(state?.shardCount, 96);
  assert.equal(state?.shards.length, 2);
  assert.equal(report.pagesProcessed, 2);
});

test("materializes fresh shards at the currently reduced transport capacity", async () => {
  const gate = new ProxyTransportGate({
    maxConcurrent: 8,
    minStartDelayMs: 0,
    startJitterMs: 0,
  });
  for (let failure = 0; failure < 3; failure += 1) {
    await assert.rejects(gate.run(async () => { throw new Error("temporary"); }));
  }
  assert.equal(gate.currentMaxConcurrent, 4);

  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-reduced-shards-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  config.shardCount = 96;
  config.workersPerLane = 3;
  config.maxWorkers = 8;
  const report = await runParallelSongScan(Array.from({ length: 4 }, (_, index) => ({
    name: `lane-${index + 1}`,
    client,
    governor: governor(),
    transportGate: gate,
  })), config);
  const state = await loadParallelState(config.statePath);

  assert.equal(report.status, "complete");
  assert.equal(state?.shardCount, 96);
  assert.equal(state?.shards.length, 4);
});

test("continues an empty page when its descending cursor advances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-empty-page-"));
  const client = new ParallelFakeClient();
  let calls = 0;
  client.getSongCommentsByCursor = async (_songId, _pageSize, _pageNo, cursor) => {
    calls += 1;
    if (calls === 1) return { comments: [], hasMore: true, nextCursor: "50" };
    return {
      comments: [{ commentId: "after-empty", userId: "42", content: "found", time: 25 }],
      hasMore: false,
      nextCursor: cursor,
    };
  };
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;

  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "complete");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.matches, 1);
  assert.equal(calls, 2);
});

test("adaptively splits a long remaining shard across idle workers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-adaptive-split-"));
  const client = new ParallelFakeClient();
  let active = 0;
  let maxActive = 0;
  client.getSongCommentsByCursor = async (_songId, _pageSize, _pageNo, cursor) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    const upper = Number(cursor);
    const next = Math.max(0, upper - 20);
    return {
      comments: [{
        commentId: `comment-${upper}`,
        userId: "9",
        content: `before ${upper}`,
        time: Math.max(0, upper - 1),
      }],
      hasMore: next > 0,
      nextCursor: String(next),
    };
  };
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 3;
  const splits: NonNullable<ParallelSongScanOptions["onSchedulerActivity"]> extends (value: infer T) => void ? T[] : never = [];
  config.onSchedulerActivity = (activity) => splits.push(activity);

  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "complete");
  assert.ok(maxActive >= 2, `expected idle workers to receive split work, saw ${maxActive}`);
  assert.ok(splits.length >= 1);
  assert.equal(splits[0].type, "adaptive-split");
  assert.equal(report.shards, 1 + splits.length);
  assert.equal(report.shardsComplete, report.shards);
  const state = await loadParallelState(config.statePath);
  assert.equal(state?.shards.length, report.shards);
  assert.ok(state?.shards.every((shard) => shard.done));
});

for (const [label, nextCursor] of [["unchanged", "100"], ["missing", undefined]] as const) {
  test(`keeps a parallel shard resumable when the ${label} cursor cannot advance`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `ncm-parallel-${label}-cursor-`));
    const client = new ParallelFakeClient();
    client.getSongCommentsByCursor = async () => ({
      comments: [],
      hasMore: true,
      nextCursor,
    });
    const config = await options(directory);
    config.shardCount = 1;
    config.workersPerLane = 1;
    const requestPhases: string[] = [];
    config.onRequestActivity = (activity) => requestPhases.push(activity.phase);

    await assert.rejects(
      runParallelSongScan([{
        name: "lane-1",
        client,
        governor: governor(),
      }], config),
      /cursor did not advance/,
    );
    const state = await loadParallelState(config.statePath);
    assert.equal(state?.finished, false);
    assert.equal(state?.shards[0].done, false);
    assert.equal(state?.shards[0].cursor, "100");
    assert.deepEqual(requestPhases, ["start", "failure"]);
  });
}

test("stops after one match while concurrent pages are in flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-first-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  config.stopAfterFirst = true;
  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "matched");
  assert.equal(report.matches, 1);
  const lines = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
});

test("a fresh parallel checkpoint counts a rediscovered JSONL match without appending it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-existing-output-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  config.fresh = true;
  config.shardCount = 1;
  config.workersPerLane = 1;
  config.stopAfterFirst = true;
  await writeFile(config.outputPath, `${JSON.stringify({ commentId: "comment-75" })}\n`, "utf8");

  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "matched");
  assert.equal(report.matches, 1);
  assert.equal((await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/).length, 1);
  const state = await loadParallelState(config.statePath);
  assert.deepEqual(state?.seenCommentIds, ["comment-75"]);
  assert.equal(state?.matchCount, 1);
});

test("requeues a shard when one proxy lane fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-lane-"));
  const goodClient = new ParallelFakeClient();
  const failedClient = new ParallelFakeClient();
  let failedCalls = 0;
  failedClient.getSongCommentsByCursor = async () => {
    failedCalls += 1;
    throw { status: 502, body: { code: 502 } };
  };
  const config = await options(directory);
  config.workersPerLane = 1;

  const report = await runParallelSongScan([
    { name: "failed", client: failedClient, governor: governor() },
    { name: "good", client: goodClient, governor: governor() },
  ], config);

  assert.equal(report.status, "complete");
  assert.equal(report.matches, 1);
  assert.equal(goodClient.maxActive, 1);
  assert.equal(failedCalls, 1);
  assert.doesNotMatch(report.note ?? "", /Failed lanes/);
});

test("an external stop signal wakes lane backoff without waiting for its retry deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-stop-backoff-"));
  const client = new ParallelFakeClient();
  let calls = 0;
  client.getSongCommentsByCursor = async () => {
    calls += 1;
    throw { status: 502, body: { code: 502 } };
  };
  const controller = new AbortController();
  const config = await options(directory);
  config.shardCount = 1;
  config.workersPerLane = 1;
  config.signal = controller.signal;
  setTimeout(() => controller.abort(), 25);
  const startedAt = Date.now();

  const report = await runParallelSongScan([{
    name: "failed",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "stopped");
  assert.equal(calls, 1);
  assert.ok(Date.now() - startedAt < 500, "stop should wake the one-second lane backoff");
});

test("pauses instead of retrying forever when every worker repeatedly loses its lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-failed-lane-limit-"));
  const client = new ParallelFakeClient();
  let calls = 0;
  client.getSongCommentsByCursor = async () => {
    calls += 1;
    throw { status: 502, body: { code: 502 } };
  };
  const config = await options(directory);
  config.shardCount = 5;
  config.workersPerLane = 5;

  const report = await runParallelSongScan([{
    name: "failed",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "paused");
  assert.equal(calls, 5);
  assert.match(report.note ?? "", /repeated network failures/);
});

test("a late concurrent success keeps a temporarily failed lane available", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-late-lane-success-"));
  const client = new ParallelFakeClient();
  let calls = 0;
  client.getSongCommentsByCursor = async () => {
    const call = ++calls;
    if (call <= 5) throw { status: 502, body: { code: 502 } };
    if (call === 6) await new Promise((resolve) => setTimeout(resolve, 30));
    return { comments: [], hasMore: false };
  };
  const config = await options(directory);
  config.shardCount = 6;
  config.workersPerLane = 6;

  const report = await runParallelSongScan([{
    name: "recovering",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "complete");
  assert.ok(calls >= 11);
  assert.doesNotMatch(report.note ?? "", /repeated network failures/);
});
