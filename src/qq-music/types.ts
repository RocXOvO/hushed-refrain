import type { RequestGovernor } from "../governor";

export interface QQMusicUser {
  input: string;
  encryptUin: string;
  numericUin?: string;
  nickname?: string;
}

export interface QQMusicSong {
  id: string;
  mid?: string;
  name?: string;
  artists?: string[];
}

export interface QQMusicComment {
  commentId: string;
  seqNo: string;
  authorEncryptUin: string;
  nickname?: string;
  avatarUrl?: string;
  content: string;
  time?: number;
  likedCount?: number;
  replyCount?: number;
}

export interface QQMusicCommentPage {
  comments: QQMusicComment[];
  hasMore: boolean;
  nextCursor?: string;
  total?: number;
}

export interface QQMusicSongPage {
  songs: QQMusicSong[];
  hasMore: boolean;
  total?: number;
  nextOffset: number;
}

export interface QQMusicPlatformClient {
  resolveUser(input: string, signal?: AbortSignal): Promise<QQMusicUser>;
  getSongInfo(songId: string, signal?: AbortSignal): Promise<QQMusicSong>;
  getLikedSongsPage(
    encryptUin: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<QQMusicSongPage>;
  getNewComments(
    songId: string,
    pageSize: number,
    pageNo: number,
    lastCommentSeqNo?: string,
    signal?: AbortSignal,
  ): Promise<QQMusicCommentPage>;
}

export interface QQMusicTransportGateLike {
  readonly isCancelled: boolean;
  readonly signal: AbortSignal;
  run<T>(request: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export interface QQCommentLane {
  name: string;
  client: QQMusicPlatformClient;
  governor: RequestGovernor;
  transportGate: QQMusicTransportGateLike;
}

export interface QQMusicCheckpointActivity {
  songs: number;
  songsComplete: number;
  pagesProcessed: number;
  commentsInspected: number;
  matches: number;
  requestsTotal: number;
  coverageComplete: boolean;
}

export interface QQMusicRequestActivity {
  phase: "start" | "success" | "failure";
  operation: "comment-page";
  workerId: string;
  lane: string;
  songId: string;
  songName?: string;
  page: number;
  startedAt: string;
  elapsedMs?: number;
  networkElapsedMs?: number;
  attempts?: number;
  comments?: number;
  effectiveComments?: number;
  totalComments?: number;
  hasMore?: boolean;
  status?: number;
  rateLimited?: boolean;
  error?: string;
}

export interface QQMusicSongActivity {
  songId: string;
  songMid?: string;
  songName?: string;
  artists?: string[];
  pages: number;
  comments: number;
  total?: number;
  done: boolean;
  truncated: boolean;
}

export interface QQMusicFoundComment extends QQMusicComment {
  platform: "qq";
  targetEncryptUin: string;
  songId: string;
  songMid?: string;
  songName?: string;
  artists?: string[];
  capturedAt: string;
  commentUrl?: string;
}

export interface QQMusicSongProgress extends QQMusicSong {
  cursor?: string;
  pageNo: number;
  pagesProcessed: number;
  commentsInspected: number;
  totalComments?: number;
  done: boolean;
  truncated: boolean;
  lastError?: string;
}

export interface QQMusicScanState {
  version: 1;
  kind: "qq-comment-scan";
  mode: "song" | "likes";
  targetInput: string;
  targetEncryptUin: string;
  targetNumericUin?: string;
  targetNickname?: string;
  requestedSongId?: string;
  commentPagination: "seqno-v1";
  pageSize: number;
  likedPageSize: number;
  maxSongs: number;
  maxCommentPagesPerSong: number;
  sourceLoaded: boolean;
  sourceTruncated: boolean;
  sourceOffset: number;
  sourceTotal?: number;
  songs: QQMusicSongProgress[];
  pagesProcessed: number;
  commentsInspected: number;
  matchCount: number;
  seenCommentKeys: string[];
  cooldownUntil?: string;
  requestCount: number;
  finished: boolean;
  coverageComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QQMusicScanOptions {
  mode: "song" | "likes";
  target: string;
  songId?: string;
  pageSize: number;
  likedPageSize: number;
  maxSongs: number;
  maxCommentPagesPerSong: number;
  workersPerLane: number;
  maxWorkers?: number;
  requestBudget: number;
  stopAfterFirst: boolean;
  fresh: boolean;
  statePath: string;
  outputPath: string;
  signal?: AbortSignal;
  onMatch?: (comment: QQMusicFoundComment) => void;
  onCheckpoint?: (activity: QQMusicCheckpointActivity) => void;
  onRequestActivity?: (activity: QQMusicRequestActivity) => void;
  onSongProgress?: (activity: QQMusicSongActivity) => void;
}

export interface QQMusicScanReport {
  status: "complete" | "matched" | "paused" | "cooldown" | "stopped";
  mode: "song" | "likes";
  targetEncryptUin: string;
  songs: number;
  songsComplete: number;
  lanes: number;
  workers: number;
  pagesProcessed: number;
  commentsInspected: number;
  matches: number;
  requestsThisRun: number;
  requestsTotal: number;
  coverageComplete: boolean;
  elapsedMs: number;
  statePath: string;
  outputPath: string;
  note?: string;
}
