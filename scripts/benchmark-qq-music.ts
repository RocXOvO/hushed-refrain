import { modelQQMusicBenchmark, type QQMusicBenchmarkInput } from "../src/qq-music/benchmark";

const common = {
  workersPerLane: 1,
  maxWorkers: 32,
  songCount: 1,
  pagesPerSong: 1_000,
  minDelayMs: 3_000,
  averageJitterMs: 500,
  gateMaxConcurrent: 1,
  gateMinStartDelayMs: 250,
  averageRequestMs: 150,
  averageCheckpointMs: 20,
  averageCheckpointBytes: 250_000,
} satisfies Omit<QQMusicBenchmarkInput, "mode" | "lanes" | "pageSize">;

const scenarios: Array<{ name: string; input: QQMusicBenchmarkInput }> = [
  { name: "song-4-lanes-page-1", input: { ...common, mode: "song", lanes: 4, pageSize: 1 } },
  { name: "song-4-lanes-page-25", input: { ...common, mode: "song", lanes: 4, pageSize: 25 } },
  { name: "song-8-lanes-page-25", input: { ...common, mode: "song", lanes: 8, pageSize: 25 } },
  { name: "song-1-lane-page-25", input: { ...common, mode: "song", lanes: 1, pageSize: 25 } },
  {
    name: "likes-8-lanes-comment-page-25",
    input: {
      ...common,
      mode: "likes",
      lanes: 8,
      workersPerLane: 4,
      songCount: 100,
      pagesPerSong: 10,
      pageSize: 25,
      sourceRequests: 2,
      gateMaxConcurrent: 32,
      gateMinStartDelayMs: 80,
      checkpointIntervalMs: 400,
      checkpointPageCap: 4,
      checkpointSlots: 32,
      averageCheckpointBatchPages: 2,
    },
  },
  {
    name: "likes-32-lanes-adaptive-gate-32",
    input: {
      ...common,
      mode: "likes",
      lanes: 32,
      workersPerLane: 1,
      songCount: 100,
      pagesPerSong: 10,
      pageSize: 25,
      sourceRequests: 2,
      gateMaxConcurrent: 32,
      gateMinStartDelayMs: 80,
      checkpointIntervalMs: 400,
      checkpointPageCap: 4,
      checkpointSlots: 32,
      averageCheckpointBatchPages: 2,
    },
  },
  {
    name: "likes-32-lanes-legacy-gate-4",
    input: {
      ...common,
      mode: "likes",
      lanes: 32,
      workersPerLane: 1,
      songCount: 100,
      pagesPerSong: 10,
      pageSize: 25,
      sourceRequests: 2,
      gateMaxConcurrent: 4,
      gateMinStartDelayMs: 250,
      checkpointIntervalMs: 400,
      checkpointPageCap: 4,
      checkpointSlots: 4,
      averageCheckpointBatchPages: 2,
    },
  },
];

const results = scenarios.map(({ name, input }) => ({
  name,
  input,
  result: modelQQMusicBenchmark(input),
}));
const byName = new Map(results.map((entry) => [entry.name, entry.result]));
const pageOne = byName.get("song-4-lanes-page-1")!;
const fourLanes = byName.get("song-4-lanes-page-25")!;
const eightLanes = byName.get("song-8-lanes-page-25")!;
const oneLane = byName.get("song-1-lane-page-25")!;
const adaptiveLikes = byName.get("likes-32-lanes-adaptive-gate-32")!;
const legacyGateLikes = byName.get("likes-32-lanes-legacy-gate-4")!;

process.stdout.write(`${JSON.stringify({
  model: "qq-delay-bound-v1",
  assumptions: {
    jitter: "deterministic mean input",
    network: "no real QQ Music traffic",
    perSongConcurrency: 1,
    perLaneRate: "workers do not multiply one IP's start rate",
  },
  comparisons: {
    page25VsPage1AtFourLanes: fourLanes.commentsPerSecond / pageOne.commentsPerSecond,
    eightLanesVsFourLanesAtPage25: eightLanes.commentsPerSecond / fourLanes.commentsPerSecond,
    oneLaneCommentsPerSecondAtPage25: oneLane.commentsPerSecond,
    adaptiveGate32VsLegacyFixed4: adaptiveLikes.commentsPerSecond / legacyGateLikes.commentsPerSecond,
    adaptiveGate32CommentsPerSecond: adaptiveLikes.commentsPerSecond,
    legacyFixed4CommentsPerSecond: legacyGateLikes.commentsPerSecond,
    likedSourceDiscovery: {
      oldLikedPageSize100Requests: 10,
      newLikedPageSize500Requests: 2,
      requestReduction: 0.8,
      oldDelayBoundMs: 10 * (common.minDelayMs + common.averageJitterMs),
      newDelayBoundMs: 2 * (common.minDelayMs + common.averageJitterMs),
    },
  },
  scenarios: results,
}, null, 2)}\n`);
