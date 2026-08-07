import api = require("@neteasecloudmusicapienhanced/api");
import { ApiResponseError, AuthenticationRequired } from "./errors";
import type {
  CommentPage,
  CommentRecord,
  CursorCommentPage,
  HistoryComment,
  HistoryPage,
  LoginProfile,
  NcmClient,
  SongCandidate,
  SongInfo,
} from "./types";

type JsonObject = Record<string, unknown>;
type ApiResponse = { status?: number; body?: unknown };

export interface EnhancedNcmClientOptions {
  proxy?: string;
  requestTimeoutMs?: number;
}

export interface NcmUserProfile {
  userId: string;
  nickname: string;
  signature?: string;
  level?: number;
  listenSongs?: number;
  playlistCount?: number;
  follows?: number;
  followeds?: number;
}

export class EnhancedNcmClient implements NcmClient {
  constructor(private readonly options: EnhancedNcmClientOptions = {}) {}

  async getLoginProfile(cookie?: string): Promise<LoginProfile | undefined> {
    if (!cookie) return undefined;
    const body = await invoke("login_status", () =>
      api.login_status(this.requestConfig(cookie)),
    );
    const data = object(body.data);
    const profile = object(data.profile ?? body.profile);
    const userId = stringId(profile.userId);
    return userId ? { userId, nickname: text(profile.nickname) } : undefined;
  }

  async getUserProfile(uid: string, cookie?: string): Promise<NcmUserProfile> {
    const body = await invoke("user_detail", () =>
      api.user_detail({ uid, ...this.requestConfig(cookie) }),
    );
    const profile = object(body.profile);
    const userId = stringId(profile.userId);
    const nickname = text(profile.nickname);
    if (!userId || !nickname) throw new ApiResponseError("user_detail returned no profile", 502, body);
    return {
      userId,
      nickname,
      signature: text(profile.signature),
      level: numberOrUndefined(body.level ?? profile.level),
      listenSongs: numberOrUndefined(body.listenSongs ?? profile.listenSongs),
      playlistCount: numberOrUndefined(profile.playlistCount),
      follows: numberOrUndefined(profile.follows),
      followeds: numberOrUndefined(profile.followeds),
    };
  }

  async getUserRecord(
    uid: string,
    scope: "all" | "week",
    cookie?: string,
  ): Promise<SongCandidate[]> {
    const body = await invoke("user_record", () =>
      api.user_record({
        uid,
        type: scope === "week" ? 1 : 0,
        ...this.requestConfig(cookie),
      }),
    );
    const entries = array(body[scope === "week" ? "weekData" : "allData"]);
    return entries.flatMap((raw, index) => {
      const entry = object(raw);
      const song = object(entry.song);
      const id = stringId(song.id);
      if (!id) return [];
      const artists = array(song.ar ?? song.artists)
        .map((artist) => text(object(artist).name))
        .filter((name): name is string => Boolean(name));
      return [{
        id,
        name: text(song.name),
        artists,
        sources: ["record" as const],
        sourceRank: index + 1,
        playCount: numberOrUndefined(entry.playCount),
        score: numberOrUndefined(entry.score),
      }];
    });
  }

  async getLikedSongs(uid: string, cookie?: string): Promise<SongCandidate[]> {
    const body = await invoke("likelist", () =>
      api.likelist({ uid, ...this.requestConfig(cookie) }),
    );
    return array(body.ids).flatMap((value, index) => {
      const id = stringId(value);
      return id
        ? [{ id, sources: ["likes" as const], sourceRank: index + 1 }]
        : [];
    });
  }

  async getSongComments(
    songId: string,
    limit: number,
    offset: number,
    cookie?: string,
  ): Promise<CommentPage> {
    const body = await invoke("comment_music", () =>
      api.comment_music({
        id: songId,
        limit,
        offset,
        ...this.requestConfig(cookie),
      }),
    );
    const comments = array(body.comments).map(normalizeComment).filter(isDefined);
    const hotComments = array(body.hotComments).map(normalizeComment).filter(isDefined);
    return {
      comments,
      hotComments,
      more: Boolean(body.more ?? body.hasMore),
      total: numberOrUndefined(body.total),
    };
  }

