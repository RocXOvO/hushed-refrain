import { createHash } from "node:crypto";
import { readAtomicJson, writeAtomicJson } from "../atomic-file";
import type { QQMusicScanState, QQMusicSongProgress } from "./types";

export function loadQQMusicScanState(path: string): Promise<QQMusicScanState | undefined> {
  return readAtomicJson(path, decodeQQMusicScanState);
}

export function saveQQMusicScanState(path: string, state: QQMusicScanState): Promise<void> {
  return writeAtomicJson(path, state);
}

export function stableQQMusicTaskKey(
  mode: "song" | "likes",
  canonicalEncryptUin: string,
  requestedSongId?: string,
): string {
  const target = canonicalEncryptUin.trim();
  if (!target) throw new Error("QQ Music canonical EncryptUin is required for the task key.");
  if (mode === "song" && (!requestedSongId || !/^\d+$/.test(requestedSongId))) {
    throw new Error("QQ Music song task key requires a decimal requestedSongId.");
  }
  if (mode === "likes" && requestedSongId !== undefined) {
    throw new Error("QQ Music likes task key must not include a requestedSongId.");
  }
  return createHash("sha256")
    .update(JSON.stringify([mode, target, mode === "song" ? requestedSongId ?? "" : ""]))
    .digest("hex")
    .slice(0, 24);
}

export function decodeQQMusicScanState(value: unknown): QQMusicScanState {
  const state = object(value);
  if (state.version !== 1 || state.kind !== "qq-comment-scan") {
    throw new Error("Unsupported QQ Music checkpoint version or kind.");
  }
  const mode = oneOf(state.mode, ["song", "likes"] as const, "mode");
  const targetInput = requiredText(state.targetInput, "targetInput");
  const targetEncryptUin = requiredText(state.targetEncryptUin, "targetEncryptUin");
  if (state.commentPagination !== "seqno-v1") {
    throw new Error("Unsupported QQ Music comment pagination mode.");
  }
  const sourceLoaded = boolean(state.sourceLoaded, "sourceLoaded");
  const sourceTruncated = boolean(state.sourceTruncated, "sourceTruncated");
  const songs = array(state.songs).map(decodeSongProgress);
  rejectDuplicates(songs.map((song) => song.id), "song id");
  const requestedSongId = optionalText(state.requestedSongId);
  if (requestedSongId && !/^\d+$/.test(requestedSongId)) {
    throw new Error("requestedSongId must contain decimal digits.");
  }
  if (mode === "song") {
    if (!requestedSongId) throw new Error("A song-mode QQ checkpoint requires requestedSongId.");
    if (sourceLoaded && songs.length !== 1) {
      throw new Error("A loaded song-mode QQ checkpoint must contain exactly its requested song.");
    }
    if (sourceLoaded && songs[0].id !== requestedSongId) {
      throw new Error("A loaded song-mode QQ checkpoint song must match its requested song id.");
    }
  } else if (requestedSongId) {
    throw new Error("A likes-mode QQ checkpoint must not contain requestedSongId.");
  }
  const songIds = new Set(songs.map((song) => song.id));
  const seenCommentKeys = optionalArray(state.seenCommentKeys)
    .map((entry) => requiredText(entry, "seenCommentKeys entry"));
  rejectDuplicates(seenCommentKeys, "seen comment key");
  for (const key of seenCommentKeys) {
    const { songId } = parseQQMusicCommentKey(key);
    if (!songIds.has(songId)) {
      throw new Error(`QQ Music checkpoint seenCommentKeys must reference a known song: ${songId}.`);
    }
  }
  boolean(state.finished, "finished");
  boolean(state.coverageComplete, "coverageComplete");
  const finished = sourceLoaded && songs.every((song) => song.done);
  const coverageComplete = finished
    && !sourceTruncated
    && songs.every((song) => !song.truncated);
  const matchCount = integer(state.matchCount, "matchCount", 0);
  if (matchCount !== seenCommentKeys.length) {
    throw new Error("QQ Music checkpoint matchCount must equal seenCommentKeys length.");
  }
  const pagesProcessed = integer(state.pagesProcessed, "pagesProcessed", 0);
  const commentsInspected = integer(state.commentsInspected, "commentsInspected", 0);
  if (pagesProcessed !== songs.reduce((sum, song) => sum + song.pagesProcessed, 0)) {
    throw new Error("QQ Music checkpoint pagesProcessed must equal the song aggregate.");
  }
  if (commentsInspected !== songs.reduce((sum, song) => sum + song.commentsInspected, 0)) {
    throw new Error("QQ Music checkpoint commentsInspected must equal the song aggregate.");
  }
  return {
    version: 1,
    kind: "qq-comment-scan",
    mode,
    targetInput,
    targetEncryptUin,
    targetNumericUin: optionalText(state.targetNumericUin),
    targetNickname: optionalText(state.targetNickname),
    requestedSongId,
    commentPagination: "seqno-v1",
    pageSize: integer(state.pageSize, "pageSize", 1, 100),
    likedPageSize: integer(state.likedPageSize, "likedPageSize", 1, 500),
    maxSongs: integer(state.maxSongs, "maxSongs", 0),
    maxCommentPagesPerSong: integer(
      state.maxCommentPagesPerSong,
      "maxCommentPagesPerSong",
      0,
    ),
    sourceLoaded,
    sourceTruncated,
    sourceOffset: integer(state.sourceOffset, "sourceOffset", 0),
    sourceTotal: optionalInteger(state.sourceTotal, "sourceTotal", 0),
    songs,
    pagesProcessed,
    commentsInspected,
    matchCount,
    seenCommentKeys,
    cooldownUntil: optionalIsoDate(state.cooldownUntil, "cooldownUntil"),
    requestCount: integer(state.requestCount, "requestCount", 0),
    finished,
    coverageComplete,
    createdAt: requiredIsoDate(state.createdAt, "createdAt"),
    updatedAt: requiredIsoDate(state.updatedAt, "updatedAt"),
  };
}

