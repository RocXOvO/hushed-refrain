import assert from "node:assert/strict";
import test from "node:test";
import { modelQQMusicBenchmark, type QQMusicBenchmarkInput } from "../src/qq-music/benchmark";

const base: Omit<QQMusicBenchmarkInput, "mode" | "lanes" | "pageSize"> = {
  workersPerLane: 1,
  maxWorkers: 8,
  songCount: 1,
  pagesPerSong: 10_000,
  minDelayMs: 3_000,
  averageJitterMs: 500,
  gateMaxConcurrent: 4,
  gateMinStartDelayMs: 250,
  averageRequestMs: 150,
  averageCheckpointMs: 20,
  averageCheckpointBytes: 250_000,
};

test("QQ delay-bound model reaches about 2x comments throughput with 8 vs 4 exits", () => {
  const fourLanes = modelQQMusicBenchmark({ ...base, mode: "song", lanes: 4, pageSize: 25 });
  const eightLanes = modelQQMusicBenchmark({ ...base, mode: "song", lanes: 8, pageSize: 25 });
  const ratio = eightLanes.commentsPerSecond / fourLanes.commentsPerSecond;

  assert.ok(ratio > 1.99 && ratio < 2.01, `expected about 2x, got ${ratio}`);
  assert.equal(eightLanes.maxSameSongConcurrent, 1);
  assert.equal(eightLanes.participatingLanes, 8);
  assert.equal(eightLanes.requests, eightLanes.pages);
  assert.equal(eightLanes.controlCheckpointWrites, 3);
});

test("QQ benchmark rejects comment pages above the live endpoint limit", () => {
  assert.throws(
    () => modelQQMusicBenchmark({ ...base, mode: "song", lanes: 1, pageSize: 26 }),
    /cannot exceed.*25/,
  );
});

test("QQ benchmark keeps valid page-size scaling explicit without calling it an old baseline", () => {
  const pageOne = modelQQMusicBenchmark({ ...base, mode: "song", lanes: 4, pageSize: 1 });
  const pageTwentyFive = modelQQMusicBenchmark({ ...base, mode: "song", lanes: 4, pageSize: 25 });
  const ratio = pageTwentyFive.commentsPerSecond / pageOne.commentsPerSecond;
  assert.ok(ratio > 24.99 && ratio < 25.01, `expected 25x model scaling, got ${ratio}`);
});

test("QQ likes model reports source requests and bounded cross-song concurrency", () => {
  const result = modelQQMusicBenchmark({
    ...base,
    mode: "likes",
    lanes: 8,
    workersPerLane: 4,
    songCount: 100,
    pagesPerSong: 10,
    pageSize: 25,
    sourceRequests: 2,
    checkpointIntervalMs: 400,
    checkpointPageCap: 4,
    checkpointSlots: 8,
    averageCheckpointBatchPages: 2,
  });

  assert.equal(result.mode, "likes");
  assert.equal(result.pages, 1_000);
  assert.equal(result.comments, 25_000);
  assert.equal(result.requests, 1_002);
  assert.equal(result.maxSameSongConcurrent, 1);
  assert.equal(result.participatingLanes, 8);
  assert.equal(result.pageCheckpointWrites, 500);
  assert.equal(result.controlCheckpointWrites, 4);
  assert.equal(result.checkpointWrites, result.pageCheckpointWrites + 4);
  assert.equal(result.checkpointBytes, result.checkpointWrites * 250_000);
  assert.equal(result.sourceDurationMs, 7_000);
});

test("QQ likes dynamic 32-slot gate removes the legacy task-wide four-slot ceiling", () => {
  const shared = {
    ...base,
    mode: "likes" as const,
    lanes: 32,
    workersPerLane: 1,
    maxWorkers: 32,
    songCount: 100,
    pagesPerSong: 10,
    pageSize: 25,
    checkpointIntervalMs: 400,
    checkpointPageCap: 4,
    averageCheckpointBatchPages: 2,
  };
  const legacy = modelQQMusicBenchmark({
    ...shared,
    gateMaxConcurrent: 4,
    gateMinStartDelayMs: 250,
    checkpointSlots: 4,
  });
  const adaptive = modelQQMusicBenchmark({
    ...shared,
    gateMaxConcurrent: 32,
    gateMinStartDelayMs: 80,
    checkpointSlots: 32,
  });

  assert.ok(adaptive.commentsPerSecond > legacy.commentsPerSecond * 2);
  assert.equal(adaptive.maxSameSongConcurrent, 1);
});

test("QQ likes workers share each lane's pacing while overlapping slow requests", () => {
  const oneWorker = modelQQMusicBenchmark({
    ...base,
    mode: "likes",
    lanes: 1,
    workersPerLane: 1,
    songCount: 20,
    pagesPerSong: 10,
    pageSize: 25,
    averageRequestMs: 6_000,
    gateMaxConcurrent: 10,
  });
  const fourWorkers = modelQQMusicBenchmark({
    ...base,
    mode: "likes",
    lanes: 1,
    workersPerLane: 4,
    songCount: 20,
    pagesPerSong: 10,
    pageSize: 25,
    averageRequestMs: 6_000,
    gateMaxConcurrent: 10,
  });

  assert.ok(fourWorkers.durationMs < oneWorker.durationMs * 0.6);
  assert.ok(fourWorkers.pagesPerSecond > oneWorker.pagesPerSecond * 1.6);
});

test("QQ likes benchmark applies the host Worker hard cap without reducing Lane participation", () => {
  const result = modelQQMusicBenchmark({
    ...base,
    mode: "likes",
    lanes: 8,
    workersPerLane: 4,
    maxWorkers: 3,
    songCount: 100,
    pagesPerSong: 10,
    pageSize: 25,
    averageRequestMs: 6_000,
  });

  assert.equal(result.workers, 3);
  assert.equal(result.participatingLanes, 8);
});

test("QQ benchmark total duration includes control checkpoint IO", () => {
  const withoutCheckpointIo = modelQQMusicBenchmark({
    ...base,
    mode: "song",
    lanes: 1,
    pageSize: 25,
    averageCheckpointMs: 0,
  });
  const withCheckpointIo = modelQQMusicBenchmark({
    ...base,
    mode: "song",
    lanes: 1,
    pageSize: 25,
    averageCheckpointMs: 20,
  });

  assert.equal(
    withCheckpointIo.durationMs - withoutCheckpointIo.durationMs,
    (1 + withCheckpointIo.controlCheckpointWrites) * 20,
  );
});
