import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RequestGovernor } from "../src/governor";
import { CooldownRequired, RunCancelled } from "../src/errors";
import { QQMusicApiError } from "../src/qq-music/client";
import { QQMusicProxyError } from "../src/qq-music/proxy-fetch";
import { QQMusicResultWriter } from "../src/qq-music/result-writer";
import { runQQMusicScan } from "../src/qq-music/scanner";
import { loadQQMusicScanState, saveQQMusicScanState } from "../src/qq-music/state";
import { cancelQQMusicLanes, QQMusicTransportGate } from "../src/qq-music/transport-gate";
import type {
  QQCommentLane,
  QQMusicCommentPage,
  QQMusicCheckpointActivity,
  QQMusicPlatformClient,
  QQMusicRequestActivity,
  QQMusicScanOptions,
  QQMusicScanState,
  QQMusicSongActivity,
  QQMusicSongPage,
} from "../src/qq-music/types";

test("single-song QQ scan follows SeqNo pages and writes exact EncryptUin matches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-scan-"));
  const cursors: Array<string | undefined> = [];
  const client = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, cursor) => {
      cursors.push(cursor);
      if (!cursor) {
        return {
          comments: [comment("match", "90", "target-user")],
          hasMore: true,
          nextCursor: "90",
          total: 2,
        };
      }
      return {
        comments: [comment("other", "80", "other-user")],
        hasMore: false,
        total: 2,
      };
    },
  });
  const activities: QQMusicRequestActivity[] = [];
  const songActivities: QQMusicSongActivity[] = [];
  const checkpoints: QQMusicCheckpointActivity[] = [];
  const options = {
    ...scanOptions(directory),
    onRequestActivity: (activity: QQMusicRequestActivity) => activities.push(activity),
    onSongProgress: (activity: QQMusicSongActivity) => songActivities.push(activity),
    onCheckpoint: (activity: QQMusicCheckpointActivity) => checkpoints.push(activity),
  };
  const report = await runQQMusicScan([lane(client, governor(20))], options);

  assert.equal(report.status, "complete");
  assert.equal(report.coverageComplete, true);
  assert.equal(report.matches, 1);
  assert.equal(report.pagesProcessed, 2);
  assert.equal(report.lanes, 1);
  assert.equal(report.workers, 1);
  assert.deepEqual(cursors, [undefined, "90"]);
  assert.deepEqual(activities.map((activity) => activity.phase), [
    "start", "success", "start", "success",
  ]);
  assert.equal(activities.every((activity) => activity.workerId === "worker-1"), true);
  assert.equal(activities.filter((activity) => activity.phase === "start")
    .every((activity) => !Number.isNaN(Date.parse(activity.startedAt))), true);
  assert.deepEqual(activities.filter((activity) => activity.phase === "success")
    .map((activity) => activity.comments), [1, 1]);
  assert.equal(songActivities.some((activity) => activity.done && activity.pages === 2), true);
  assert.equal(checkpoints.at(-1)?.coverageComplete, true);
  assert.deepEqual(
    [...new Set(checkpoints.map((activity) => activity.pagesProcessed))],
    [0, 1, 2],
  );
  assert.equal("songs" in (checkpoints.at(-1) as unknown as Record<string, unknown>), true);
  assert.equal("targetEncryptUin" in (checkpoints.at(-1) as unknown as Record<string, unknown>), false);
  const lines = (await readFile(options.outputPath, "utf8")).trim().split("\n");
  const stored = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(stored.platform, "qq");
  assert.equal(stored.targetEncryptUin, "target-user");
  assert.equal(stored.commentId, "match");
});

test("QQ startup preserves numeric-user resolution errors before checkpoint creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-resolve-errors-"));
  const baseOptions = { ...scanOptions(directory), target: "123456" };

  const rateLimited = fakeClient({
    resolveUser: async () => { throw { status: 429 }; },
    comments: async () => ({ comments: [], hasMore: false }),
  });
  await assert.rejects(
    runQQMusicScan([lane(rateLimited, governor(10))], baseOptions),
    CooldownRequired,
  );

  const privateProfile = fakeClient({
    resolveUser: async () => { throw new QQMusicApiError("public profile is hidden"); },
    comments: async () => ({ comments: [], hasMore: false }),
  });
  await assert.rejects(
    runQQMusicScan([lane(privateProfile, governor(10))], {
      ...baseOptions,
      statePath: join(directory, "private-state.json"),
      outputPath: join(directory, "private-output.jsonl"),
    }),
    /public profile is hidden/,
  );

  const gate = new QQMusicTransportGate({ maxConcurrent: 1, minStartDelayMs: 0 });
  const cancelledLane = lane(rateLimited, governor(10), gate);
  cancelQQMusicLanes([cancelledLane]);
  await assert.rejects(
    runQQMusicScan([cancelledLane], {
      ...baseOptions,
      statePath: join(directory, "cancelled-state.json"),
      outputPath: join(directory, "cancelled-output.jsonl"),
    }),
    RunCancelled,
  );
});

test("a failed QQ lane requeues the unchanged SeqNo chain to another lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-failover-"));
  const timersBefore = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const calls: string[] = [];
  const activities: QQMusicRequestActivity[] = [];
  const badClient = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, cursor) => {
      calls.push(`bad:${cursor ?? ""}`);
      throw Object.assign(new Error("temporary upstream failure"), { status: 500 });
    },
  });
  const goodClient = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, cursor) => {
      calls.push(`good:${cursor ?? ""}`);
      return {
        comments: [comment("done", "90", "other-user")],
        hasMore: false,
        total: 1,
      };
    },
  });
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  const options = {
    ...scanOptions(directory),
    workersPerLane: 1,
    onRequestActivity: (activity: QQMusicRequestActivity) => activities.push(activity),
  };

  const result = await runQQMusicScan([
    lane(badClient, governor(10), gate, "bad"),
    lane(goodClient, governor(10), gate, "good"),
  ], options);

  assert.equal(result.status, "complete");
  assert.deepEqual(calls, ["bad:", "good:"]);
  assert.deepEqual(activities.map((activity) => `${activity.lane}:${activity.phase}`), [
    "bad:start", "bad:failure", "good:start", "good:success",
  ]);
  assert.equal(result.lanes, 2);
  assert.equal(result.workers, 1);
  const timersAfter = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  assert.ok(timersAfter <= timersBefore, "QQ scan must clean recovery notification timers");
});

