import assert from "node:assert/strict";
import test from "node:test";
import { decodeQQMusicScanState, stableQQMusicTaskKey } from "../src/qq-music/state";

test("QQ checkpoint rejects duplicate songs and non-decimal cursors", () => {
  const duplicate = checkpoint();
  duplicate.songs.push({ ...duplicate.songs[0] });
  assert.throws(() => decodeQQMusicScanState(duplicate), /duplicate song id/);

  const malformed = checkpoint();
  malformed.songs[0].cursor = "bad-cursor";
  assert.throws(() => decodeQQMusicScanState(malformed), /song\.cursor must contain decimal digits/);

  const completedWithCursor = checkpoint();
  completedWithCursor.songs[0].done = true;
  assert.throws(() => decodeQQMusicScanState(completedWithCursor), /completed song must not retain a cursor/);
});

test("QQ checkpoint derives completion flags from source and song progress", () => {
  const raw = checkpoint();
  raw.finished = true;
  raw.coverageComplete = true;
  const decoded = decodeQQMusicScanState(raw);
  assert.equal(decoded.finished, false);
  assert.equal(decoded.coverageComplete, false);

  raw.sourceLoaded = true;
  raw.songs[0].done = true;
  raw.songs[0].cursor = undefined;
  raw.finished = false;
  raw.coverageComplete = false;
  const complete = decodeQQMusicScanState(raw);
  assert.equal(complete.finished, true);
  assert.equal(complete.coverageComplete, true);
});

test("QQ checkpoint enforces the song-mode source cardinality", () => {
  const empty = checkpoint();
  empty.sourceLoaded = true;
  empty.songs = [];
  assert.throws(() => decodeQQMusicScanState(empty), /exactly its requested song/);

  const multiple = checkpoint();
  multiple.sourceLoaded = true;
  multiple.songs.push({ ...multiple.songs[0], id: "8" });
  assert.throws(() => decodeQQMusicScanState(multiple), /exactly its requested song/);

  const replaced = checkpoint();
  replaced.sourceLoaded = true;
  replaced.songs[0].id = "8";
  assert.throws(() => decodeQQMusicScanState(replaced), /requested song id/);
});

test("QQ checkpoint decoder accepts legacy comment pages through 100 only", () => {
  const legacy = checkpoint();
  legacy.pageSize = 100;
  assert.equal(decodeQQMusicScanState(legacy).pageSize, 100);

  legacy.pageSize = 101;
  assert.throws(() => decodeQQMusicScanState(legacy), /pageSize.*between 1 and 100/);
});

test("QQ stable task keys bind canonical mode, target, and requested song without leaking identity", () => {
  const song = stableQQMusicTaskKey("song", "opaque-encrypt-uin", "7");
  const same = stableQQMusicTaskKey("song", " opaque-encrypt-uin ", "7");
  const otherSong = stableQQMusicTaskKey("song", "opaque-encrypt-uin", "8");
  const likes = stableQQMusicTaskKey("likes", "opaque-encrypt-uin");

  assert.equal(song, same);
  assert.match(song, /^[0-9a-f]{24}$/);
  assert.notEqual(song, otherSong);
  assert.notEqual(song, likes);
  assert.doesNotMatch(song, /opaque|encrypt|uin/);
});

test("QQ checkpoint validates aggregate counters, truncation, timestamps, and composite match keys", () => {
  const pages = checkpoint();
  pages.pagesProcessed = 2;
  assert.throws(() => decodeQQMusicScanState(pages), /pagesProcessed.*song/i);

  const comments = checkpoint();
  comments.commentsInspected = 51;
  assert.throws(() => decodeQQMusicScanState(comments), /commentsInspected.*song/i);

  const truncated = checkpoint();
  truncated.songs[0].truncated = true;
  assert.throws(() => decodeQQMusicScanState(truncated), /truncated song must be done/i);

  const timestamps = checkpoint();
  timestamps.updatedAt = "not-an-iso-date";
  assert.throws(() => decodeQQMusicScanState(timestamps), /updatedAt.*ISO/i);

  const unknownSongKey = checkpoint();
  unknownSongKey.seenCommentKeys = ["8:comment-1"];
  unknownSongKey.matchCount = 1;
  assert.throws(() => decodeQQMusicScanState(unknownSongKey), /seenCommentKeys.*known song/i);

  const duplicateKey = checkpoint();
  duplicateKey.seenCommentKeys = ["7:comment-1", "7:comment-1"];
  duplicateKey.matchCount = 2;
  assert.throws(() => decodeQQMusicScanState(duplicateKey), /duplicate seen comment key/i);
});

function checkpoint() {
  return {
    version: 1,
    kind: "qq-comment-scan",
    mode: "song",
    targetInput: "opaque-user",
    targetEncryptUin: "opaque-user",
    requestedSongId: "7",
    commentPagination: "seqno-v1",
    pageSize: 50,
    likedPageSize: 100,
    maxSongs: 0,
    maxCommentPagesPerSong: 0,
    sourceLoaded: false,
    sourceTruncated: false,
    sourceOffset: 1,
    sourceTotal: 1,
    songs: [{
      id: "7",
      artists: [],
      cursor: "90",
      pageNo: 1,
      pagesProcessed: 1,
      commentsInspected: 50,
      done: false,
      truncated: false,
    }],
    pagesProcessed: 1,
    commentsInspected: 50,
    matchCount: 0,
    seenCommentKeys: [],
    requestCount: 1,
    finished: false,
    coverageComplete: false,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
