import assert from "node:assert/strict";
import test from "node:test";
import { QQMusicApiError, QQMusicClient, QQMusicProtocolError, normalizeUserInput } from "../src/qq-music/client";
import { zzcSign } from "../src/qq-music/sign";

test("zzcSign matches independently verified fixtures", () => {
  assert.equal(zzcSign(""), "zzcf0e03e5gx4qeiq5cfgdyqwu7sdqfsb5fro3aa45053");
  assert.equal(zzcSign('{"a":1}'), "zzc7746109xq501htmv4ipz7c8owlxfpihjm1fd695c7");
});

test("normalizeUserInput accepts QQ numbers, profile URLs, and EncryptUin", () => {
  assert.deepEqual(normalizeUserInput("123456"), { kind: "numeric-uin", value: "123456" });
  assert.deepEqual(
    normalizeUserInput("https://y.qq.com/n/ryqq/profile/998877"),
    { kind: "numeric-uin", value: "998877" },
  );
  assert.deepEqual(
    normalizeUserInput("https://y.qq.com/portal/profile.html?uin=778899"),
    { kind: "numeric-uin", value: "778899" },
  );
  assert.deepEqual(normalizeUserInput("oK-i7e4s"), { kind: "encrypt-uin", value: "oK-i7e4s" });
});