test("QQ scan rejects lanes that do not share one transport gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-gates-"));
  const client = fakeClient({
    comments: async () => ({ comments: [], hasMore: false }),
  });
  await assert.rejects(
    runQQMusicScan([
      lane(client, governor(10), undefined, "one"),
      lane(client, governor(10), undefined, "two"),
    ], scanOptions(directory)),
    /share the same transport gate/,
  );
});

test("a legacy QQ pageSize 100 checkpoint migrates to 25 without losing SeqNo or PageNum", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-resume-"));
  const cursors: Array<string | undefined> = [];
  const pageSizes: number[] = [];
  const pageNumbers: number[] = [];
  const persistedPageSizesBeforeRequest: number[] = [];
  const options = { ...scanOptions(directory), pageSize: 100 };
  const client = fakeClient({
    comments: async (_songId, pageSize, pageNo, cursor) => {
      cursors.push(cursor);
      pageSizes.push(pageSize);
      pageNumbers.push(pageNo);
      persistedPageSizesBeforeRequest.push(
        (await loadQQMusicScanState(options.statePath))!.pageSize,
      );
      if (!cursor) {
        return {
          comments: [comment("first", "90", "other-user")],
          hasMore: true,
          nextCursor: "90",
          total: 2,
        };
      }
      return {
        comments: [comment("second", "80", "target-user")],
        hasMore: false,
        total: 2,
      };
    },
  });
  const legacy = pendingSongState();
  legacy.pageSize = 100;
  legacy.songs[0].cursor = "90";
  legacy.songs[0].pageNo = 1;
  legacy.songs[0].pagesProcessed = 1;
  legacy.songs[0].commentsInspected = 100;
  legacy.pagesProcessed = 1;
  legacy.commentsInspected = 100;
  await saveQQMusicScanState(options.statePath, legacy);

  const result = await runQQMusicScan([lane(client, governor(10))], options);
  assert.equal(result.status, "complete");
  assert.equal(result.matches, 1);
  assert.deepEqual(cursors, ["90"]);
  assert.deepEqual(pageSizes, [25]);
  assert.deepEqual(pageNumbers, [1]);
  assert.deepEqual(persistedPageSizesBeforeRequest, [25]);
  const migrated = await loadQQMusicScanState(options.statePath);
  assert.equal(migrated?.pageSize, 25);
  assert.equal(migrated?.songs[0].pageNo, 2);
  assert.equal(migrated?.songs[0].pagesProcessed, 2);
});

test("a valid legacy QQ pageSize 1 checkpoint resumes without migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-resume-page-one-"));
  const calls: Array<{ pageSize: number; pageNo: number; cursor?: string }> = [];
  const options = scanOptions(directory);
  const legacy = pendingSongState();
  legacy.pageSize = 1;
  legacy.songs[0].cursor = "90";
  legacy.songs[0].pageNo = 1;
  legacy.songs[0].pagesProcessed = 1;
  legacy.songs[0].commentsInspected = 1;
  legacy.pagesProcessed = 1;
  legacy.commentsInspected = 1;
  await saveQQMusicScanState(options.statePath, legacy);
  const client = fakeClient({
    comments: async (_songId, pageSize, pageNo, cursor) => {
      calls.push({ pageSize, pageNo, cursor });
      return { comments: [], hasMore: false };
    },
  });

  const result = await runQQMusicScan([lane(client, governor(10))], options);
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, [{ pageSize: 1, pageNo: 1, cursor: "90" }]);
  assert.equal((await loadQQMusicScanState(options.statePath))?.pageSize, 1);
});

test("a legacy page-size migration checkpoint failure sends no remote request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-resume-migration-failure-"));
  const options = scanOptions(directory);
  const legacy = pendingSongState();
  legacy.pageSize = 100;
  await saveQQMusicScanState(options.statePath, legacy);
  let commentCalls = 0;
  let sabotaged = false;
  const client = fakeClient({
    comments: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
  });

  const result = await runQQMusicScan([lane(client, governor(10))], {
    ...options,
    onCheckpoint: () => {
      if (sabotaged) return;
      sabotaged = true;
      rmSync(options.statePath);
      mkdirSync(options.statePath);
    },
  });

  assert.equal(result.status, "paused");
  assert.equal(commentCalls, 0);
  assert.match(result.note ?? "", /checkpoint failed/i);
});

test("legacy page-size migration reconciles a durable JSONL match without duplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-resume-dedup-"));
  const options = scanOptions(directory);
  const legacy = pendingSongState();
  legacy.pageSize = 100;
  legacy.songs[0].cursor = "90";
  legacy.songs[0].pageNo = 1;
  legacy.songs[0].pagesProcessed = 1;
  legacy.songs[0].commentsInspected = 100;
  legacy.pagesProcessed = 1;
  legacy.commentsInspected = 100;
  await saveQQMusicScanState(options.statePath, legacy);
  await writeFile(options.outputPath, `${JSON.stringify({
    platform: "qq",
    targetEncryptUin: "target-user",
    songId: "7",
    commentId: "durable-match",
    seqNo: "80",
    authorEncryptUin: "target-user",
    content: "durable-match",
    capturedAt: "2026-08-07T00:00:00.000Z",
  })}\n`, "utf8");
  const client = fakeClient({
    comments: async () => ({
      comments: [comment("durable-match", "80", "target-user")],
      hasMore: false,
    }),
  });

  const result = await runQQMusicScan([lane(client, governor(10))], options);
  assert.equal(result.status, "complete");
  assert.equal(result.matches, 1);
  assert.equal((await readFile(options.outputPath, "utf8")).trim().split("\n").length, 1);
  const state = await loadQQMusicScanState(options.statePath);
  assert.deepEqual(state?.seenCommentKeys, ["7:durable-match"]);
  assert.equal(state?.matchCount, 1);
});