function decodeSongProgress(value: unknown): QQMusicSongProgress {
  const song = object(value);
  const id = requiredText(song.id, "song.id");
  if (!/^\d+$/.test(id)) throw new Error("song.id must contain decimal digits.");
  const cursor = optionalText(song.cursor);
  if (cursor && !/^\d+$/.test(cursor)) throw new Error("song.cursor must contain decimal digits.");
  const pageNo = integer(song.pageNo, "song.pageNo", 0);
  const pagesProcessed = integer(song.pagesProcessed, "song.pagesProcessed", 0);
  const done = boolean(song.done, "song.done");
  if (pageNo !== pagesProcessed) {
    throw new Error("song.pageNo must equal song.pagesProcessed.");
  }
  if (!done && pageNo > 0 && !cursor) {
    throw new Error("An unfinished paged song must retain its decimal cursor.");
  }
  if (done && cursor) throw new Error("A completed song must not retain a cursor.");
  const truncated = boolean(song.truncated, "song.truncated");
  if (truncated && !done) throw new Error("A truncated song must be done.");
  return {
    id,
    mid: optionalText(song.mid),
    name: optionalText(song.name),
    artists: optionalArray(song.artists).map((entry) => requiredText(entry, "song.artist")),
    cursor,
    pageNo,
    pagesProcessed,
    commentsInspected: integer(song.commentsInspected, "song.commentsInspected", 0),
    totalComments: optionalInteger(song.totalComments, "song.totalComments", 0),
    done,
    truncated,
    lastError: optionalText(song.lastError),
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("QQ Music checkpoint must be an object.");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("QQ Music checkpoint field must be an array.");
  return value;
}

function optionalArray(value: unknown): unknown[] {
  if (value === undefined) return [];
  return array(value);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function optionalInteger(value: unknown, name: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  return integer(value, name, minimum);
}

function optionalIsoDate(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = requiredText(value, name);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${name} must be an ISO date string.`);
  return parsed;
}

function requiredIsoDate(value: unknown, name: string): string {
  const parsed = requiredText(value, name);
  if (!Number.isFinite(Date.parse(parsed))) throw new Error(`${name} must be an ISO date string.`);
  return parsed;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, allowed: T, name: string): T[number] {
  if (typeof value === "string" && allowed.includes(value)) return value as T[number];
  throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
}

function rejectDuplicates(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`QQ Music checkpoint contains duplicate ${label}: ${value}.`);
    seen.add(value);
  }
}

export function qqMusicCommentKey(songId: string, commentId: string): string {
  if (!/^\d+$/.test(songId)) throw new Error("QQ Music comment key songId must contain decimal digits.");
  if (!commentId || commentId.includes("\n") || commentId.includes("\r")) {
    throw new Error("QQ Music comment key commentId must be non-empty and single-line.");
  }
  return `${songId}:${commentId}`;
}

function parseQQMusicCommentKey(key: string): { songId: string; commentId: string } {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) {
    throw new Error(`Invalid QQ Music seen comment key: ${key}.`);
  }
  const songId = key.slice(0, separator);
  const commentId = key.slice(separator + 1);
  if (!/^\d+$/.test(songId) || commentId.includes("\n") || commentId.includes("\r")) {
    throw new Error(`Invalid QQ Music seen comment key: ${key}.`);
  }
  return { songId, commentId };
}
