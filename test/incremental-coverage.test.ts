import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RequestGovernor } from "../src/governor";
import { loadSongCoverage } from "../src/song-coverage";
import { runCommentFinder, runPooledCommentFinder } from "../src/scanner";
import type {
  CursorCommentPage,
  HistoryPage,
  LoginProfile,
  NcmClient,
  ScanOptions,
  SongCandidate,
} from "../src/types";

class CatalogClient implements NcmClient {
  recordSongs: SongCandidate[] = [];
  likedSongs: SongCandidate[] = [];
  commentCalls: Array<{ songId: string; pageNo: number; cursor: string }> = [];
  comments = new Map<string, (pageNo: number, cursor: string) => CursorCommentPage>();
  likesFailure?: Error;
  recordFailure?: Error;

  async getLoginProfile(): Promise<LoginProfile | undefined> { return undefined; }
  async getUserRecord(): Promise<SongCandidate[]> {
    if (this.recordFailure) throw this.recordFailure;
    return this.recordSongs.map(cloneSong);
  }
  async getLikedSongs(): Promise<SongCandidate[]> {
    if (this.likesFailure) throw this.likesFailure;
    return this.likedSongs.map(cloneSong);
  }
  async getSongComments(): Promise<never> { throw new Error("offset comments are not expected"); }
  async getSongCommentsByCursor(songId: string, _pageSize: number, pageNo: number, cursor: string): Promise<CursorCommentPage> {
    this.commentCalls.push({ songId, pageNo, cursor });
    return this.comments.get(songId)?.(pageNo, cursor) ?? { comments: [], hasMore: false };
  }
  async getUserCommentHistory(): Promise<HistoryPage> { return { comments: [], hasMore: false }; }
}

function cloneSong(song: SongCandidate): SongCandidate {
  return { ...song, sources: [...song.sources], artists: song.artists && [...song.artists] };
}

function song(id: string, source: "record" | "likes", rank = Number(id.replace(/\D/g, "")) || 1): SongCandidate {
  return { id, name: `song-${id}`, sources: [source], sourceRank: rank };
}

function governor(budget = 100): RequestGovernor {
  return new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: budget,
  });
}

function scanOptions(directory: string, source: ScanOptions["source"], uid = "42"): ScanOptions {
  return {
    uid,
    strategy: "scan",
    source,
    recordScope: "all",
    statePath: join(directory, `${uid}-${source}-state.json`),
    outputPath: join(directory, `target-v3-${uid}.jsonl`),
    coveragePath: join(directory, `target-v3-${uid}-coverage.json`),
    commentPageSize: 100,
    historyPageSize: 10,
    maxCommentPagesPerSong: 0,
    maxSongs: 0,
    stopAfterFirst: false,
    fresh: false,
    dryRun: false,
  };
}

test("likes refresh adds only new songs after a completed checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-incremental-likes-"));
  const client = new CatalogClient();
  client.likedSongs = [song("A", "likes"), song("B", "likes")];
  const options = scanOptions(directory, "likes");

  await runCommentFinder(client, governor(), options);
  client.commentCalls.length = 0;
  client.likedSongs = [...client.likedSongs, song("C", "likes")];

  const report = await runCommentFinder(client, governor(), options);

  assert.equal(report.status, "complete");
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["C"]);
  assert.equal(report.catalogSongs, 3);
  assert.equal(report.historicalCompletedSongs, 2);
  assert.equal(report.newPendingSongs, 1);
});