test("single-song QQ pages rotate fairly across 8 lanes with at most one in flight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-lane-rotation-"));
  const laneSequence: string[] = [];
  const pageSizes: number[] = [];
  let activeForSong = 0;
  let maximumActiveForSong = 0;
  const gate = new QQMusicTransportGate({ maxConcurrent: 4, minStartDelayMs: 0 });
  const lanes = Array.from({ length: 8 }, (_unused, index) => {
    const name = `lane-${index + 1}`;
    const client = fakeClient({
      comments: async (_songId, pageSize, pageNo) => {
        laneSequence.push(name);
        pageSizes.push(pageSize);
        activeForSong += 1;
        maximumActiveForSong = Math.max(maximumActiveForSong, activeForSong);
        await Promise.resolve();
        activeForSong -= 1;
        return {
          comments: [comment(`comment-${pageNo}`, String(1_000 - pageNo), "other-user")],
          hasMore: pageNo < 15,
          nextCursor: pageNo < 15 ? String(1_000 - pageNo) : undefined,
        };
      },
    });
    return lane(client, governor(100), gate, name);
  });

  const result = await runQQMusicScan(lanes, {
    ...scanOptions(directory),
    workersPerLane: 1,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.pagesProcessed, 16);
  assert.equal(result.lanes, 8);
  assert.equal(result.workers, 1);
  assert.equal(maximumActiveForSong, 1);
  assert.deepEqual(laneSequence, [
    "lane-1", "lane-2", "lane-3", "lane-4", "lane-5", "lane-6", "lane-7", "lane-8",
    "lane-1", "lane-2", "lane-3", "lane-4", "lane-5", "lane-6", "lane-7", "lane-8",
  ]);
  assert.equal(pageSizes.every((pageSize) => pageSize === 25), true);
});

test("a permanent QQ lane failure hands the unchanged non-empty cursor to the next lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-cursor-failover-"));
  const calls: Array<{ lane: string; cursor?: string }> = [];
  const gate = new QQMusicTransportGate({ maxConcurrent: 4, minStartDelayMs: 0 });
  const first = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, cursor) => {
      calls.push({ lane: "first", cursor });
      return {
        comments: [comment("first-page", "900", "other-user")],
        hasMore: true,
        nextCursor: "900",
      };
    },
  });
  const bad = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, cursor) => {
      calls.push({ lane: "bad", cursor });
      throw new QQMusicProxyError("proxy authentication rejected", 407);
    },
  });
  const final = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, cursor) => {
      calls.push({ lane: "final", cursor });
      return { comments: [], hasMore: false };
    },
  });

  const result = await runQQMusicScan([
    lane(first, governor(20), gate, "first"),
    lane(bad, governor(20), gate, "bad"),
    lane(final, governor(20), gate, "final"),
  ], { ...scanOptions(directory), workersPerLane: 1 });

  assert.equal(result.status, "complete");
  assert.deepEqual(calls, [
    { lane: "first", cursor: undefined },
    { lane: "bad", cursor: "900" },
    { lane: "final", cursor: "900" },
  ]);
});

test("QQ resume validates the requested song before source discovery completes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-requested-song-"));
  const options = { ...scanOptions(directory), target: "123456" };
  const client = fakeClient({ comments: async () => ({ comments: [], hasMore: false }) });
  const first = await runQQMusicScan([lane(client, governor(1))], options);
  assert.equal(first.status, "paused");
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(state?.sourceLoaded, false);
  assert.equal(state?.requestedSongId, "7");

  await assert.rejects(
    runQQMusicScan([lane(client, governor(10))], { ...options, songId: "8" }),
    /checkpoint does not match songId/,
  );
});

test("liked-song mode discovers once and parallelizes across songs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-likes-"));
  let active = 0;
  let maximumActive = 0;
  let discoveryCalls = 0;
  const likedLimits: number[] = [];
  const client = fakeClient({
    liked: async (_encryptUin, _offset, limit): Promise<QQMusicSongPage> => {
      discoveryCalls += 1;
      likedLimits.push(limit);
      return {
        songs: [
          { id: "1", name: "one" },
          { id: "2", name: "two" },
        ],
        hasMore: false,
        nextOffset: 2,
        total: 2,
      };
    },
    comments: async (songId): Promise<QQMusicCommentPage> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {
        comments: [comment(`comment-${songId}`, `${100 - Number(songId)}`, "other-user")],
        hasMore: false,
        total: 1,
      };
    },
  });
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 2,
  };
  const result = await runQQMusicScan([lane(client, governor(20, 2))], options);

  assert.equal(result.status, "complete");
  assert.equal(result.songsComplete, 2);
  assert.equal(discoveryCalls, 1);
  assert.deepEqual(likedLimits, [500]);
  assert.equal(maximumActive, 2);
});

test("QQ likes de-duplicates the same CmId independently for each song", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-song-local-comment-id-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 2,
  };
  await saveQQMusicScanState(options.statePath, pendingLikesState(["1", "2"]));
  const client = fakeClient({
    comments: async (_songId) => ({
      comments: [comment("same-comment", "90", "target-user")],
      hasMore: false,
    }),
  });

  const result = await runQQMusicScan([lane(client, governor(0))], options);
  const state = await loadQQMusicScanState(options.statePath);
  const rows = (await readFile(options.outputPath, "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { songId: string; commentId: string });

  assert.equal(result.matches, 2);
  assert.deepEqual([...state!.seenCommentKeys].sort(), ["1:same-comment", "2:same-comment"]);
  assert.deepEqual(rows.map((row) => `${row.songId}:${row.commentId}`).sort(), [
    "1:same-comment", "2:same-comment",
  ]);
});

