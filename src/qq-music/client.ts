import { zzcSign } from "./sign";
import { normalizeQQMusicUserInput } from "./user-input";
import type { SongSearchResult } from "../types";
import type {
  QQMusicComment,
  QQMusicCommentPage,
  QQMusicPlatformClient,
  QQMusicSong,
  QQMusicSongPage,
  QQMusicUser,
} from "./types";

const MUSICU_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const MUSICS_URL = "https://u.y.qq.com/cgi-bin/musics.fcg";
const USER_PLAYLIST_URL = "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss";
const SMARTBOX_URL = "https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg";
const DEFAULT_TIMEOUT_MS = 30_000;

// The current public GetNewCommentList contract rejects PageSize >= 26 with
// business code 10000. Keep this endpoint limit separate from likedPageSize,
// whose independent source-discovery endpoint accepts up to 500 songs.
export const QQ_MUSIC_COMMENT_PAGE_SIZE_MAX = 25;
export const DEFAULT_QQ_MUSIC_COMMENT_PAGE_SIZE = QQ_MUSIC_COMMENT_PAGE_SIZE_MAX;

export interface QQMusicClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

export class QQMusicApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
    public readonly retryable = status !== undefined
      && (status === 408 || status === 425 || (status >= 500 && status <= 599)),
  ) {
    super(message);
    this.name = "QQMusicApiError";
  }
}

export class QQMusicProtocolError extends QQMusicApiError {
  constructor(message: string, body?: unknown) {
    super(message, undefined, body, false);
    this.name = "QQMusicProtocolError";
  }
}

export type QQMusicCommentPageProtocolReason =
  | "empty-has-more"
  | "page-crosses-request-cursor";

/** A song-scoped cursor fault. It intentionally never retains the upstream response body. */
export class QQMusicCommentPageProtocolError extends QQMusicProtocolError {
  constructor(
    public readonly reason: QQMusicCommentPageProtocolReason,
    message: string,
  ) {
    super(message);
    this.name = "QQMusicCommentPageProtocolError";
  }
}

