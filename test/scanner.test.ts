import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RequestGovernor } from "../src/governor";
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
  commentCalls: Array<{ songId: string; offset: number }> = [];

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
    this.commentCalls.push({ songId, offset });
    if (songId === "1" && offset === 0) {
      return {
        comments: [
          { commentId: "c1", userId: "42", content: "first" },
          { commentId: "other", userId: "9", content: "ignore" },
        ],
        hotComments: [{ commentId: "c1", userId: "42", content: "first" }],
        more: true,
      };
    }
    if (songId === "1") {
      return {
        comments: [{ commentId: "c2", userId: "42", content: "second" }],
        hotComments: [],
        more: false,
      };
    }
    return { comments: [], hotComments: [], more: false };
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

async function options(directory: string): Promise<ScanOptions> {
  return {
    uid: "42",
    strategy: "scan",
    source: "both",
    recordScope: "all",
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

  const report = await runCommentFinder(client, governor(20), config);

  assert.equal(report.status, "complete");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.songs, 3);
  assert.equal(report.matches, 2);
  assert.deepEqual(client.commentCalls, [
    { songId: "1", offset: 0 },
    { songId: "1", offset: 2 },
    { songId: "2", offset: 0 },
    { songId: "3", offset: 0 },
  ]);

  const lines = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
  const records = lines.map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.commentId), ["c1", "c2"]);
  assert.deepEqual(records[0].sources, ["record"]);

  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.finished, true);
  assert.equal(state.songIndex, 3);
});

test("pauses on budget and resumes at the exact comment offset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-resume-"));
  const client = new FakeClient();
  const config = await options(directory);

  const first = await runCommentFinder(client, governor(3), config);
  assert.equal(first.status, "paused");
  assert.deepEqual(client.commentCalls, [{ songId: "1", offset: 0 }]);

  const second = await runCommentFinder(client, governor(20), config);
  assert.equal(second.status, "complete");
  assert.deepEqual(client.commentCalls, [
    { songId: "1", offset: 0 },
    { songId: "1", offset: 2 },
    { songId: "2", offset: 0 },
    { songId: "3", offset: 0 },
  ]);

  const lines = (await readFile(config.outputPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 2);
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

test("an empty source list is checkpointed and not fetched again", async () => {
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
  assert.equal(sourceCalls, 1);
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
    getSongComments: async (songId) => {
      tracker.active += 1;
      tracker.maxActive = Math.max(tracker.maxActive, tracker.active);
      tracker.calls.push(`${name}:${songId}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      tracker.active -= 1;
      return {
        comments: songId === "3" ? [{ commentId: "pool-match", userId: "42", content: "found" }] : [],
        hotComments: [],
        more: false,
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
    getSongComments: async () => ({ comments: [{ commentId: crypto.randomUUID(), userId: "9", content: "other" }], hotComments: [], more: true }),
    getUserCommentHistory: async () => ({ comments: [], hasMore: false }),
  });

  const report = await runPooledCommentFinder([
    { name: "lane-a", client: makeClient(), governor: governor(100) },
    { name: "lane-b", client: makeClient(), governor: governor(100) },
  ], { ...config, workersPerLane: 1, requestBudget: 3 });

  assert.equal(report.status, "paused");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.songsProcessed, 2);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress.filter((item: { done: boolean }) => item.done).length, 2);
  assert.equal(state.truncatedSongIds.length, 2);
});