test("QQ likes hard-caps Worker loops while keeping every selected Lane reachable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-hard-worker-cap-"));
  const songIds = Array.from({ length: 8 }, (_unused, index) => String(index + 1));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 4,
    maxWorkers: 3,
  };
  await saveQQMusicScanState(options.statePath, pendingLikesState(songIds));
  const gate = new QQMusicTransportGate({ maxConcurrent: 4, minStartDelayMs: 0 });
  const usedLanes: string[] = [];
  let active = 0;
  let maximumActive = 0;
  const lanes = Array.from({ length: 8 }, (_unused, index) => {
    const name = `lane-${index + 1}`;
    return lane(fakeClient({
      comments: async () => {
        usedLanes.push(name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { comments: [], hasMore: false };
      },
    }), governor(0), gate, name);
  });

  const result = await runQQMusicScan(lanes, options);

  assert.equal(result.status, "complete");
  assert.equal(result.workers, 3);
  assert.equal(maximumActive <= 3, true);
  assert.deepEqual([...new Set(usedLanes)].sort(), lanes.map((entry) => entry.name).sort());
});

test("QQ logical comment-page budget is task-wide instead of multiplying by Lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-task-page-budget-"));
  const songIds = Array.from({ length: 10 }, (_unused, index) => String(index + 1));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 2,
    maxWorkers: 8,
    requestBudget: 3,
  };
  await saveQQMusicScanState(options.statePath, pendingLikesState(songIds));
  const gate = new QQMusicTransportGate({ maxConcurrent: 4, minStartDelayMs: 0 });
  let commentCalls = 0;
  const lanes = Array.from({ length: 4 }, (_unused, index) => lane(fakeClient({
    comments: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
  }), governor(0), gate, `lane-${index + 1}`));

  const result = await runQQMusicScan(lanes, options);
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "paused");
  assert.equal(commentCalls, 3);
  assert.equal(state?.pagesProcessed, 3);
  assert.equal(state?.finished, false);
  assert.match(result.note ?? "", /logical comment-page budget/i);
});

test("QQ song keeps requestedSongId authoritative over metadata response IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-requested-song-authority-"));
  const requestedSongIds: string[] = [];
  const client = fakeClient({
    songInfo: async () => ({ id: "999", mid: "metadata-mid", name: "metadata-name" }),
    comments: async (songId) => {
      requestedSongIds.push(songId);
      return { comments: [], hasMore: false };
    },
  });
  const options = scanOptions(directory);

  const result = await runQQMusicScan([lane(client, governor(0))], options);
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "complete");
  assert.deepEqual(requestedSongIds, ["7"]);
  assert.equal(state?.songs[0].id, "7");
  assert.equal(state?.songs[0].mid, "metadata-mid");
});

test("publishes resolved song metadata before the first comment page can cool down", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-song-metadata-progress-"));
  const activities: QQMusicSongActivity[] = [];
  const client = fakeClient({
    songInfo: async (songId) => ({ id: songId, mid: "resolved-mid", name: "Resolved Song" }),
    comments: async () => { throw { status: 429 }; },
  });
  const result = await runQQMusicScan([lane(client, governor(20))], {
    ...scanOptions(directory),
    onSongProgress: (activity) => activities.push(activity),
  });
  assert.equal(result.status, "cooldown");
  assert.equal(activities.some((activity) => activity.songId === "7" && activity.songName === "Resolved Song"), true);
});

test("publishes persisted song metadata before returning a finished checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-finished-song-progress-"));
  const options = scanOptions(directory);
  const state = pendingSongState();
  state.songs[0].name = "Persisted Song";
  state.songs[0].done = true;
  state.finished = true;
  state.coverageComplete = true;
  await saveQQMusicScanState(options.statePath, state);
  const activities: QQMusicSongActivity[] = [];
  const result = await runQQMusicScan([lane(fakeClient({
    comments: async () => { throw new Error("finished state must not request comments"); },
  }), governor(20))], {
    ...options,
    onSongProgress: (activity) => activities.push(activity),
  });
  assert.equal(result.status, "complete");
  assert.equal(activities.some((activity) => activity.done && activity.songName === "Persisted Song"), true);
});

test("QQ cancellation after durable JSONL append does not advance cursor state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-cancel-commit-barrier-"));
  const gate = new QQMusicTransportGate({ maxConcurrent: 1, minStartDelayMs: 0 });
  const client = fakeClient({
    comments: async () => ({
      comments: [comment("durable-ahead-of-state", "90", "target-user")],
      hasMore: false,
    }),
  });
  const selectedLane = lane(client, governor(0), gate);
  const options = scanOptions(directory);

  const result = await runQQMusicScan([selectedLane], {
    ...options,
    onMatch: () => cancelQQMusicLanes([selectedLane]),
  });
  const state = await loadQQMusicScanState(options.statePath);
  const rows = (await readFile(options.outputPath, "utf8")).trim().split("\n");

  assert.equal(result.status, "stopped");
  assert.equal(rows.length, 1);
  assert.equal(state?.pagesProcessed, 0);
  assert.equal(state?.matchCount, 0);
  assert.deepEqual(state?.seenCommentKeys, []);
  assert.equal(state?.songs[0].done, false);
});

test("an external task signal enforces the same post-JSONL commit barrier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-external-cancel-barrier-"));
  const controller = new AbortController();
  const client = fakeClient({
    comments: async () => ({
      comments: [comment("external-durable", "90", "target-user")],
      hasMore: false,
    }),
  });
  const options = scanOptions(directory);

  const result = await runQQMusicScan([lane(client, governor(0))], {
    ...options,
    signal: controller.signal,
    onMatch: () => controller.abort(),
  });
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "stopped");
  assert.equal(state?.pagesProcessed, 0);
  assert.equal(state?.matchCount, 0);
  assert.deepEqual(state?.seenCommentKeys, []);
});