test("incremental reconciliation preserves an unfinished song cursor and starts a new song at its initial cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-incremental-cursor-"));
  const client = new CatalogClient();
  client.likedSongs = [song("A", "likes"), song("B", "likes")];
  client.comments.set("B", (pageNo) => pageNo === 1
    ? { comments: [], hasMore: true, nextCursor: "123" }
    : { comments: [], hasMore: false });
  const options = scanOptions(directory, "likes");

  const paused = await runCommentFinder(client, governor(3), options);
  assert.equal(paused.status, "paused");
  const checkpoint = JSON.parse(await readFile(options.statePath, "utf8"));
  const bIndex = checkpoint.songs.findIndex((entry: SongCandidate) => entry.id === "B");
  checkpoint.songProgress[bIndex].commentShards = [
    { id: 0, startTime: 0, endTime: 100, cursor: "100", pageNo: 4, pagesProcessed: 3, done: true },
    { id: 1, startTime: 100, endTime: 200, cursor: "123", pageNo: 7, pagesProcessed: 6, done: false },
  ];
  await writeFile(options.statePath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  client.commentCalls.length = 0;
  client.likedSongs = [...client.likedSongs, song("C", "likes")];

  await runCommentFinder(client, governor(), options);

  assert.deepEqual(client.commentCalls.map(({ songId, pageNo, cursor }) => ({ songId, pageNo, cursor })), [
    { songId: "B", pageNo: 7, cursor: "123" },
    { songId: "C", pageNo: 1, cursor: client.commentCalls[1].cursor },
  ]);
  assert.ok(Number(client.commentCalls[1].cursor) > 123);
});

test("both merges duplicate source membership, repeats with zero comment requests, then scans only D", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-incremental-both-"));
  const client = new CatalogClient();
  client.recordSongs = [song("A", "record"), song("B", "record")];
  client.likedSongs = [song("B", "likes"), song("C", "likes")];
  const options = scanOptions(directory, "both");

  await runCommentFinder(client, governor(), options);
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["A", "B", "C"]);
  const firstState = JSON.parse(await readFile(options.statePath, "utf8"));
  assert.deepEqual(firstState.songs.find((entry: SongCandidate) => entry.id === "B").sources, ["record", "likes"]);

  client.commentCalls.length = 0;
  await runCommentFinder(client, governor(), options);
  assert.deepEqual(client.commentCalls, []);

  client.likedSongs.push(song("D", "likes"));
  await runCommentFinder(client, governor(), options);
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["D"]);
});

test("a song covered by record is reused by likes while its prior hit remains in the canonical result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-cross-source-"));
  const client = new CatalogClient();
  client.recordSongs = [song("B", "record")];
  client.likedSongs = [song("B", "likes")];
  client.comments.set("B", () => ({
    comments: [{ commentId: "hit-B", userId: "42", content: "found once" }],
    hasMore: false,
  }));
  const recordOptions = scanOptions(directory, "record");
  const likesOptions = scanOptions(directory, "likes");

  await runCommentFinder(client, governor(), recordOptions);
  client.commentCalls.length = 0;
  const report = await runCommentFinder(client, governor(), likesOptions);

  assert.deepEqual(client.commentCalls, []);
  assert.equal(report.reusedSongs, 1);
  const rows = (await readFile(likesOptions.outputPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.commentId), ["hit-B"]);
});

test("truncated songs are not reusable, UIDs stay isolated, and fresh explicitly rescans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-coverage-boundaries-"));
  const client = new CatalogClient();
  client.recordSongs = [song("T", "record")];
  client.comments.set("T", () => ({ comments: [], hasMore: true, nextCursor: "50" }));
  const truncated = scanOptions(directory, "record");
  truncated.maxCommentPagesPerSong = 1;

  await runCommentFinder(client, governor(), truncated);
  const ledger = await loadSongCoverage(truncated.coveragePath!, "42");
  assert.equal(ledger.songs.T, undefined);

  client.commentCalls.length = 0;
  const otherUid = { ...scanOptions(directory, "record", "99"), maxCommentPagesPerSong: 1 };
  await runCommentFinder(client, governor(), otherUid);
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["T"]);

  client.comments.set("T", () => ({ comments: [], hasMore: false }));
  truncated.maxCommentPagesPerSong = 0;
  truncated.fresh = true;
  client.commentCalls.length = 0;
  await runCommentFinder(client, governor(), truncated);
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["T"]);
});

