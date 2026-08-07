import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RequestGovernor } from "../src/governor";
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

test("publishes stable worker identity and song metadata for live activity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-parallel-activity-"));
  const client = new ParallelFakeClient();
  const config = await options(directory);
  const activities: Array<{ phase: string; workerId?: string; songId: string; songName?: string }> = [];
  config.onRequestActivity = (activity) => activities.push(activity);

  await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  const starts = activities.filter((activity) => activity.phase === "start");
  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts.map((activity) => activity.workerId)), new Set(["lane-1:1", "lane-1:2"]));
  assert.ok(activities.every((activity) => activity.songId === "186016" && activity.songName === "song"));
  for (const start of starts) {
    assert.ok(activities.some((activity) => activity.phase === "success" && activity.workerId === start.workerId));
  }
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