test("a resumed QQ liked source keeps its old page-size 100 and non-zero offset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-liked-resume-size-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
  };
  const oldState = pendingLikesState([], 100);
  oldState.sourceLoaded = false;
  oldState.sourceOffset = 100;
  oldState.sourceTotal = 101;
  await saveQQMusicScanState(options.statePath, oldState);
  const sourceCalls: Array<{ offset: number; limit: number }> = [];
  const client = fakeClient({
    liked: async (_encryptUin, offset, limit) => {
      sourceCalls.push({ offset, limit });
      return {
        songs: [{ id: "101" }],
        hasMore: false,
        nextOffset: 101,
        total: 101,
      };
    },
    comments: async () => ({ comments: [], hasMore: false }),
  });

  const result = await runQQMusicScan([lane(client, governor(20))], options);
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "complete");
  assert.deepEqual(sourceCalls, [{ offset: 100, limit: 100 }]);
  assert.equal(state?.likedPageSize, 100);
  assert.equal(state?.sourceOffset, 101);
});

test("QQ likes flushes every four dirty pages without capping durable in-flight slots at four", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-liked-checkpoint-batch-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 8,
  };
  const songIds = ["1", "2", "3", "4", "5", "6", "7", "8"];
  await saveQQMusicScanState(options.statePath, pendingLikesState(songIds));
  const checkpointPages: number[] = [];
  let active = 0;
  let maximumActive = 0;
  let calls = 0;
  let allRequestsStarted = (): void => {};
  const firstEightStarted = new Promise<void>((resolve) => { allRequestsStarted = resolve; });
  let releaseFirstBatch = (): void => {};
  const firstBatchRelease = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
  const client = fakeClient({
    comments: async (songId) => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (calls === 8) allRequestsStarted();
      await firstBatchRelease;
      active -= 1;
      return {
        comments: [comment(`comment-${songId}`, "90", "other-user")],
        hasMore: false,
      };
    },
  });
  const gate = new QQMusicTransportGate({ maxConcurrent: 8, minStartDelayMs: 0 });

  const running = runQQMusicScan([lane(client, governor(20, 8), gate)], {
    ...options,
    onCheckpoint: (activity) => checkpointPages.push(activity.pagesProcessed),
  });
  await firstEightStarted;
  assert.equal(active, 8);
  assert.equal(calls, 8);
  releaseFirstBatch();
  const result = await running;
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "complete");
  assert.deepEqual(checkpointPages, [4, 8, 8]);
  assert.equal(maximumActive, 8);
  assert.equal(state?.pagesProcessed, 8);
  assert.equal(state?.finished, true);
});

test("optional QQ song metadata cooldown does not poison the required comment lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-metadata-best-effort-"));
  let commentCalls = 0;
  const client = fakeClient({
    songInfo: async () => { throw { status: 403 }; },
    comments: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
  });
  const result = await runQQMusicScan([lane(client, governor(10))], scanOptions(directory));
  assert.equal(result.status, "complete");
  assert.equal(commentCalls, 1);
});

test("permanent QQ protocol errors pause with the cursor resumable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-permanent-"));
  let commentCalls = 0;
  const client = fakeClient({
    comments: async () => {
      commentCalls += 1;
      throw new QQMusicApiError("permanent malformed comment response");
    },
  });
  const options = scanOptions(directory);
  const result = await runQQMusicScan([lane(client, governor(0))], options);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(result.status, "paused");
  assert.equal(result.coverageComplete, false);
  assert.equal(commentCalls, 1);
  assert.equal(state?.songs[0].done, false);
  assert.equal(state?.songs[0].truncated, false);
  assert.match(state?.songs[0].lastError ?? "", /permanent malformed/);
});

test("an unavailable QQ song resource truncates without a retry loop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-resource-gone-"));
  let commentCalls = 0;
  const client = fakeClient({
    comments: async () => {
      commentCalls += 1;
      throw new QQMusicApiError("song comments are gone", 404);
    },
  });
  const options = scanOptions(directory);
  const result = await runQQMusicScan([lane(client, governor(0))], options);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(result.status, "complete");
  assert.equal(result.coverageComplete, false);
  assert.equal(commentCalls, 1);
  assert.equal(state?.songs[0].truncated, true);
});

test("a permanently bad QQ proxy lane fails over without truncating the song", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-proxy-failover-"));
  const calls: string[] = [];
  const badClient = fakeClient({
    comments: async () => {
      calls.push("bad");
      throw new QQMusicProxyError("proxy authentication rejected", 407);
    },
  });
  const goodClient = fakeClient({
    comments: async () => {
      calls.push("good");
      return { comments: [], hasMore: false };
    },
  });
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  const options = { ...scanOptions(directory), workersPerLane: 1 };
  const result = await runQQMusicScan([
    lane(badClient, governor(10), gate, "bad"),
    lane(goodClient, governor(10), gate, "good"),
  ], options);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(result.status, "complete");
  assert.deepEqual(calls, ["bad", "good"]);
  assert.equal(state?.songs[0].truncated, false);
});

test("a proxy CONNECT 404 is a Lane failure, never a song-resource truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-proxy-404-"));
  const calls: string[] = [];
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  const options = { ...scanOptions(directory), workersPerLane: 1 };
  const result = await runQQMusicScan([
    lane(fakeClient({
      comments: async () => {
        calls.push("proxy-404");
        throw new QQMusicProxyError("CONNECT target rejected", 404);
      },
    }), governor(0), gate, "proxy-404"),
    lane(fakeClient({
      comments: async () => {
        calls.push("healthy");
        return { comments: [], hasMore: false };
      },
    }), governor(0), gate, "healthy"),
  ], options);
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "complete");
  assert.deepEqual(calls, ["proxy-404", "healthy"]);
  assert.equal(state?.songs[0].truncated, false);
});

test("QQ business code 301 pauses without becoming a NetEase authentication prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-business-301-"));
  const client = fakeClient({
    comments: async () => {
      throw new QQMusicApiError("QQ business 301", undefined, { code: 301 });
    },
  });

  const result = await runQQMusicScan([lane(client, governor(0))], scanOptions(directory));

  assert.equal(result.status, "paused");
  assert.match(result.note ?? "", /QQ business 301/);
  assert.doesNotMatch(result.note ?? "", /网易云|二维码登录/);
});