  async getSongCommentsByCursor(
    songId: string,
    pageSize: number,
    pageNo: number,
    cursor: string,
  ): Promise<CursorCommentPage> {
    const body = await invoke("comment_new", () =>
      api.comment_new({
        type: 0,
        id: songId,
        pageSize,
        pageNo,
        sortType: 3,
        cursor,
        ...this.requestConfig(),
      } as Parameters<typeof api.comment_new>[0] & { cursor: string }),
    );
    const data = object(body.data);
    const comments = array(data.comments).map(normalizeComment).filter(isDefined);
    const nextCursor = stringId(data.cursor) ?? comments.at(-1)?.time?.toString();
    return {
      comments,
      hasMore: Boolean(data.hasMore),
      nextCursor,
      total: numberOrUndefined(data.totalCount ?? data.total),
    };
  }

  async getSongInfo(songId: string): Promise<SongInfo> {
    const song = (await this.getSongInfos([songId]))[0];
    if (!song) throw new ApiResponseError("song_detail returned no song", 502);
    return song;
  }

  async getSongInfos(songIds: readonly string[]): Promise<SongInfo[]> {
    const ids = [...new Set(songIds)].filter(Boolean);
    if (ids.length === 0) return [];
    const body = await invoke("song_detail", () =>
      api.song_detail({ ids: ids.join(","), ...this.requestConfig() }),
    );
    return array(body.songs).flatMap((raw) => {
      const song = object(raw);
      const album = object(song.al ?? song.album);
      const id = stringId(song.id);
      if (!id) return [];
      const artists = array(song.ar ?? song.artists)
        .map((artist) => text(object(artist).name))
        .filter((name): name is string => Boolean(name));
      return [{
        id,
        name: text(song.name),
        artists,
        publishTime: numberOrUndefined(album.publishTime ?? song.publishTime),
      }];
    });
  }

  async getUserCommentHistory(
    uid: string,
    limit: number,
    time: number,
    cookie: string,
  ): Promise<HistoryPage> {
    const body = await invoke("user_comment_history", () =>
      api.user_comment_history({
        uid,
        limit,
        time,
        ...this.requestConfig(cookie),
      }),
    );
    const data = object(body.data);
    const comments = array(data.comments).map(normalizeHistoryComment).filter(isDefined);
    const returnedCursor = numberOrUndefined(data.time ?? data.cursor);
    const lastTime = comments.at(-1)?.time;
    return {
      comments,
      hasMore: Boolean(data.hasMore),
      nextTime: returnedCursor ?? lastTime,
    };
  }

  private requestConfig(cookie?: string): { cookie?: string; proxy?: string; timeout: number } {
    return {
      cookie,
      proxy: this.options.proxy,
      timeout: this.options.requestTimeoutMs ?? 30_000,
    };
  }
}

async function invoke(name: string, call: () => Promise<ApiResponse>): Promise<JsonObject> {
  try {
    const response = await call();
    const status = Number(response.status ?? 500);
    const body = object(response.body);
    if (status !== 200 || (typeof body.code === "number" && body.code !== 200)) {
      if (status === 301 || body.code === 301) throw new AuthenticationRequired();
      throw new ApiResponseError(`${name} returned ${status}`, status, body);
    }
    return body;
  } catch (error) {
    if (error instanceof ApiResponseError || error instanceof AuthenticationRequired) throw error;
    if (error && typeof error === "object") {
      const candidate = error as ApiResponse;
      const status = Number(candidate.status);
      const body = object(candidate.body);
      if (status === 301 || body.code === 301) throw new AuthenticationRequired();
      throw new ApiResponseError(
        `${name} request failed`,
        Number.isFinite(status) ? status : undefined,
        candidate.body,
      );
    }
    throw error;
  }
}

function normalizeComment(raw: unknown): CommentRecord | undefined {
  const comment = object(raw);
  const user = object(comment.user);
  const commentId = stringId(comment.commentId ?? comment.id);
  const userId = stringId(user.userId ?? comment.userId);
  if (!commentId || !userId) return undefined;
  return {
    commentId,
    userId,
    nickname: text(user.nickname),
    content: text(comment.content) ?? "",
    time: numberOrUndefined(comment.time),
    likedCount: numberOrUndefined(comment.likedCount),
  };
}

function normalizeHistoryComment(raw: unknown): HistoryComment | undefined {
  const entry = object(raw);
  const nested = object(entry.comment);
  const normalized = normalizeComment(Object.keys(nested).length > 0 ? nested : entry);
  if (!normalized) return undefined;
  const resource = object(entry.resourceInfo ?? nested.resourceInfo);
  const threadId = text(entry.threadId ?? nested.threadId);
  const parsedThreadSongId = threadId?.match(/^R_SO_4_(\d+)$/)?.[1];
  return {
    ...normalized,
    songId: stringId(resource.id ?? entry.resourceId) ?? parsedThreadSongId,
    resourceName: text(resource.name ?? resource.title),
  };
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
