import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RequestGovernor } from "../src/governor";
import {
  createTimeShards,
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
  config.onMatch = (comment) => liveMatches.push(comment.commentId);
  const report = await runParallelSongScan([{
    name: "lane-1",
    client,
    governor: governor(),
  }], config);

  assert.equal(report.status, "complete");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.commentsInspected, 2);
  assert.equal(report.matches, 1);
  assert.equal(client.maxActive, 2);
  const result = JSON.parse((await readFile(config.outputPath, "utf8")).trim());
  assert.equal(result.userId, "42");
  assert.equal(result.songId, "186016");
  assert.deepEqual(liveMatches, ["comment-75"]);
});

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
  failedClient.getSongCommentsByCursor = async () => {
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
  assert.match(report.note ?? "", /Failed lanes: failed/);
});
