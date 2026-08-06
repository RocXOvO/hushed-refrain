import { CooldownRequired, RequestBudgetExhausted, RunCancelled } from "./errors";
import { RequestGovernor } from "./governor";
import { JsonlResultWriter } from "./results";
import {
  assertCompatibleState,
  createState,
  loadState,
  saveState,
} from "./state";
import type {
  FoundComment,
  NcmClient,
  RunReport,
  ScanOptions,
  ScanState,
  SongCandidate,
} from "./types";

export async function runCommentFinder(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
): Promise<RunReport> {
  const loadedState = options.fresh ? undefined : await loadState(options.statePath);
  if (loadedState) assertCompatibleState(loadedState, options);

  const initialRequests = loadedState?.requestCount ?? 0;
  const provisionalStrategy = options.strategy === "history" ? "history" : "scan";
  const state = loadedState ?? createState(options, provisionalStrategy);

  if (state.blockedUntil) {
    const resumeAt = Date.parse(state.blockedUntil);
    if (Number.isFinite(resumeAt) && resumeAt > Date.now()) {
      return report(state, governor, options, initialRequests, "cooldown", {
        resumeAfter: state.blockedUntil,
        note: "Remote cooldown is still active; the checkpoint was left unchanged.",
      });
    }
    delete state.blockedUntil;
  }

  const writer = new JsonlResultWriter(options.outputPath);
  await writer.initialize();

  const checkpoint = async (): Promise<void> => {
    state.requestCount = initialRequests + governor.requestsUsed;
    await saveState(options.statePath, state);
  };

  try {
    if (!state.strategyResolved) {
      state.strategy = await selectStrategy(client, governor, options);
      state.strategyResolved = true;
      state.sourcesLoaded = state.strategy === "history";
      await checkpoint();
    }

    if (state.finished) {
      return report(state, governor, options, initialRequests, "complete");
    }

    if (state.strategy === "history") {
      if (!options.cookie) {
        throw new Error("The history strategy requires a logged-in cookie.");
      }
      return await runHistory(client, governor, options, state, writer, checkpoint, initialRequests);
    }

    return await runSongScan(client, governor, options, state, writer, checkpoint, initialRequests);
  } catch (error) {
    if (error instanceof CooldownRequired) {
      state.blockedUntil = new Date(Date.now() + error.retryAfterMs).toISOString();
      await checkpoint();
      return report(state, governor, options, initialRequests, "cooldown", {
        resumeAfter: state.blockedUntil,
        note: `Remote status ${error.status}; stopped without retrying the blocked request.`,
      });
    }
    if (error instanceof RequestBudgetExhausted) {
      await checkpoint();
      return report(state, governor, options, initialRequests, "paused", {
        note: `This run reached its request budget (${error.budget}). Run the same command to resume.`,
      });
    }
    if (error instanceof RunCancelled) {
      await checkpoint();
      return report(state, governor, options, initialRequests, "stopped", {
        note: "Stopped by the operator; run the same task to resume from this checkpoint.",
      });
    }
    await checkpoint();
    throw error;
  }
}

async function selectStrategy(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
): Promise<"scan" | "history"> {
  if (options.strategy === "scan") return "scan";
  if (options.strategy === "history") return "history";
  if (!options.cookie) return "scan";

  const profile = await governor.execute("login_status", () =>
    client.getLoginProfile(options.cookie),
  );
  return profile?.userId === options.uid ? "history" : "scan";
}

async function runHistory(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
  state: ScanState,
  writer: JsonlResultWriter,
  checkpoint: () => Promise<void>,
  initialRequests: number,
): Promise<RunReport> {
  while (true) {
    const page = await governor.execute("user_comment_history", () =>
      client.getUserCommentHistory(
        options.uid,
        options.historyPageSize,
        state.historyTime,
        options.cookie!,
      ),
    );

    const matches = page.comments.filter((comment) => comment.userId === options.uid);
    const added = await appendMatches(writer, state, matches.map((comment) => ({
      ...comment,
      route: "user-history" as const,
      capturedAt: new Date().toISOString(),
    })));

    if (added > 0 && options.stopAfterFirst) {
      await checkpoint();
      return report(state, governor, options, initialRequests, "paused", {
        note: "Stopped after the first match; rerun without --stop-after-first for full coverage.",
      });
    }

    if (!page.hasMore) {
      state.finished = true;
      state.coverageComplete = true;
      await checkpoint();
      return report(state, governor, options, initialRequests, "complete");
    }

    if (!page.nextTime || page.nextTime === state.historyTime) {
      throw new Error("History pagination returned hasMore without a new time cursor.");
    }
    state.historyTime = page.nextTime;
    await checkpoint();
  }
}