test("a deterministic QQ control error is not replayed through every lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-control-deterministic-"));
  const calls: string[] = [];
  const first = fakeClient({
    resolveUser: async () => {
      calls.push("first");
      throw new QQMusicApiError("profile is private");
    },
    comments: async () => ({ comments: [], hasMore: false }),
  });
  const second = fakeClient({
    resolveUser: async (input) => {
      calls.push("second");
      return { input, encryptUin: "target-user" };
    },
    comments: async () => ({ comments: [], hasMore: false }),
  });
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  await assert.rejects(runQQMusicScan([
    lane(first, governor(10), gate, "first"),
    lane(second, governor(10), gate, "second"),
  ], { ...scanOptions(directory), target: "123456" }), /profile is private/);
  assert.deepEqual(calls, ["first"]);
});

test("QQ per-song page cap clears the cursor while preserving incomplete coverage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-page-cap-"));
  const client = fakeClient({
    comments: async () => ({
      comments: [comment("one", "90", "other-user")],
      hasMore: true,
      nextCursor: "90",
    }),
  });
  const options = { ...scanOptions(directory), maxCommentPagesPerSong: 1 };
  const result = await runQQMusicScan([lane(client, governor(10))], options);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(result.status, "complete");
  assert.equal(result.coverageComplete, false);
  assert.equal(state?.songs[0].truncated, true);
  assert.equal(state?.songs[0].cursor, undefined);
});

test("QQ cooldown is persisted and blocks an immediate resumed request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-cooldown-"));
  let commentCalls = 0;
  const blockedClient = fakeClient({
    comments: async () => {
      commentCalls += 1;
      throw { status: 429 };
    },
  });
  const options = scanOptions(directory);
  const first = await runQQMusicScan([lane(blockedClient, governor(10))], options);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(first.status, "cooldown");
  assert.equal(Boolean(state?.cooldownUntil), true);

  const healthyClient = fakeClient({
    comments: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
  });
  const resumedActivities: QQMusicSongActivity[] = [];
  const second = await runQQMusicScan([lane(healthyClient, governor(10))], {
    ...options,
    onSongProgress: (activity) => resumedActivities.push(activity),
  });
  assert.equal(second.status, "cooldown");
  assert.equal(second.requestsThisRun, 0);
  assert.equal(commentCalls, 1);
  assert.equal(resumedActivities.some((activity) => activity.songName === "song-7"), true);
});

test("QQ cooldown wins over permanently unavailable lanes and remains resumable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-mixed-cooldown-"));
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  const unavailable = fakeClient({
    comments: async () => { throw new QQMusicProxyError("proxy authentication rejected", 407); },
  });
  const cooling = fakeClient({
    comments: async () => { throw { status: 429 }; },
  });
  const options = { ...scanOptions(directory), workersPerLane: 1 };

  const result = await runQQMusicScan([
    lane(unavailable, governor(10), gate, "unavailable"),
    lane(cooling, governor(10), gate, "cooling"),
  ], options);
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "cooldown");
  assert.equal(Boolean(state?.cooldownUntil), true);
  assert.equal(state?.songs[0].done, false);
  assert.equal(state?.songs[0].cursor, undefined);
});

test("QQ liked-song source cannot claim coverage before its declared total", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-liked-total-"));
  const client = fakeClient({
    liked: async () => ({
      songs: [{ id: "1" }],
      hasMore: false,
      nextOffset: 1,
      total: 2,
    }),
    comments: async () => ({ comments: [], hasMore: false }),
  });
  const result = await runQQMusicScan([lane(client, governor(10))], {
    ...scanOptions(directory),
    mode: "likes",
    songId: undefined,
  });
  assert.equal(result.status, "paused");
  assert.equal(result.coverageComplete, false);
  assert.match(result.note ?? "", /before declared total/);
});

test("QQ result/checkpoint reconciliation counts a durable pre-existing match once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-reconcile-"));
  const options = scanOptions(directory);
  await writeFile(options.outputPath, `${JSON.stringify({ songId: "7", commentId: "durable-match" })}\n`, "utf8");
  const client = fakeClient({
    comments: async () => ({
      comments: [comment("durable-match", "90", "target-user")],
      hasMore: false,
    }),
  });
  const result = await runQQMusicScan([lane(client, governor(10))], options);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(result.matches, 1);
  assert.deepEqual(state?.seenCommentKeys, ["7:durable-match"]);
  assert.equal((await readFile(options.outputPath, "utf8")).trim().split("\n").length, 1);
});

test("stopping after a durable QQ likes append leaves state replayable without duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-liked-stop-flush-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 2,
  };
  await saveQQMusicScanState(options.statePath, pendingLikesState());
  let matchWritten = (): void => {};
  const durableMatch = new Promise<void>((resolve) => { matchWritten = resolve; });
  const firstClient = fakeClient({
    comments: async (songId, _pageSize, _pageNo, _cursor, signal) => {
      if (songId === "1") {
        return {
          comments: [comment("durable-batched-match", "90", "target-user")],
          hasMore: false,
        };
      }
      return new Promise<QQMusicCommentPage>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    },
  });
  const firstGate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  const firstLane = lane(firstClient, governor(20, 2), firstGate);
  const running = runQQMusicScan([firstLane], {
    ...options,
    onMatch: () => matchWritten(),
  });
  await durableMatch;
  cancelQQMusicLanes([firstLane]);
  const stopped = await running;
  const stoppedState = await loadQQMusicScanState(options.statePath);

  assert.equal(stopped.status, "stopped");
  assert.equal(stoppedState?.matchCount, 0);
  assert.deepEqual(stoppedState?.seenCommentKeys, []);
  assert.equal(stoppedState?.songs.find((song) => song.id === "1")?.done, false);
  assert.equal(stoppedState?.songs.find((song) => song.id === "2")?.done, false);

  const resumedClient = fakeClient({
    comments: async (songId) => ({
      comments: songId === "1"
        ? [comment("durable-batched-match", "90", "target-user")]
        : [],
      hasMore: false,
    }),
  });
  const resumed = await runQQMusicScan(
    [lane(resumedClient, governor(20))],
    { ...options, workersPerLane: 1 },
  );
  const lines = (await readFile(options.outputPath, "utf8")).trim().split("\n");

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.matches, 1);
  assert.equal(lines.length, 1);
});

