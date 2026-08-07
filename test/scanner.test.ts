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
  assert.equal(state.songProgress[0].totalComments, 3);
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
  const activities: Array<{ songId: string; songName?: string; workerId?: string; pageInSong: number; requestingPage?: number; commentsProcessed: number; totalComments?: number }> = [];
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
  assert.equal(tracker.calls.filter((call) => call.pageNo === 1).length, 3);
  assert.equal(new Set(tracker.calls.map((call) => call.cursor)).size, 3);
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
  const client: NcmClient = {
    getLoginProfile: async () => undefined,
    getUserRecord: async () => [{ id: "only-song", name: "only", sources: ["record"] }],
    getLikedSongs: async () => [],
    getSongComments: async () => ({ comments: [], hotComments: [], more: false }),
    getSongCommentsByCursor: async () => {
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

  const paused = await runPooledCommentFinder(lanes(3), { ...config, workersPerLane: 1, requestBudget: 2 });
  assert.equal(paused.status, "paused");
  const pausedState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(pausedState.songProgress[0].commentShards.length, 3);
  assert.equal(pausedState.songProgress[0].commentShards.filter((shard: { done: boolean }) => !shard.done).length, 2);

  maxActive = 0;
  const completed = await runPooledCommentFinder(lanes(5), { ...config, workersPerLane: 1, requestBudget: 100 });
  assert.equal(completed.status, "complete");
  assert.equal(maxActive, 5);
  const completedState = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(completedState.songProgress[0].commentShards.length, 6);
  assert.ok(completedState.songProgress[0].commentShards.every((shard: { done: boolean }) => shard.done));
});

test("pooled source shard scheduling keeps the per-song page cap exact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-finder-one-song-cap-"));
  const config = await options(directory);
  config.source = "record";
  config.maxCommentPagesPerSong = 2;
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

  const paused = await runPooledCommentFinder(lanes(), { ...config, workersPerLane: 1, requestBudget: 3 });
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
  ], { ...config, workersPerLane: 1, requestBudget: 3 });

  assert.equal(report.status, "paused");
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.songsProcessed, 2);
  const state = JSON.parse(await readFile(config.statePath, "utf8"));
  assert.equal(state.songProgress.filter((item: { done: boolean }) => item.done).length, 2);
  assert.equal(state.truncatedSongIds.length, 2);
});
