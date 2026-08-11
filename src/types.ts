export type SongSource = "record" | "record-week" | "likes" | "playlists";
export type SourceSelection = "record" | "likes" | "playlists" | "both" | "all";
export type RecordScope = "all" | "week" | "both";
export type Strategy = "auto" | "scan" | "history";
export type CommentScope = "root-only-v1" | "root-and-floor-v1";

export interface SongSourceMembership {
  source: SongSource;
  sourceRank?: number;
  playCount?: number;
  score?: number;
}

export interface SongCandidate {
  id: string;
  name?: string;
  artists?: string[];
  /** Trusted release timestamp used only to make displayed time coverage proportional. */
  publishTime?: number;
  sources: SongSource[];
  sourceRank?: number;
  playCount?: number;
  score?: number;
  /** Per-source evidence retained when one song belongs to several catalogs. */
  memberships?: SongSourceMembership[];
}

export interface TargetLikedPlaylist {
  id: string;
  trackCount?: number;
}

export interface TargetUserPlaylist extends TargetLikedPlaylist {
  name?: string;
}

export interface TargetUserPlaylistPage {
  playlists: TargetUserPlaylist[];
  /** The target-owned specialType=5 list when it is present on this page. */
  likedPlaylist?: TargetLikedPlaylist;
  more: boolean;
  nextOffset: number;
}

