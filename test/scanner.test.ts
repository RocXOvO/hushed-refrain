import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      };
    }
    if (songId === "1") {
      return {
        comments: [{ commentId: "c2", userId: "42", content: "second" }],
        hasMore: false,
        nextCursor: "90",
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
  const liveMatches: string[] = [];
  config.onMatch = (comment) => liveMatches.push(comment.commentId);

  const report = await runCommentFinder(client, governor(20), config);

  assert.equal(report.status, "complete");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.songs, 3);
  assert.equal(report.matches, 2);
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
  const activities: Array<{ songId: string; pageInSong: number }> = [];
  config.onSongProgress = ({ songId, pageInSong }) => activities.push({ songId, pageInSong });
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
  assert.ok(activities.every((activity) => activity.pageInSong === 1));
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
  ], { ...config, workersPerLane: 1, requestBudget: 3 });

  assert.equal(report.status, "paused");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.songsProcessed, 2);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress.filter((item: { done: boolean }) => item.done).length, 2);
  assert.equal(state.truncatedSongIds.length, 2);
});
