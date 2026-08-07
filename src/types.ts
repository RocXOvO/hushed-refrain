export type SongSource = "record" | "likes";
export type SourceSelection = SongSource | "both";
export type Strategy = "auto" | "scan" | "history";

export interface SongCandidate {
  id: string;
  name?: string;
  artists?: string[];
  sources: SongSource[];
  sourceRank?: number;
  playCount?: number;
  score?: number;
}

export interface CommentRecord {
  commentId: string;
  userId: string;
  nickname?: string;
  content: string;
  time?: number;
  likedCount?: number;
}

export interface CommentPage {
  comments: CommentRecord[];
  hotComments: CommentRecord[];
  more: boolean;
  total?: number;
}

export interface CursorCommentPage {
  comments: CommentRecord[];
  hasMore: boolean;
  nextCursor?: string;
  total?: number;
}

export interface SongInfo {
  id: string;
  name?: string;
  artists?: string[];
  publishTime?: number;
}

export interface HistoryComment extends CommentRecord {
  songId?: string;
  resourceName?: string;
}

export interface HistoryPage {
  comments: HistoryComment[];
  hasMore: boolean;
  nextTime?: number;
}

export interface LoginProfile {
  userId: string;
  nickname?: string;
}

export interface NcmClient {
  getLoginProfile(cookie?: string): Promise<LoginProfile | undefined>;
  getUserRecord(
    uid: string,
    scope: "all" | "week",
    cookie?: string,
  ): Promise<SongCandidate[]>;
  getLikedSongs(uid: string, cookie?: string): Promise<SongCandidate[]>;
  getSongComments(
    songId: string,
    limit: number,
    offset: number,
    cookie?: string,
  ): Promise<CommentPage>;
  getSongCommentsByCursor(
    songId: string,
    pageSize: number,
    pageNo: number,
    cursor: string,
  ): Promise<CursorCommentPage>;
  getSongInfo(songId: string): Promise<SongInfo>;
  getUserCommentHistory(
    uid: string,
    limit: number,
    time: number,
    cookie: string,
  ): Promise<HistoryPage>;
}

export interface CommentTimeShard {
  id: number;
  startTime: number;
  endTime: number;
  cursor: string;
  pageNo: number;
  pagesProcessed: number;
  done: boolean;
}

export interface ParallelSongScanState {
  version: 1;
  kind: "parallel-song";
  uid: string;
  songId: string;
  songName?: string;
  startTime: number;
  endTime: number;
  shardCount: number;
  pageSize: number;
  shards: CommentTimeShard[];
  pagesProcessed: number;
  commentsInspected: number;
  requestCount: number;
  matchCount: number;
  seenCommentIds: string[];
  finished: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ParallelSongScanOptions {
  uid: string;
  songId: string;
  songName?: string;
  startTime: number;
  endTime: number;
  shardCount: number;
  pageSize: number;
  workersPerLane: number;
  requestBudget: number;
  maxPages: number;
  stopAfterFirst: boolean;
  fresh: boolean;
  statePath: string;
  outputPath: string;
  onMatch?: (comment: FoundComment) => void;
}

export interface ParallelSongScanReport {
  status: "complete" | "matched" | "paused" | "cooldown" | "stopped";
  uid: string;
  songId: string;
  songName?: string;
  lanes: number;
  workers: number;
  shards: number;
  shardsComplete: number;
  pagesProcessed: number;
  commentsInspected: number;
  matches: number;
  requestsThisRun: number;
  requestsTotal: number;
  elapsedMs: number;
  statePath: string;
  outputPath: string;
  note?: string;
}

export interface FoundComment extends CommentRecord {
  songId?: string;
  songName?: string;
  resourceName?: string;
  sources?: SongSource[];
  sourceRank?: number;
  playCount?: number;
  route: "song-comments" | "user-history";
  capturedAt: string;
  commentUrl?: string;
}

export interface SongScanProgress {
  commentOffset: number;
  pageInSong: number;
  commentCursor?: string;
  commentPageNo?: number;
  done: boolean;
}

export interface ScanState {
  version: 1;
  commentPagination?: "cursor-v1";
  commentPageSize?: number;
  uid: string;
  strategy: "scan" | "history";
  strategyResolved: boolean;
  source: SourceSelection;
  recordScope: "all" | "week";
  sourcesLoaded: boolean;
  songs: SongCandidate[];
  songProgress?: SongScanProgress[];
  sourceSongCount: number;
  sourceTruncated: boolean;
  sourceErrors: string[];
  songIndex: number;
  commentOffset: number;
  pageInSong: number;
  historyTime: number;
  seenCommentIds: string[];
  matchCount: number;
  requestCount: number;
  pagesProcessed?: number;
  truncatedSongIds: string[];
  blockedUntil?: string;
  finished: boolean;
  coverageComplete: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ScanOptions {
  uid: string;
  strategy: Strategy;
  source: SourceSelection;
  recordScope: "all" | "week";
  cookie?: string;
  statePath: string;
  outputPath: string;
  commentPageSize: number;
  historyPageSize: number;
  maxCommentPagesPerSong: number;
  maxSongs: number;
  stopAfterFirst: boolean;
  fresh: boolean;
  dryRun: boolean;
  onMatch?: (comment: FoundComment) => void;
  onSongProgress?: (activity: SongScanActivity) => void;
}

export interface SongScanActivity {
  songId: string;
  songName?: string;
  pageInSong: number;
}

export interface RunReport {
  status: "complete" | "paused" | "cooldown" | "dry-run" | "stopped";
  strategy: "scan" | "history";
  uid: string;
  songs: number;
  songsProcessed: number;
  matches: number;
  requestsThisRun: number;
  requestsTotal: number;
  lanes?: number;
  workers?: number;
  pagesProcessed?: number;
  coverageComplete: boolean;
  sourceErrors: string[];
  statePath: string;
  outputPath: string;
  resumeAfter?: string;
  note?: string;
}