export class QQMusicClient implements QQMusicPlatformClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(options: QQMusicClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent
      ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
    if (!this.fetchImpl) throw new Error("QQ Music requires a runtime with fetch support.");
  }

  close(): void {
    const close = (this.fetchImpl as typeof fetch & { close?: () => void }).close;
    close?.();
  }

  async searchSongs(query: string, limit: number, signal?: AbortSignal): Promise<SongSearchResult[]> {
    const normalizedQuery = requireSearchQuery(query);
    requireInteger(limit, "limit", 1, 10);
    const data = requiredObject(await this.postCgi(
      "music.search.SearchCgiService",
      "DoSearchForQQMusicDesktop",
      {
        grp: 1,
        num_per_page: limit,
        page_num: 1,
        query: normalizedQuery,
        search_type: 0,
      },
      false,
      signal,
    ), "QQ Music search response data");
    const body = requiredObject(data.body, "QQ Music search response body", data);
    const song = requiredObject(body.song, "QQ Music search response song", data);
    const rows = requiredArray(song.list, "QQ Music search response song list", data);
    const songs = rows.map((row, index) => {
      const normalized = normalizeSearchSong(row);
      if (!normalized) {
        throw new QQMusicProtocolError(
          `QQ Music search response contains an invalid song at index ${index}.`,
          data,
        );
      }
      return normalized;
    });
    if (songs.length > 0) return songs;
    return this.searchSongsFromSmartbox(normalizedQuery, limit, signal);
  }

  private async searchSongsFromSmartbox(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SongSearchResult[]> {
    const params = new URLSearchParams({
      key: query,
      format: "json",
      inCharset: "utf-8",
      outCharset: "utf-8",
    });
    const payload = requiredObject(await this.requestJson(
      `${SMARTBOX_URL}?${params.toString()}`,
      { headers: this.headers() },
      signal,
    ), "QQ Music smartbox response");
    const code = protocolCode(payload.code);
    if (code === undefined) {
      throw new QQMusicProtocolError("QQ Music smartbox response code is missing or malformed.", payload);
    }
    if (code !== 0) {
      throw new QQMusicApiError(
        `QQ Music smartbox search failed with code ${code}.`,
        undefined,
        payload,
      );
    }
    const data = requiredObject(payload.data, "QQ Music smartbox response data", payload);
    const song = requiredObject(data.song, "QQ Music smartbox response song", payload);
    const rows = requiredArray(song.itemlist, "QQ Music smartbox response song itemlist", payload);
    return rows.slice(0, limit).map((row, index) => {
      const normalized = normalizeSmartboxSong(row);
      if (!normalized) {
        throw new QQMusicProtocolError(
          `QQ Music smartbox response contains an invalid song at index ${index}.`,
          payload,
        );
      }
      return normalized;
    });
  }

  async resolveUser(input: string, signal?: AbortSignal): Promise<QQMusicUser> {
    const normalized = normalizeUserInput(input);
    if (normalized.kind === "encrypt-uin") {
      return { input: input.trim(), encryptUin: normalized.value };
    }

    return this.requestPublicUserProfile(input, normalized, signal);
  }

  async getPublicUserProfile(input: string, signal?: AbortSignal): Promise<QQMusicUser> {
    return this.requestPublicUserProfile(input, normalizeUserInput(input), signal);
  }

  private async requestPublicUserProfile(
    input: string,
    normalized: ReturnType<typeof normalizeUserInput>,
    signal?: AbortSignal,
  ): Promise<QQMusicUser> {

    const query = new URLSearchParams({
      hostUin: "0",
      hostuin: normalized.value,
      sin: "0",
      size: "1",
      g_tk: "5381",
      loginUin: "0",
      format: "json",
      inCharset: "utf8",
      outCharset: "utf-8",
      notice: "0",
      platform: "yqq.json",
      needNewCode: "0",
    });
    const payload = object(await this.requestJson(`${USER_PLAYLIST_URL}?${query.toString()}`, {
      headers: this.headers(),
    }, signal));
    const code = number(payload.code);
    const data = object(payload.data);
    const encryptUin = text(data.encrypt_uin);
    if (code !== 0 || !encryptUin) {
      const privacyHint = code === 4000 ? " The user's public playlist profile is hidden." : "";
      throw new QQMusicApiError(
        `Unable to resolve the QQ Music public identity to EncryptUin.${privacyHint}`,
        undefined,
        payload,
      );
    }
    const nickname = text(data.hostname);
    const avatarUrl = text(data.headpic ?? data.headPic ?? data.avatar ?? data.avatarUrl);
    return {
      input: input.trim(),
      ...(normalized.kind === "numeric-uin" ? { numericUin: normalized.value } : {}),
      encryptUin,
      ...(nickname ? { nickname } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  }

  async getSongInfo(songId: string, signal?: AbortSignal): Promise<QQMusicSong> {
    requireNumericId(songId, "songId");
    const data = object(await this.postCgi(
      "music.pf_song_detail_svr",
      "get_song_detail_yqq",
      { song_id: songId },
      false,
      signal,
    ));
    const track = object(data.track_info);
    const id = idText(track.id) ?? songId;
    return {
      id,
      mid: text(track.mid),
      name: text(track.title ?? track.name),
      artists: array(track.singer)
        .map((entry) => text(object(entry).name))
        .filter((name): name is string => Boolean(name)),
    };
  }

  async getLikedSongsPage(
    encryptUin: string,
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<QQMusicSongPage> {
    requireEncryptUin(encryptUin);
    requireInteger(offset, "offset", 0);
    requireInteger(limit, "limit", 1, 500);
    const data = requiredObject(await this.postCgi(
      "music.srfDissInfo.DissInfo",
      "CgiGetDiss",
      {
        disstid: 0,
        dirid: 201,
        tag: true,
        song_begin: offset,
        song_num: limit,
        userinfo: true,
        orderlist: true,
        enc_host_uin: encryptUin,
      },
      false,
      signal,
    ), "QQ Music liked-song response data");
    const dataCodes = [numberOrUndefined(data.code), numberOrUndefined(data.subcode)]
      .filter((code): code is number => code !== undefined && code !== 0);
    if (dataCodes.length > 0) {
      const dataCode = dataCodes[0];
      const hint = dataCodes.includes(4000) ? " The liked-song list is not public." : "";
      throw new QQMusicApiError(
        `QQ Music liked-song lookup failed with code ${dataCode}.${hint}`,
        undefined,
        { code: dataCode, codes: dataCodes, data },
      );
    }
    const rawSongs = requiredArray(data.songlist, "QQ Music liked-song response songlist", data);
    const songs = rawSongs.map((rawSong, index) => {
      const song = normalizeSong(rawSong);
      if (!song) {
        throw new QQMusicProtocolError(
          `QQ Music liked-song response contains an invalid song at index ${index}.`,
          data,
        );
      }
      return song;
    });
    const nextOffset = offset + songs.length;
    return {
      songs,
      hasMore: requiredBooleanFlag(data.hasmore, "QQ Music liked-song response hasmore", data),
      total: numberOrUndefined(data.total_song_num),
      nextOffset,
    };
  }

  async getNewComments(
    songId: string,
    pageSize: number,
    pageNo: number,
    lastCommentSeqNo = "",
    signal?: AbortSignal,
  ): Promise<QQMusicCommentPage> {
    requireNumericId(songId, "songId");
    requireInteger(pageSize, "pageSize", 1, QQ_MUSIC_COMMENT_PAGE_SIZE_MAX);
    requireInteger(pageNo, "pageNo", 0);
    if (lastCommentSeqNo && !/^\d+$/.test(lastCommentSeqNo)) {
      throw new Error("lastCommentSeqNo must contain decimal digits.");
    }

    const data = requiredObject(await this.postCgi(
      "music.globalComment.CommentRead",
      "GetNewCommentList",
      {
        BizType: 1,
        BizId: songId,
        LastCommentSeqNo: lastCommentSeqNo,
        PageSize: pageSize,
        PageNum: pageNo,
        FromCommentId: "",
        WithHot: 0,
        PicEnable: 1,
        LastTotal: 0,
        LastTotalVer: "0",
      },
      false,
      signal,
    ), "QQ Music comment response data");
    const responseCodes = [
      numberOrUndefined(data.Code),
      numberOrUndefined(data.SubCode),
      numberOrUndefined(data.code),
      numberOrUndefined(data.subcode),
    ].filter((code): code is number => code !== undefined && code !== 0);
    if (responseCodes.length > 0) {
      const subCode = responseCodes[0];
      throw new QQMusicApiError(
        `QQ Music comment lookup failed with sub-code ${subCode}.`,
        undefined,
        { code: subCode, codes: responseCodes, data },
      );
    }
    const list = requiredObject(data.CommentList, "QQ Music comment response CommentList", data);
    const listCodes = [numberOrUndefined(list.Code), numberOrUndefined(list.SubCode)]
      .filter((code): code is number => code !== undefined && code !== 0);
    if (listCodes.length > 0) {
      throw new QQMusicApiError(
        `QQ Music comment list failed with code ${listCodes[0]}.`,
        undefined,
        { code: listCodes[0], codes: listCodes, data },
      );
    }
    const rawComments = requiredArray(list.Comments, "QQ Music comment response Comments", data);
    const comments = rawComments.map((rawComment, index) => {
      const comment = normalizeComment(rawComment);
      if (!comment) {
        throw new QQMusicProtocolError(
          `QQ Music comment response contains an invalid comment at index ${index}.`,
          data,
        );
      }
      return comment;
    });
    const hasMore = requiredBooleanFlag(list.HasMore, "QQ Music comment response HasMore", data);
    const nextCursor = comments.at(-1)?.seqNo;
    if (lastCommentSeqNo && comments.some(
      (comment) => BigInt(comment.seqNo) >= BigInt(lastCommentSeqNo),
    )) {
      throw new QQMusicCommentPageProtocolError(
        "page-crosses-request-cursor",
        "QQ Music comment page SeqNo values must be older than the request cursor.",
      );
    }
    if (hasMore && !nextCursor) {
      throw new QQMusicCommentPageProtocolError(
        "empty-has-more",
        "QQ Music comment cursor did not advance strictly backward; the checkpoint remains resumable.",
      );
    }
    return {
      comments,
      hasMore,
      nextCursor,
      total: numberOrUndefined(list.Total ?? data.TotalCmNum),
    };
  }

  /** Used by future protected endpoints; public comment and liked-song reads do not require it. */
  async postSignedCgi(
    module: string,
    method: string,
    param: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.postCgi(module, method, param, true, signal);
  }

  private async postCgi(
    module: string,
    method: string,
    param: Record<string, unknown>,
    signed = false,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const requestKey = "req_0";
    const payload = {
      comm: {
        cv: 4747474,
        ct: 24,
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        notice: 0,
        platform: "yqq.json",
        needNewCode: 1,
        uin: 0,
        g_tk_new_20200303: 5381,
        g_tk: 5381,
      },
      [requestKey]: { module, method, param },
    };
    const serialized = JSON.stringify(payload);
    const url = signed
      ? `${MUSICS_URL}?_=${Date.now()}&sign=${encodeURIComponent(zzcSign(serialized))}`
      : MUSICU_URL;
    const response = object(await this.requestJson(url, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: serialized,
    }, signal));
    const topCode = number(response.code);
    const request = object(response[requestKey]);
    const requestCode = number(request.code);
    if (topCode !== 0 || requestCode !== 0) {
      const code = requestCode || topCode;
      throw new QQMusicApiError(
        `QQ Music ${module}.${method} failed with code ${code}.`,
        undefined,
        { code, response },
      );
    }
    return request.data;
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    let taskAborted = signal?.aborted ?? false;
    const abortFromTask = (): void => {
      taskAborted = true;
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) abortFromTask();
    else signal?.addEventListener("abort", abortFromTask, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) {
        throw new QQMusicApiError(
          `QQ Music HTTP request failed with status ${response.status}.`,
          response.status,
          body,
        );
      }
      return body;
    } catch (error) {
      // A task cancellation may abort fetch just before the timeout fires while
      // the rejection is still queued. Preserve cancellation precedence so the
      // governor does not retry or report that deliberate stop as a timeout.
      if (timedOut && !taskAborted && !(error instanceof QQMusicApiError)) {
        throw new QQMusicApiError(
          `QQ Music request timed out after ${this.timeoutMs}ms.`,
          undefined,
          undefined,
          true,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromTask);
    }
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      referer: "https://y.qq.com/",
      "user-agent": this.userAgent,
    };
  }
}

export function normalizeUserInput(input: string):
  | { kind: "numeric-uin"; value: string }
  | { kind: "encrypt-uin"; value: string } {
  return normalizeQQMusicUserInput(input);
}

function normalizeSong(raw: unknown): QQMusicSong | undefined {
  const song = object(raw);
  const id = idText(song.id ?? song.songid ?? song.songId);
  if (!id || !/^\d+$/.test(id)) return undefined;
  return {
    id,
    mid: text(song.mid ?? song.songmid ?? song.songMid),
    name: text(song.title ?? song.name),
    artists: array(song.singer ?? song.singers)
      .map((entry) => text(object(entry).name))
      .filter((name): name is string => Boolean(name)),
  };
}

function normalizeSearchSong(raw: unknown): SongSearchResult | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const song = raw as Record<string, unknown>;
  const id = idText(song.id ?? song.songid ?? song.songId);
  const name = text(song.title ?? song.name)?.trim();
  const rawArtists = song.singer ?? song.singers;
  if (!id || !/^\d+$/.test(id) || !name || !Array.isArray(rawArtists)) return undefined;
  const artists = rawArtists.map((entry) => text(object(entry).name)?.trim());
  if (artists.some((artist) => !artist)) return undefined;
  const mid = text(song.mid ?? song.songmid ?? song.songMid);
  const albumValue = song.album;
  const album = typeof albumValue === "string"
    ? text(albumValue)?.trim()
    : text(object(albumValue).name ?? object(albumValue).title)?.trim()
      ?? text(song.albumname)?.trim();
  const intervalSeconds = nonNegativeIntegerOrUndefined(song.interval);
  const durationMs = intervalSeconds === undefined
    ? nonNegativeIntegerOrUndefined(song.durationMs)
    : intervalSeconds * 1_000;
  return {
    id,
    ...(mid ? { mid } : {}),
    name,
    artists: artists as string[],
    ...(album ? { album } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function normalizeSmartboxSong(raw: unknown): SongSearchResult | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const song = raw as Record<string, unknown>;
  const id = idText(song.id);
  const name = text(song.name)?.trim();
  const singer = text(song.singer)?.trim();
  const mid = text(song.mid);
  if (!id || !/^\d+$/.test(id) || !name || !singer) return undefined;
  return {
    id,
    ...(mid ? { mid } : {}),
    name,
    artists: [singer],
  };
}

function normalizeComment(raw: unknown): QQMusicComment | undefined {
  const comment = object(raw);
  const commentId = idText(comment.CmId);
  const seqNo = idText(comment.SeqNo);
  const authorEncryptUin = text(comment.EncryptUin);
  if (!commentId || !seqNo || !/^\d{1,64}$/.test(seqNo) || !authorEncryptUin) return undefined;
  const publishedSeconds = numberOrUndefined(comment.PubTime);
  return {
    commentId,
    seqNo,
    authorEncryptUin,
    nickname: text(comment.Nick),
    avatarUrl: text(comment.Avatar),
    content: text(comment.Content) ?? "",
    time: publishedSeconds === undefined ? undefined : publishedSeconds * 1_000,
    likedCount: numberOrUndefined(comment.PraiseNum),
    replyCount: numberOrUndefined(comment.ReplyCnt),
  };
}

function requireNumericId(value: string, name: string): void {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must contain decimal digits.`);
}

function requireSearchQuery(value: string): string {
  const query = String(value ?? "").trim();
  if (query.length < 2 || query.length > 80) {
    throw new Error("query must contain between 2 and 80 characters.");
  }
  return query;
}

function requireEncryptUin(value: string): void {
  if (!/^[A-Za-z0-9*_.-]{4,128}$/.test(value)) {
    throw new Error("EncryptUin contains unsupported characters.");
  }
}

function requireInteger(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function idText(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function protocolCode(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function booleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function requiredObject(
  value: unknown,
  label: string,
  body: unknown = value,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QQMusicProtocolError(`${label} is missing or malformed.`, body);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, label: string, body: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new QQMusicProtocolError(`${label} is missing or malformed.`, body);
  }
  return value;
}

function requiredBooleanFlag(value: unknown, label: string, body: unknown): boolean {
  if (value === true || value === false || value === 0 || value === 1 || value === "0" || value === "1") {
    return booleanFlag(value);
  }
  throw new QQMusicProtocolError(`${label} is missing or malformed.`, body);
}