test("QQMusicClient uses the public desktop search contract and preserves large string IDs", async () => {
  let request: { module: string; method: string; param: Record<string, unknown> } | undefined;
  const requestedId = "900719925474099312345";
  const client = new QQMusicClient({
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      request = (JSON.parse(String(init?.body)) as {
        req_0: { module: string; method: string; param: Record<string, unknown> };
      }).req_0;
      return cgiResponse({
        body: {
          song: {
            list: [{
              id: requestedId,
              mid: "song-mid",
              title: " Search Result ",
              singer: [{ name: "Artist A" }, { name: "Artist B" }],
              album: { name: "Album" },
              interval: 241,
            }],
          },
        },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.searchSongs("  搜索歌曲  ", 6), [{
    id: requestedId,
    mid: "song-mid",
    name: "Search Result",
    artists: ["Artist A", "Artist B"],
    album: "Album",
    durationMs: 241_000,
  }]);
  assert.equal(request?.module, "music.search.SearchCgiService");
  assert.equal(request?.method, "DoSearchForQQMusicDesktop");
  assert.deepEqual(request?.param, {
    grp: 1,
    num_per_page: 6,
    page_num: 1,
    query: "搜索歌曲",
    search_type: 0,
  });
});

test("QQMusicClient accepts empty search results but rejects malformed search protocol", async () => {
  const empty = new QQMusicClient({
    fetch: (async (url: string | URL) => String(url).includes("smartbox_new.fcg")
      ? jsonResponse({ code: 0, data: { song: { itemlist: [] } } })
      : cgiResponse({ body: { song: { list: [] } } })) as typeof fetch,
  });
  assert.deepEqual(await empty.searchSongs("nothing", 10), []);

  for (const data of [
    {},
    { body: {} },
    { body: { song: {} } },
    { body: { song: { list: {} } } },
    { body: { song: { list: [{ id: "7", title: "Song" }] } } },
    { body: { song: { list: [{ id: 9_007_199_254_740_992, title: "Song", singer: [] }] } } },
  ]) {
    const client = new QQMusicClient({ fetch: (async () => cgiResponse(data)) as typeof fetch });
    await assert.rejects(
      client.searchSongs("valid query", 10),
      (error) => error instanceof QQMusicProtocolError,
    );
  }
});

test("QQMusicClient falls back from a valid empty desktop search to the official smartbox", async () => {
  const urls: string[] = [];
  const requestedId = "900719925474099312345";
  const client = new QQMusicClient({
    fetch: (async (url: string | URL) => {
      urls.push(String(url));
      if (String(url).includes("smartbox_new.fcg")) {
        return jsonResponse({
          code: 0,
          data: {
            song: {
              itemlist: [
                { id: requestedId, mid: "smart-mid", name: "晴天", singer: "周杰伦" },
                { id: "8", mid: "second-mid", name: "晴天 II", singer: "Artist" },
              ],
            },
          },
        });
      }
      return cgiResponse({ body: { song: { list: [] }, estimate_sum: 12 } });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.searchSongs("晴天", 1), [{
    id: requestedId,
    mid: "smart-mid",
    name: "晴天",
    artists: ["周杰伦"],
  }]);
  assert.equal(urls.length, 2);
  const smartbox = new URL(urls[1]);
  assert.equal(smartbox.hostname, "c.y.qq.com");
  assert.equal(smartbox.searchParams.get("key"), "晴天");
  assert.equal(smartbox.searchParams.get("format"), "json");
});

test("QQMusicClient rejects malformed smartbox fallback responses", async () => {
  for (const fallback of [
    {},
    { code: 0 },
    { code: 0, data: {} },
    { code: 0, data: { song: {} } },
    { code: 0, data: { song: { itemlist: {} } } },
    { code: 0, data: { song: { itemlist: [{ id: "7", name: "Song" }] } } },
  ]) {
    const client = new QQMusicClient({
      fetch: (async (url: string | URL) => String(url).includes("smartbox_new.fcg")
        ? jsonResponse(fallback)
        : cgiResponse({ body: { song: { list: [] } } })) as typeof fetch,
    });
    await assert.rejects(
      client.searchSongs("valid query", 10),
      (error) => error instanceof QQMusicProtocolError,
    );
  }
});

test("QQMusicClient forwards cancellation to the smartbox fallback request", async () => {
  let fallbackStarted = (): void => {};
  const started = new Promise<void>((resolve) => { fallbackStarted = resolve; });
  let fallbackSignal: AbortSignal | undefined;
  const client = new QQMusicClient({
    fetch: (async (url: string | URL, init?: RequestInit) => {
      if (!String(url).includes("smartbox_new.fcg")) {
        return cgiResponse({ body: { song: { list: [] } } });
      }
      fallbackSignal = init?.signal ?? undefined;
      fallbackStarted();
      return new Promise<Response>((_resolve, reject) => {
        fallbackSignal?.addEventListener("abort", () => reject(new Error("smartbox aborted")), { once: true });
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const search = client.searchSongs("valid query", 10, controller.signal);
  await started;
  controller.abort();

  await assert.rejects(search, /smartbox aborted/);
  assert.equal(fallbackSignal?.aborted, true);
});

test("QQMusicClient validates search bounds before issuing a request", async () => {
  let calls = 0;
  const client = new QQMusicClient({
    fetch: (async () => {
      calls += 1;
      return cgiResponse({ body: { song: { list: [] } } });
    }) as typeof fetch,
  });
  await assert.rejects(client.searchSongs("x", 10), /between 2 and 80/);
  await assert.rejects(client.searchSongs("valid", 11), /between 1 and 10/);
  assert.equal(calls, 0);
});

test("resolveUser maps a numeric QQ number to the opaque comment identity", async () => {
  let requestedUrl = "";
  const client = new QQMusicClient({
    fetch: (async (url: string | URL) => {
      requestedUrl = String(url);
      return jsonResponse({
        code: 0,
        data: { encrypt_uin: "oK-i7e4s", hostname: "example" },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.resolveUser("123456"), {
    input: "123456",
    numericUin: "123456",
    encryptUin: "oK-i7e4s",
    nickname: "example",
  });
  assert.match(requestedUrl, /hostuin=123456/);
});

test("QQMusicClient normalizes liked songs, song metadata, and SeqNo comments", async () => {
  const requests: Array<{ module: string; method: string; param: Record<string, unknown> }> = [];
  const client = new QQMusicClient({
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        req_0: { module: string; method: string; param: Record<string, unknown> };
      };
      requests.push(body.req_0);
      if (body.req_0.method === "CgiGetDiss") {
        return cgiResponse({
          total_song_num: 2,
          hasmore: 0,
          songlist: [{
            id: 7,
            mid: "song-mid",
            title: "Song title",
            singer: [{ name: "Artist" }],
          }],
        });
      }
      if (body.req_0.method === "get_song_detail_yqq") {
        return cgiResponse({
          track_info: {
            id: 7,
            mid: "song-mid",
            title: "Song title",
            singer: [{ name: "Artist" }],
          },
        });
      }
      return cgiResponse({
        CommentList: {
          HasMore: 1,
          Total: 20,
          Comments: [{
            CmId: "comment-id",
            SeqNo: "9988",
            EncryptUin: "opaque-user",
            Nick: "Nickname",
            Content: "content",
            PubTime: 1_700_000_000,
            PraiseNum: 3,
            ReplyCnt: 2,
          }],
        },
      });
    }) as typeof fetch,
  });

  assert.deepEqual(await client.getSongInfo("7"), {
    id: "7",
    mid: "song-mid",
    name: "Song title",
    artists: ["Artist"],
  });
  assert.deepEqual(await client.getLikedSongsPage("opaque-user", 0, 10), {
    songs: [{ id: "7", mid: "song-mid", name: "Song title", artists: ["Artist"] }],
    hasMore: false,
    total: 2,
    nextOffset: 1,
  });
  assert.deepEqual(await client.getNewComments("7", 25, 0), {
    comments: [{
      commentId: "comment-id",
      seqNo: "9988",
      authorEncryptUin: "opaque-user",
      nickname: "Nickname",
      avatarUrl: undefined,
      content: "content",
      time: 1_700_000_000_000,
      likedCount: 3,
      replyCount: 2,
    }],
    hasMore: true,
    nextCursor: "9988",
    total: 20,
  });
  assert.deepEqual(requests.map((request) => request.method), [
    "get_song_detail_yqq",
    "CgiGetDiss",
    "GetNewCommentList",
  ]);
  assert.deepEqual(requests[2].param, {
    BizType: 1,
    BizId: "7",
    LastCommentSeqNo: "",
    PageSize: 25,
    PageNum: 0,
    FromCommentId: "",
    WithHot: 0,
    PicEnable: 1,
    LastTotal: 0,
    LastTotalVer: "0",
  });
});

test("QQMusicClient preserves decimal song IDs instead of converting them through Number", async () => {
  const requestedSongId = "900719925474099312345";
  let sentSongId: unknown;
  const client = new QQMusicClient({
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        req_0: { param: { song_id?: unknown } };
      };
      sentSongId = body.req_0.param.song_id;
      return cgiResponse({
        track_info: { id: "7", mid: "metadata-mid", title: "metadata" },
      });
    }) as typeof fetch,
  });

  await client.getSongInfo(requestedSongId);
  assert.equal(sentSongId, requestedSongId);
});

test("QQMusicClient rejects comment page sizes above the live API maximum before fetch", async () => {
  let fetchCalls = 0;
  const client = new QQMusicClient({
    fetch: (async () => {
      fetchCalls += 1;
      return cgiResponse({ CommentList: { HasMore: 0, Comments: [] } });
    }) as typeof fetch,
  });

  await assert.rejects(client.getNewComments("7", 26, 0), /between 1 and 25/);
  assert.equal(fetchCalls, 0);
});

test("QQMusicClient advances PageNum and LastCommentSeqNo across consecutive 25-comment pages", async () => {
  const params: Array<Record<string, unknown>> = [];
  const client = new QQMusicClient({
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        req_0: { param: Record<string, unknown> };
      };
      params.push(body.req_0.param);
      return cgiResponse({
        CommentList: params.length === 1
          ? {
            HasMore: 1,
            Comments: [{ CmId: "first", SeqNo: "100", EncryptUin: "opaque", Content: "" }],
          }
          : {
            HasMore: 1,
            Comments: [{ CmId: "second", SeqNo: "75", EncryptUin: "opaque", Content: "" }],
          },
      });
    }) as typeof fetch,
  });

  const first = await client.getNewComments("7", 25, 0);
  assert.equal(first.nextCursor, "100");
  const second = await client.getNewComments("7", 25, 1, first.nextCursor);
  assert.equal(second.nextCursor, "75");
  assert.deepEqual(params.map((param) => ({
    PageSize: param.PageSize,
    PageNum: param.PageNum,
    LastCommentSeqNo: param.LastCommentSeqNo,
  })), [
    { PageSize: 25, PageNum: 0, LastCommentSeqNo: "" },
    { PageSize: 25, PageNum: 1, LastCommentSeqNo: "100" },
  ]);
});

test("QQMusicClient keeps page size 1 available for legacy valid checkpoints", async () => {
  let pageSize: unknown;
  const client = new QQMusicClient({
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        req_0: { param: Record<string, unknown> };
      };
      pageSize = body.req_0.param.PageSize;
      return cgiResponse({ CommentList: { HasMore: 0, Comments: [] } });
    }) as typeof fetch,
  });

  await client.getNewComments("7", 1, 0);
  assert.equal(pageSize, 1);
});

test("QQMusicClient treats upstream request code 10000 as a deterministic API failure", async () => {
  const client = new QQMusicClient({
    fetch: (async () => jsonResponse({
      code: 0,
      req_0: { code: 10000, data: { AllowComment: 0, CommentList: { Comments: [] } } },
    })) as typeof fetch,
  });

  await assert.rejects(client.getNewComments("7", 25, 0), (error: unknown) => {
    assert.equal(error instanceof QQMusicApiError, true);
    assert.equal((error as QQMusicApiError).retryable, false);
    assert.equal((error as QQMusicApiError).body && (
      (error as QQMusicApiError).body as { code?: number }
    ).code, 10000);
    return true;
  });
});

test("QQMusicClient rejects a has-more page whose SeqNo cursor does not advance", async () => {
  const client = new QQMusicClient({
    fetch: (async () => cgiResponse({
      CommentList: {
        HasMore: 1,
        Comments: [{ CmId: "c", SeqNo: "10", EncryptUin: "opaque", Content: "" }],
      },
    })) as typeof fetch,
  });
  await assert.rejects(
    client.getNewComments("7", 20, 1, "10"),
    /cursor did not advance/,
  );
});

test("QQMusicClient rejects forward and non-decimal comment cursors", async () => {
  const forward = new QQMusicClient({
    fetch: (async () => cgiResponse({
      CommentList: {
        HasMore: 1,
        Comments: [{ CmId: "c", SeqNo: "11", EncryptUin: "opaque", Content: "" }],
      },
    })) as typeof fetch,
  });
  await assert.rejects(forward.getNewComments("7", 20, 1, "10"), /strictly backward/);

  const malformed = new QQMusicClient({
    fetch: (async () => cgiResponse({
      CommentList: {
        HasMore: 1,
        Comments: [{ CmId: "c", SeqNo: "not-a-number", EncryptUin: "opaque" }],
      },
    })) as typeof fetch,
  });
  await assert.rejects(malformed.getNewComments("7", 20, 0), /invalid comment/);
});

test("QQMusicClient requires every comment SeqNo to form one strictly descending page", async () => {
  const unordered = new QQMusicClient({
    fetch: (async () => cgiResponse({
      CommentList: {
        HasMore: 1,
        Comments: [
          { CmId: "a", SeqNo: "100", EncryptUin: "opaque", Content: "" },
          { CmId: "b", SeqNo: "80", EncryptUin: "opaque", Content: "" },
          { CmId: "c", SeqNo: "90", EncryptUin: "opaque", Content: "" },
        ],
      },
    })) as typeof fetch,
  });
  await assert.rejects(unordered.getNewComments("7", 20, 0), /SeqNo.*strictly descending/i);

  const crossesRequestCursor = new QQMusicClient({
    fetch: (async () => cgiResponse({
      CommentList: {
        HasMore: 1,
        Comments: [
          { CmId: "a", SeqNo: "101", EncryptUin: "opaque", Content: "" },
          { CmId: "b", SeqNo: "90", EncryptUin: "opaque", Content: "" },
        ],
      },
    })) as typeof fetch,
  });
  await assert.rejects(
    crossesRequestCursor.getNewComments("7", 20, 1, "100"),
    /SeqNo.*older than.*request cursor/i,
  );
});

test("QQMusicClient rejects missing list structures instead of reporting empty coverage", async () => {
  const comments = new QQMusicClient({
    fetch: (async () => cgiResponse({})) as typeof fetch,
  });
  await assert.rejects(comments.getNewComments("7", 20, 0), /CommentList.*missing or malformed/);

  const liked = new QQMusicClient({
    fetch: (async () => cgiResponse({ hasmore: 0 })) as typeof fetch,
  });
  await assert.rejects(liked.getLikedSongsPage("opaque-user", 0, 20), /songlist.*missing or malformed/);
});

test("QQMusicClient checks liked-song code and subcode independently", async () => {
  const client = new QQMusicClient({
    fetch: (async () => cgiResponse({ code: 0, subcode: 4000, songlist: [], hasmore: 0 })) as typeof fetch,
  });
  await assert.rejects(
    client.getLikedSongsPage("opaque-user", 0, 20),
    (error: unknown) => {
      assert.equal((error as { body?: { code?: number } }).body?.code, 4000);
      assert.match((error as Error).message, /not public/);
      return true;
    },
  );
});

test("QQMusicClient forwards task cancellation to the active fetch", async () => {
  let fetchSignal: AbortSignal | undefined;
  const client = new QQMusicClient({
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(new Error("fetch aborted")), {
          once: true,
        });
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const running = client.getNewComments("7", 25, 0, undefined, controller.signal);
  await Promise.resolve();
  controller.abort();

  await assert.rejects(running, /fetch aborted/);
  assert.equal(fetchSignal?.aborted, true);
});

test("QQMusicClient does not misreport a task cancellation racing the timeout", async () => {
  const cancellation = new Error("operator stopped task");
  const client = new QQMusicClient({
    timeoutMs: 1,
    fetch: (async (_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          setTimeout(() => reject(cancellation), 5);
        }, { once: true });
      });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const running = client.getNewComments("7", 25, 0, undefined, controller.signal);
  controller.abort(cancellation);

  await assert.rejects(running, (error: unknown) => error === cancellation);
});

function cgiResponse(data: unknown): Response {
  return jsonResponse({ code: 0, req_0: { code: 0, data } });
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