test("a failed QQ likes batch leaves JSONL ahead of state and resume reconciles it once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-liked-batch-failure-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 1,
  };
  const initialState = pendingLikesState(["1"]);
  await saveQQMusicScanState(options.statePath, initialState);
  let sabotaged = false;
  const client = fakeClient({
    comments: async () => ({
      comments: [comment("durable-before-batch", "90", "target-user")],
      hasMore: false,
    }),
  });

  const failed = await runQQMusicScan([lane(client, governor(20))], {
    ...options,
    onMatch: () => {
      if (sabotaged) return;
      sabotaged = true;
      rmSync(options.statePath);
      mkdirSync(options.statePath);
    },
  });

  assert.equal(failed.status, "paused");
  assert.match(failed.note ?? "", /checkpoint failed/);
  assert.equal((await readFile(options.outputPath, "utf8")).trim().split("\n").length, 1);

  rmSync(options.statePath, { recursive: true });
  await saveQQMusicScanState(options.statePath, initialState);
  const resumed = await runQQMusicScan([lane(client, governor(20))], options);
  const state = await loadQQMusicScanState(options.statePath);
  const lines = (await readFile(options.outputPath, "utf8")).trim().split("\n");

  assert.equal(resumed.status, "complete");
  assert.equal(resumed.matches, 1);
  assert.equal(state?.matchCount, 1);
  assert.deepEqual(state?.seenCommentKeys, ["1:durable-before-batch"]);
  assert.equal(lines.length, 1);
});

test("cancelling an in-flight QQ page aborts it, reports stopped, and does not advance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-cancel-final-"));
  let requestStarted = (): void => {};
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const client = fakeClient({
    comments: async (_songId, _pageSize, _pageNo, _cursor, signal) => {
      requestStarted();
      return new Promise<QQMusicCommentPage>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    },
  });
  const gate = new QQMusicTransportGate({ maxConcurrent: 1, minStartDelayMs: 0 });
  const selectedLane = lane(client, governor(10), gate);
  const options = scanOptions(directory);
  const running = runQQMusicScan([selectedLane], options);
  await started;
  cancelQQMusicLanes([selectedLane]);
  const result = await Promise.race([
    running,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("QQ cancellation did not abort the in-flight request.")), 500);
    }),
  ]);
  const state = await loadQQMusicScanState(options.statePath);
  assert.equal(result.status, "stopped");
  assert.equal(state?.pagesProcessed, 0);
  assert.equal(state?.songs[0].done, false);
});

test("QQ JSONL sync failure pauses globally without retrying through another Lane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-result-sync-failure-"));
  const options = scanOptions(directory);
  const commentLanes: string[] = [];
  let writes = 0;
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  const first = fakeClient({
    comments: async () => {
      commentLanes.push("first");
      return {
        comments: [comment("durability-unknown", "90", "target-user")],
        hasMore: false,
      };
    },
  });
  const second = fakeClient({
    comments: async () => {
      commentLanes.push("second");
      return {
        comments: [comment("durability-unknown", "90", "target-user")],
        hasMore: false,
      };
    },
  });

  const result = await runQQMusicScan([
    lane(first, governor(10), gate, "first"),
    lane(second, governor(10), gate, "second"),
  ], options, {
    createResultWriter: (path, onAppend) => new QQMusicResultWriter(path, onAppend, {
      openAppendFile: async () => ({
        write: async () => { writes += 1; },
        sync: async () => { throw new Error("disk sync failed"); },
        close: async () => {},
      }),
    }),
  });
  const state = await loadQQMusicScanState(options.statePath);

  assert.equal(result.status, "paused");
  assert.match(result.note ?? "", /result persistence failed/i);
  assert.deepEqual(commentLanes, ["first"]);
  assert.equal(writes, 1);
  assert.equal(state?.pagesProcessed, 0);
  assert.deepEqual(state?.seenCommentKeys, []);
});

test("QQ JSONL failure drains an in-flight likes checkpoint before the scan returns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-result-flush-drain-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 1,
    maxWorkers: 2,
  };
  await saveQQMusicScanState(options.statePath, pendingLikesState(["1", "2"]));

  let announceSaveStarted = (): void => {};
  const saveStarted = new Promise<void>((resolve) => { announceSaveStarted = resolve; });
  let releaseSave = (): void => {};
  const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
  let announceSyncFailed = (): void => {};
  const syncFailed = new Promise<void>((resolve) => { announceSyncFailed = resolve; });
  const client = fakeClient({
    comments: async (songId) => {
      if (songId === "1") return { comments: [], hasMore: false };
      await saveStarted;
      return {
        comments: [comment("flush-race", "90", "target-user")],
        hasMore: false,
      };
    },
  });
  const gate = new QQMusicTransportGate({ maxConcurrent: 2, minStartDelayMs: 0 });
  let settled = false;
  const running = runQQMusicScan([
    lane(client, governor(10), gate, "one"),
    lane(client, governor(10), gate, "two"),
  ], options, {
    createResultWriter: (path, onAppend) => new QQMusicResultWriter(path, onAppend, {
      openAppendFile: async () => ({
        write: async () => {},
        sync: async () => {
          announceSyncFailed();
          throw new Error("disk sync failed during checkpoint");
        },
        close: async () => {},
      }),
    }),
    saveState: async (path, snapshot) => {
      announceSaveStarted();
      await saveReleased;
      await saveQQMusicScanState(path, snapshot);
    },
  }).then((report) => {
    settled = true;
    return report;
  });

  await syncFailed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedBeforeFlush = settled;
  releaseSave();
  const result = await running;

  assert.equal(returnedBeforeFlush, false);
  assert.equal(result.status, "paused");
  assert.match(result.note ?? "", /result persistence failed/i);
});