async function runSongScan(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
  state: ScanState,
  writer: JsonlResultWriter,
  checkpoint: () => Promise<void>,
  initialRequests: number,
): Promise<RunReport> {
  if (!state.sourcesLoaded) {
    const collected = await collectSongs(client, governor, options);
    const songs = collected.songs;
    state.sourceSongCount = songs.length;
    state.sourceTruncated = options.maxSongs > 0 && songs.length > options.maxSongs;
    state.songs = options.maxSongs > 0 ? songs.slice(0, options.maxSongs) : songs;
    state.sourceErrors = collected.failures;
    state.sourcesLoaded = true;
    await checkpoint();
  }

  if (options.dryRun) {
    return report(state, governor, options, initialRequests, "dry-run", {
      note: estimateNote(state, options),
    });
  }

  while (state.songIndex < state.songs.length) {
    const song = state.songs[state.songIndex];

    if (
      options.maxCommentPagesPerSong > 0 &&
      state.pageInSong >= options.maxCommentPagesPerSong
    ) {
      if (!state.truncatedSongIds.includes(song.id)) state.truncatedSongIds.push(song.id);
      advanceSong(state);
      await checkpoint();
      continue;
    }

    const page = await governor.execute(`comment_music:${song.id}`, () =>
      client.getSongComments(
        song.id,
        options.commentPageSize,
        state.commentOffset,
        options.cookie,
      ),
    );

    const matches = [...page.hotComments, ...page.comments]
      .filter((comment) => comment.userId === options.uid)
      .map<FoundComment>((comment) => ({
        ...comment,
        songId: song.id,
        songName: song.name,
        sources: song.sources,
        sourceRank: song.sourceRank,
        playCount: song.playCount,
        route: "song-comments",
        capturedAt: new Date().toISOString(),
      }));
    const added = await appendMatches(writer, state, matches);

    state.pageInSong += 1;
    state.commentOffset += options.commentPageSize;

    if (!page.more || page.comments.length === 0) advanceSong(state);
    await checkpoint();

    if (added > 0 && options.stopAfterFirst) {
      return report(state, governor, options, initialRequests, "paused", {
        note: "Stopped after the first match; rerun without --stop-after-first for full coverage.",
      });
    }
  }

  state.finished = true;
  state.coverageComplete =
    !state.sourceTruncated &&
    state.truncatedSongIds.length === 0 &&
    state.sourceErrors.length === 0;
  await checkpoint();
  return report(state, governor, options, initialRequests, "complete");
}

async function collectSongs(
  client: NcmClient,
  governor: RequestGovernor,
  options: ScanOptions,
): Promise<{ songs: SongCandidate[]; failures: string[] }> {
  const batches: SongCandidate[][] = [];
  const failures: string[] = [];
  if (options.source === "record" || options.source === "both") {
    try {
      batches.push(await governor.execute("user_record", () =>
        client.getUserRecord(options.uid, options.recordScope, options.cookie),
      ));
    } catch (error) {
      if (options.source === "record" || isPauseSignal(error)) throw error;
      failures.push(`record: ${errorMessage(error)}`);
    }
  }
  if (options.source === "likes" || options.source === "both") {
    try {
      batches.push(await governor.execute("likelist", () =>
        client.getLikedSongs(options.uid, options.cookie),
      ));
    } catch (error) {
      if (options.source === "likes" || isPauseSignal(error)) throw error;
      failures.push(`likes: ${errorMessage(error)}`);
    }
  }
  if (batches.length === 0) {
    throw new Error(`All selected song sources failed: ${failures.join("; ")}`);
  }
  return { songs: mergeSongs(batches.flat()), failures };
}

export function mergeSongs(songs: SongCandidate[]): SongCandidate[] {
  const byId = new Map<string, SongCandidate>();
  for (const song of songs) {
    const existing = byId.get(song.id);
    if (!existing) {
      byId.set(song.id, { ...song, sources: [...song.sources] });
      continue;
    }
    for (const source of song.sources) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    }
    existing.name ??= song.name;
    existing.artists ??= song.artists;
    existing.playCount ??= song.playCount;
    existing.score ??= song.score;
  }
  return [...byId.values()];
}

async function appendMatches(
  writer: JsonlResultWriter,
  state: ScanState,
  matches: FoundComment[],
): Promise<number> {
  const seen = new Set(state.seenCommentIds);
  let added = 0;
  for (const match of matches) {
    if (seen.has(match.commentId) || writer.has(match.commentId)) continue;
    if (await writer.append(match)) {
      state.seenCommentIds.push(match.commentId);
      seen.add(match.commentId);
      state.matchCount += 1;
      added += 1;
    }
  }
  return added;
}

function advanceSong(state: ScanState): void {
  state.songIndex += 1;
  state.commentOffset = 0;
  state.pageInSong = 0;
}

function report(
  state: ScanState,
  governor: RequestGovernor,
  options: ScanOptions,
  initialRequests: number,
  status: RunReport["status"],
  extra: Partial<RunReport> = {},
): RunReport {
  return {
    status,
    strategy: state.strategy,
    uid: state.uid,
    songs: state.songs.length,
    songsProcessed: state.songIndex,
    matches: state.matchCount,
    requestsThisRun: governor.requestsUsed,
    requestsTotal: initialRequests + governor.requestsUsed,
    coverageComplete: state.coverageComplete,
    sourceErrors: state.sourceErrors,
    statePath: options.statePath,
    outputPath: options.outputPath,
    ...extra,
  };
}

function isPauseSignal(error: unknown): boolean {
  return error instanceof CooldownRequired ||
    error instanceof RequestBudgetExhausted ||
    error instanceof RunCancelled;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function estimateNote(state: ScanState, options: ScanOptions): string {
  const cap = options.maxCommentPagesPerSong > 0
    ? options.maxCommentPagesPerSong
    : "all available";
  return `${state.songs.length} unique songs; up to ${cap} comment pages per song; page size ${options.commentPageSize}.`;
}