test("a failed catalog refresh retains the prior catalog and makes no completed-song comment request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-refresh-failure-"));
  const client = new CatalogClient();
  client.likedSongs = [song("A", "likes")];
  const options = scanOptions(directory, "likes");
  await runCommentFinder(client, governor(), options);
  const before = JSON.parse(await readFile(options.statePath, "utf8"));

  client.commentCalls.length = 0;
  client.likesFailure = new Error("catalog unavailable");
  const report = await runCommentFinder(client, governor(), options);
  const after = JSON.parse(await readFile(options.statePath, "utf8"));

  assert.deepEqual(client.commentCalls, []);
  assert.deepEqual(after.songs, before.songs);
  assert.match(report.sourceErrors.join(" "), /catalog unavailable/);
  assert.equal(report.coverageComplete, false);
});

test("a partial both refresh keeps the failed source catalog while merging successful new songs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-partial-refresh-"));
  const client = new CatalogClient();
  client.recordSongs = [song("A", "record")];
  client.likedSongs = [song("B", "likes")];
  const options = scanOptions(directory, "both");
  await runCommentFinder(client, governor(), options);

  const legacyState = JSON.parse(await readFile(options.statePath, "utf8"));
  for (const entry of legacyState.songs) delete entry.memberships;
  await writeFile(options.statePath, `${JSON.stringify(legacyState, null, 2)}\n`, "utf8");

  client.commentCalls.length = 0;
  client.recordSongs = [song("A", "record", 9), { ...song("C", "record"), name: "renamed-C" }];
  client.likesFailure = new Error("likes unavailable");
  const report = await runCommentFinder(client, governor(), options);
  const state = JSON.parse(await readFile(options.statePath, "utf8"));

  assert.deepEqual(state.songs.map((entry: SongCandidate) => entry.id), ["A", "C", "B"]);
  assert.equal(state.songs[0].sourceRank, 9);
  assert.equal(state.songs[1].name, "renamed-C");
  assert.deepEqual(
    state.songs.map((entry: SongCandidate) => [
      entry.id,
      entry.sources,
      entry.memberships?.map((membership) => membership.source),
    ]),
    [
      ["A", ["record"], ["record"]],
      ["C", ["record"], ["record"]],
      ["B", ["likes"], ["likes"]],
    ],
  );
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["C"]);
  assert.equal(report.catalogSongs, 3);
  assert.equal(report.coverageComplete, false);
  assert.match(report.sourceErrors.join(" "), /^likes:/);
});

test("pooled source scanning also refreshes and scans only newly added songs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-incremental-pooled-"));
  const client = new CatalogClient();
  client.likedSongs = [song("A", "likes"), song("B", "likes")];
  const options = scanOptions(directory, "likes");
  const pooled = { ...options, workersPerLane: 1, maxWorkers: 1, requestBudget: 100 };
  const lane = () => [{ name: "lane-1", client, governor: governor() }];

  await runPooledCommentFinder(lane(), pooled);
  client.commentCalls.length = 0;
  client.likedSongs.push(song("C", "likes"));
  const report = await runPooledCommentFinder(lane(), pooled);

  assert.equal(report.status, "complete");
  assert.deepEqual(client.commentCalls.map((call) => call.songId), ["C"]);
});

test("a pooled song with unfinished shards is not entered into cross-source coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ncm-incomplete-shards-"));
  const client = new CatalogClient();
  client.likedSongs = [song("S", "likes")];
  client.comments.set("S", () => ({ comments: [], hasMore: true, nextCursor: "50" }));
  const options = scanOptions(directory, "likes");

  const report = await runPooledCommentFinder([{
    name: "lane-1",
    client,
    governor: governor(),
  }], {
    ...options,
    workersPerLane: 2,
    maxWorkers: 2,
    requestBudget: 2,
  });

  assert.equal(report.status, "paused");
  const state = JSON.parse(await readFile(options.statePath, "utf8"));
  assert.equal(state.songProgress[0].done, false);
  assert.ok(state.songProgress[0].commentShards.some((shard: { done: boolean }) => !shard.done));
  const ledger = await loadSongCoverage(options.coveragePath!, "42");
  assert.equal(ledger.songs.S, undefined);
});