test("QQ checkpoint failure pauses globally without requesting the successful page again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-checkpoint-failure-"));
  const options = scanOptions(directory);
  let commentCalls = 0;
  let sabotaged = false;
  const client = fakeClient({
    comments: async () => {
      commentCalls += 1;
      return { comments: [], hasMore: false };
    },
  });
  const result = await runQQMusicScan([lane(client, governor(10))], {
    ...options,
    onRequestActivity: (activity) => {
      if (activity.phase !== "success" || sabotaged) return;
      sabotaged = true;
      rmSync(options.statePath);
      mkdirSync(options.statePath);
    },
  });
  assert.equal(result.status, "paused");
  assert.match(result.note ?? "", /checkpoint failed/);
  assert.equal(commentCalls, 1);
});

test("QQ checkpoint failure cancels a second worker waiting in the shared gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qq-checkpoint-gate-cancel-"));
  const options = {
    ...scanOptions(directory),
    mode: "likes" as const,
    songId: undefined,
    workersPerLane: 2,
  };
  await saveQQMusicScanState(options.statePath, pendingLikesState());
  const calls: string[] = [];
  const client = fakeClient({
    comments: async (songId) => {
      calls.push(songId);
      return { comments: [], hasMore: false };
    },
  });
  const gate = new QQMusicTransportGate(
    { maxConcurrent: 2, minStartDelayMs: 250 },
    { now: () => 100, sleep: () => new Promise<void>(() => {}) },
  );
  let sabotaged = false;
  let checkpointCallbacks = 0;
  const result = await runQQMusicScan([lane(client, governor(10, 2), gate)], {
    ...options,
    onCheckpoint: () => { checkpointCallbacks += 1; },
    onRequestActivity: (activity) => {
      if (activity.phase !== "success" || sabotaged) return;
      sabotaged = true;
      rmSync(options.statePath);
      mkdirSync(options.statePath);
    },
  });
  assert.equal(result.status, "paused");
  assert.equal(calls.length, 1);
  assert.equal(checkpointCallbacks, 1);
});

function fakeClient(overrides: {
  comments: QQMusicPlatformClient["getNewComments"];
  liked?: QQMusicPlatformClient["getLikedSongsPage"];
  songInfo?: QQMusicPlatformClient["getSongInfo"];
  resolveUser?: QQMusicPlatformClient["resolveUser"];
}): QQMusicPlatformClient {
  return {
    resolveUser: overrides.resolveUser
      ?? (async (input) => ({ input, encryptUin: "target-user" })),
    getSongInfo: overrides.songInfo
      ?? (async (songId) => ({ id: songId, mid: `mid-${songId}`, name: `song-${songId}` })),
    getLikedSongsPage: overrides.liked ?? (async () => ({
      songs: [], hasMore: false, nextOffset: 0, total: 0,
    })),
    getNewComments: overrides.comments,
  };
}

function comment(commentId: string, seqNo: string, authorEncryptUin: string) {
  return {
    commentId,
    seqNo,
    authorEncryptUin,
    content: commentId,
    time: 1_700_000_000_000,
  };
}

function scanOptions(directory: string): QQMusicScanOptions {
  return {
    mode: "song",
    target: "target-user",
    songId: "7",
    pageSize: 25,
    likedPageSize: 500,
    maxSongs: 0,
    maxCommentPagesPerSong: 0,
    workersPerLane: 2,
    maxWorkers: 8,
    requestBudget: 0,
    stopAfterFirst: false,
    fresh: false,
    statePath: join(directory, "state.json"),
    outputPath: join(directory, "comments.jsonl"),
  };
}

function lane(
  client: QQMusicPlatformClient,
  requestGovernor: RequestGovernor,
  transportGate = new QQMusicTransportGate({ maxConcurrent: 8, minStartDelayMs: 0 }),
  name = "direct",
): QQCommentLane {
  return { name, client, governor: requestGovernor, transportGate };
}

function governor(requestBudget: number, concurrency = 1): RequestGovernor {
  return new RequestGovernor({
    concurrency,
    requestBudget,
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 0,
    forbiddenCooldownMs: 1_000,
    platformPolicy: "qq",
  });
}

function pendingLikesState(
  songIds: string[] = ["1", "2"],
  likedPageSize = 500,
): QQMusicScanState {
  const now = "2026-08-07T00:00:00.000Z";
  return {
    version: 1,
    kind: "qq-comment-scan",
    mode: "likes",
    targetInput: "target-user",
    targetEncryptUin: "target-user",
    commentPagination: "seqno-v1",
    pageSize: 25,
    likedPageSize,
    maxSongs: 0,
    maxCommentPagesPerSong: 0,
    sourceLoaded: true,
    sourceTruncated: false,
    sourceOffset: songIds.length,
    sourceTotal: songIds.length,
    songs: songIds.map((id) => ({
      id,
      artists: [],
      pageNo: 0,
      pagesProcessed: 0,
      commentsInspected: 0,
      done: false,
      truncated: false,
    })),
    pagesProcessed: 0,
    commentsInspected: 0,
    matchCount: 0,
    seenCommentKeys: [],
    requestCount: 0,
    finished: false,
    coverageComplete: false,
    createdAt: now,
    updatedAt: now,
  };
}

function pendingSongState(): QQMusicScanState {
  const now = "2026-08-07T00:00:00.000Z";
  return {
    version: 1,
    kind: "qq-comment-scan",
    mode: "song",
    targetInput: "target-user",
    targetEncryptUin: "target-user",
    requestedSongId: "7",
    commentPagination: "seqno-v1",
    pageSize: 25,
    likedPageSize: 500,
    maxSongs: 0,
    maxCommentPagesPerSong: 0,
    sourceLoaded: true,
    sourceTruncated: false,
    sourceOffset: 1,
    sourceTotal: 1,
    songs: [{
      id: "7",
      artists: [],
      pageNo: 0,
      pagesProcessed: 0,
      commentsInspected: 0,
      done: false,
      truncated: false,
    }],
    pagesProcessed: 0,
    commentsInspected: 0,
    matchCount: 0,
    seenCommentKeys: [],
    requestCount: 0,
    finished: false,
    coverageComplete: false,
    createdAt: now,
    updatedAt: now,
  };
}