export interface CommentRecord {
  commentId: string;
  userId: string;
  nickname?: string;
  content: string;
  time?: number;
  likedCount?: number;
  /** Declared replies for a top-level comment. */
  replyCount?: number;
  /** Root comment whose floor thread produced this reply. */
  parentCommentId?: string;
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

export interface CommentFloorPage {
  parentCommentId: string;
  comments: CommentRecord[];
  hasMore: boolean;
  nextTime?: number;
  total?: number;
}

export interface SongInfo {
  id: string;
  name?: string;
  artists?: string[];
  publishTime?: number;
}

export type MusicPlatform = "netease" | "qq";

/** Platform-neutral song identity returned by the lookup-only search APIs. */
export interface SongSearchResult {
  id: string;
  mid?: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
}

export interface SongSearchResponse {
  platform: MusicPlatform;
  query: string;
  songs: SongSearchResult[];
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
  searchSongs?(query: string, limit: number): Promise<SongSearchResult[]>;
  getLoginProfile(cookie?: string): Promise<LoginProfile | undefined>;
  getUserRecord(
    uid: string,
    scope: "all" | "week",
    cookie?: string,
  ): Promise<SongCandidate[]>;
  getLikedSongs(uid: string, cookie?: string): Promise<SongCandidate[]>;
  getTargetLikedPlaylist?(uid: string, cookie?: string): Promise<TargetLikedPlaylist>;
  getTargetLikedPlaylistSongs?(
    uid: string,
    playlist: TargetLikedPlaylist,
    cookie?: string,
  ): Promise<SongCandidate[]>;
  getTargetUserPlaylistPage?(
    uid: string,
    offset: number,
    limit: number,
    cookie?: string,
  ): Promise<TargetUserPlaylistPage>;
  getTargetUserPlaylistSongs?(
    uid: string,
    playlist: TargetUserPlaylist,
    cookie?: string,
  ): Promise<SongCandidate[]>;
  getSongInfos?(songIds: readonly string[]): Promise<SongInfo[]>;
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
  getCommentFloor?(
    songId: string,
    parentCommentId: string,
    limit: number,
    time: number,
  ): Promise<CommentFloorPage>;
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

export interface CommentFloorProgress {
  parentCommentId: string;
  nextTime: number;
  pageNo: number;
  pagesProcessed: number;
  repliesProcessed: number;
  declaredReplies?: number;
  done: boolean;
}

export interface ParallelSongScanState {
  version: 2;
  kind: "parallel-song";
  commentScope: CommentScope;
  uid: string;
  songId: string;
  songName?: string;
  startTime: number;
  endTime: number;
  shardCount: number;
  pageSize: number;
  shards: CommentTimeShard[];
  pagesProcessed: number;
  floorPagesProcessed: number;
  commentsInspected: number;
  replyCommentsInspected: number;
  floorThreads: CommentFloorProgress[];
  rootDone?: boolean;
  totalComments?: number;
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
  commentScope: CommentScope;
  workersPerLane: number;
  /** Hard ceiling for the number of actual worker loops in this task. */
  maxWorkers?: number;
  requestBudget: number;
  maxPages: number;
  stopAfterFirst: boolean;
  fresh: boolean;
  statePath: string;
  outputPath: string;
  signal?: AbortSignal;
  onMatch?: (comment: FoundComment) => void;
  onCheckpoint?: (activity: ParallelCheckpointActivity) => void;
  onRequestActivity?: (activity: ScanRequestActivity) => void;
  onSchedulerActivity?: (activity: ScanSchedulerActivity) => void;
}

export interface ParallelCheckpointActivity {
  shards: number;
  shardsComplete: number;
  coveragePercent: number;
  coverageComplete: boolean;
  pagesProcessed: number;
  floorPagesProcessed: number;
  commentsInspected: number;
  replyCommentsInspected: number;
  totalComments?: number;
  matches: number;
  requestsTotal: number;
}

export interface ScanCheckpointActivity {
  songs: number;
  songsProcessed: number;
  catalogLoaded: boolean;
  catalogSongs: number;
  reusedSongs: number;
  historicalCompletedSongs: number;
  newPendingSongs: number;
  commentOffset: number;
  matches: number;
  requestsTotal: number;
  pagesProcessed: number;
  floorPagesProcessed: number;
  commentsInspected: number;
  replyCommentsInspected: number;
  coverageComplete: boolean;
  sourceErrors: string[];
  blockedUntil?: string;
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
  coverageComplete: boolean;
  pagesProcessed: number;
  floorPagesProcessed: number;
  commentsInspected: number;
  replyCommentsInspected: number;
  totalComments?: number;
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
  route: "song-comments" | "song-comment-floor" | "user-history";
  capturedAt: string;
  commentUrl?: string;
}

export interface SongScanProgress {
  commentOffset: number;
  totalComments?: number;
  pageInSong: number;
  floorPagesProcessed?: number;
  replyCommentsProcessed?: number;
  floorThreads?: CommentFloorProgress[];
  /** Root cursor/ranges ended; the song is only done after every floor thread ends. */
  rootDone?: boolean;
  /** Immutable upper time bound for this song's current scan generation. */
  commentEndTime?: number;
  /** Immutable lower bound for display coverage; scanning still reaches the global safety bound. */
  coverageStartTime?: number;
  commentCursor?: string;
  commentPageNo?: number;
  commentShards?: CommentTimeShard[];
  done: boolean;
}

export interface ScanState {
  version: 1 | 2 | 3 | 4;
  commentPagination?: "cursor-v1";
  commentScope?: CommentScope;
  commentPageSize?: number;
  uid: string;
  strategy: "scan" | "history";
  strategyResolved: boolean;
  source: SourceSelection;
  recordScope: RecordScope;
  sourcesLoaded: boolean;
  songs: SongCandidate[];
  songProgress?: SongScanProgress[];
  sourceSongCount: number;
  sourceTruncated: boolean;
  sourceErrors: string[];
  sourceCatalogVersion?: number;
  reusedSongs?: number;
  historicalCompletedSongs?: number;
  newPendingSongs?: number;
  songIndex: number;
  commentOffset: number;
  pageInSong: number;
  historyTime: number;
  seenCommentIds: string[];
  matchCount: number;
  requestCount: number;
  pagesProcessed?: number;
  floorPagesProcessed?: number;
  replyCommentsInspected?: number;
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
  recordScope: RecordScope;
  commentScope: CommentScope;
  cookie?: string;
  statePath: string;
  outputPath: string;
  coveragePath?: string;
  commentPageSize: number;
  historyPageSize: number;
  /** Logical comment/history/floor pages allowed in this invocation; 0 is unlimited. */
  requestBudget?: number;
  maxCommentPagesPerSong: number;
  maxSongs: number;
  stopAfterFirst: boolean;
  fresh: boolean;
  dryRun: boolean;
  signal?: AbortSignal;
  onMatch?: (comment: FoundComment) => void;
  onCheckpoint?: (activity: ScanCheckpointActivity) => void;
  onSongCatalog?: (songs: readonly SongCandidate[]) => void;
  onSongProgress?: (activity: SongScanActivity) => void;
  onRequestActivity?: (activity: ScanRequestActivity) => void;
  onSchedulerActivity?: (activity: ScanSchedulerActivity) => void;
}

export interface SongScanActivity {
  songId: string;
  songName?: string;
  workerId?: string;
  pageInSong: number;
  floorPagesProcessed?: number;
  replyCommentsProcessed?: number;
  requestingPage?: number;
  commentsProcessed: number;
  totalComments?: number;
  coveragePercent?: number;
  done?: boolean;
  truncated?: boolean;
}

export interface ScanRequestActivity {
  phase: "start" | "success" | "failure";
  startedAt?: string;
  lane: string;
  workerId?: string;
  operation: "comment-page" | "comment-floor";
  songId: string;
  songName?: string;
  page: number;
  shardId?: number;
  parentCommentId?: string;
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

export interface ScanSchedulerActivity {
  type: "adaptive-split";
  songId?: string;
  originalShardId: number;
  newShardId: number;
  splitAt: number;
  remainingStart: number;
  remainingEnd: number;
  waitingWorkers: number;
}

export interface RunReport {
  status: "complete" | "paused" | "cooldown" | "dry-run" | "stopped";
  strategy: "scan" | "history";
  uid: string;
  songs: number;
  songsProcessed: number;
  catalogLoaded: boolean;
  catalogSongs: number;
  reusedSongs: number;
  historicalCompletedSongs: number;
  newPendingSongs: number;
  matches: number;
  requestsThisRun: number;
  requestsTotal: number;
  lanes?: number;
  workers?: number;
  pagesProcessed?: number;
  floorPagesProcessed?: number;
  replyCommentsInspected?: number;
  commentsInspected: number;
  coverageComplete: boolean;
  sourceErrors: string[];
  statePath: string;
  outputPath: string;
  resumeAfter?: string;
  note?: string;
}
