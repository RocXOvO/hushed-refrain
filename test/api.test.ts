import assert from "node:assert/strict";
import { test } from "node:test";
import upstream = require("@neteasecloudmusicapienhanced/api");
import { EnhancedNcmClient } from "../src/api";
import { ApiResponseError, AuthenticationRequired } from "../src/errors";
import { RequestGovernor } from "../src/governor";

test("searches NetEase songs through cloudsearch and normalizes lookup metadata", async () => {
  const mutable = upstream as unknown as {
    cloudsearch: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.cloudsearch;
  let captured: Record<string, unknown> | undefined;
  mutable.cloudsearch = async (params) => {
    captured = params;
    return {
      status: 200,
      body: {
        code: 200,
        result: {
          songs: [{
            id: 9001,
            name: " Example ",
            ar: [{ name: "Artist A" }, { name: "Artist B" }],
            al: { name: "Album" },
            dt: 234_567,
          }],
        },
      },
    };
  };

  try {
    const songs = await new EnhancedNcmClient({ proxy: "http://127.0.0.1:7890/" })
      .searchSongs("  示例歌曲  ", 7);
    assert.deepEqual(songs, [{
      id: "9001",
      name: "Example",
      artists: ["Artist A", "Artist B"],
      album: "Album",
      durationMs: 234_567,
    }]);
    assert.equal(captured?.keywords, "示例歌曲");
    assert.equal(captured?.type, 1);
    assert.equal(captured?.limit, 7);
    assert.equal(captured?.offset, 0);
    assert.equal(captured?.proxy, "http://127.0.0.1:7890/");
  } finally {
    mutable.cloudsearch = original;
  }
});

test("accepts an explicitly empty NetEase song-search result", async () => {
  const mutable = upstream as unknown as {
    cloudsearch: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.cloudsearch;
  mutable.cloudsearch = async () => ({ status: 200, body: { code: 200, result: { songs: [] } } });
  try {
    assert.deepEqual(await new EnhancedNcmClient().searchSongs("no result", 10), []);
  } finally {
    mutable.cloudsearch = original;
  }
});

test("rejects malformed NetEase song-search structures and validates input before fetch", async () => {
  const mutable = upstream as unknown as {
    cloudsearch: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.cloudsearch;
  let calls = 0;
  try {
    for (const result of [undefined, {}, { songs: {} }, { songs: [{ id: 7, name: "Song" }] }]) {
      mutable.cloudsearch = async () => {
        calls += 1;
        return { status: 200, body: { code: 200, result } };
      };
      await assert.rejects(
        new EnhancedNcmClient().searchSongs("valid query", 10),
        (error) => error instanceof ApiResponseError && error.status === 502,
      );
    }
    const callsBeforeValidation = calls;
    await assert.rejects(new EnhancedNcmClient().searchSongs("x", 10), /between 2 and 80/);
    await assert.rejects(new EnhancedNcmClient().searchSongs("valid", 11), /between 1 and 10/);
    assert.equal(calls, callsBeforeValidation);
  } finally {
    mutable.cloudsearch = original;
  }
});

test("resolves likes through the target user's owned playlist even with a login cookie", async () => {
  const mutable = upstream as unknown as {
    user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
    playlist_detail: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const originalListing = mutable.user_playlist;
  const originalDetail = mutable.playlist_detail;
  let capturedListing: Record<string, unknown> | undefined;
  let capturedDetail: Record<string, unknown> | undefined;
  mutable.user_playlist = async (params) => {
    capturedListing = params;
    return { status: 200, body: { code: 200, playlist: [{ id: 9, specialType: 5, creator: { userId: 42 } }] }, cookie: [] };
  };
  mutable.playlist_detail = async (params) => {
    capturedDetail = params;
    return { status: 200, body: { code: 200, playlist: { creator: { userId: 42 }, trackIds: [{ id: 123 }] } }, cookie: [] };
  };

  try {
    const client = new EnhancedNcmClient({ proxy: "http://127.0.0.1:7890/" });
    const songs = await client.getLikedSongs("42", "MUSIC_U=test");
    assert.deepEqual(songs.map((song) => song.id), ["123"]);
    assert.equal(capturedListing?.uid, "42");
    assert.equal(capturedListing?.cookie, "MUSIC_U=test");
    assert.equal(capturedListing?.proxy, "http://127.0.0.1:7890/");
    assert.equal(capturedListing?.timeout, 30_000);
    assert.equal(capturedDetail?.id, "9");
    assert.equal(capturedDetail?.cookie, "MUSIC_U=test");
  } finally {
    mutable.user_playlist = originalListing;
    mutable.playlist_detail = originalDetail;
  }
});

test("turns NetEase 301 responses into a clear login requirement", async () => {
  const mutable = upstream as unknown as {
    user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.user_playlist;
  mutable.user_playlist = async () => {
    throw { status: 301, body: { code: 301 } };
  };

  try {
    await assert.rejects(
      new EnhancedNcmClient().getLikedSongs("42"),
      (error: unknown) => error instanceof AuthenticationRequired && /二维码登录/.test(error.message),
    );
  } finally {
    mutable.user_playlist = original;
  }
});

test("rejects a liked playlist owned by the logged-in account instead of the target UID", async () => {
  const mutable = upstream as unknown as {
    user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
    playlist_detail: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const originalListing = mutable.user_playlist;
  const originalDetail = mutable.playlist_detail;
  mutable.user_playlist = async () => ({
    status: 200,
    body: { code: 200, playlist: [{ id: 9, specialType: 5, creator: { userId: 42 } }] },
  });
  mutable.playlist_detail = async () => ({
    status: 200,
    body: { code: 200, playlist: { creator: { userId: 777 }, trackIds: [{ id: 123 }] } },
  });
  try {
    await assert.rejects(
      new EnhancedNcmClient().getLikedSongs("42", "MUSIC_U=operator"),
      (error: unknown) => error instanceof ApiResponseError && /UID/.test(error.message),
    );
  } finally {
    mutable.user_playlist = originalListing;
    mutable.playlist_detail = originalDetail;
  }
});

test("accepts an explicitly empty target liked playlist", async () => {
  const mutable = upstream as unknown as {
    user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
    playlist_detail: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const originalListing = mutable.user_playlist;
  const originalDetail = mutable.playlist_detail;
  mutable.user_playlist = async () => ({
    status: 200,
    body: { playlist: [{ id: 9, specialType: 5, trackCount: 0, creator: { userId: 42 } }] },
  });
  mutable.playlist_detail = async () => ({
    status: 200,
    body: { playlist: { creator: { userId: 42 }, trackCount: 0, trackIds: [] } },
  });
  try {
    assert.deepEqual(await new EnhancedNcmClient().getLikedSongs("42", "MUSIC_U=operator"), []);
  } finally {
    mutable.user_playlist = originalListing;
    mutable.playlist_detail = originalDetail;
  }
});

for (const detailTrackCount of [0, null] as const) {
  test(`rejects an empty liked-playlist detail when the listing declares songs (${String(detailTrackCount)})`, async () => {
    const mutable = upstream as unknown as {
      user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
      playlist_detail: (params: Record<string, unknown>) => Promise<unknown>;
    };
    const originalListing = mutable.user_playlist;
    const originalDetail = mutable.playlist_detail;
    mutable.user_playlist = async () => ({
      status: 200,
      body: { playlist: [{ id: 9, specialType: 5, trackCount: 100, creator: { userId: 42 } }] },
    });
    mutable.playlist_detail = async () => ({
      status: 200,
      body: {
        playlist: {
          creator: { userId: 42 },
          trackCount: detailTrackCount,
          trackIds: [],
        },
      },
    });
    try {
      await assert.rejects(
        new EnhancedNcmClient().getLikedSongs("42", "MUSIC_U=operator"),
        (error: unknown) => error instanceof ApiResponseError && error.status === 502,
      );
    } finally {
      mutable.user_playlist = originalListing;
      mutable.playlist_detail = originalDetail;
    }
  });
}

test("requires explicit trackIds even when a liked-playlist detail declares zero songs", async () => {
  const mutable = upstream as unknown as {
    user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
    playlist_detail: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const originalListing = mutable.user_playlist;
  const originalDetail = mutable.playlist_detail;
  mutable.user_playlist = async () => ({
    status: 200,
    body: { playlist: [{ id: 9, specialType: 5, trackCount: 0, creator: { userId: 42 } }] },
  });
  mutable.playlist_detail = async () => ({
    status: 200,
    body: { playlist: { creator: { userId: 42 }, trackCount: 0 } },
  });
  try {
    await assert.rejects(
      new EnhancedNcmClient().getLikedSongs("42", "MUSIC_U=operator"),
      (error: unknown) => error instanceof ApiResponseError && error.status === 502,
    );
  } finally {
    mutable.user_playlist = originalListing;
    mutable.playlist_detail = originalDetail;
  }
});

for (const [label, playlist] of [
  ["missing trackIds", { creator: { userId: 42 }, trackCount: 2 }],
  ["truncated trackIds", { creator: { userId: 42 }, trackCount: 2, trackIds: [{ id: 1 }] }],
  ["malformed trackIds", { creator: { userId: 42 }, trackCount: 1, trackIds: [{}] }],
] as const) {
  test(`rejects ${label} instead of checkpointing a partial liked-song catalog`, async () => {
    const mutable = upstream as unknown as {
      user_playlist: (params: Record<string, unknown>) => Promise<unknown>;
      playlist_detail: (params: Record<string, unknown>) => Promise<unknown>;
    };
    const originalListing = mutable.user_playlist;
    const originalDetail = mutable.playlist_detail;
    mutable.user_playlist = async () => ({
      status: 200,
      body: { playlist: [{ id: 9, specialType: 5, trackCount: 2, creator: { userId: 42 } }] },
    });
    mutable.playlist_detail = async () => ({ status: 200, body: { playlist } });
    try {
      await assert.rejects(
        new EnhancedNcmClient().getLikedSongs("42", "MUSIC_U=operator"),
        (error: unknown) => error instanceof ApiResponseError && error.status === 502,
      );
    } finally {
      mutable.user_playlist = originalListing;
      mutable.playlist_detail = originalDetail;
    }
  });
}

test("normalizes a UID profile from user_detail", async () => {
  const mutable = upstream as unknown as {
    user_detail: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.user_detail;
  mutable.user_detail = async () => ({
    status: 200,
    body: {
      code: 200,
      level: 9,
      listenSongs: 456,
      profile: {
        userId: 42,
        nickname: "target",
        signature: "hello",
        playlistCount: 12,
        follows: 3,
        followeds: 8,
      },
    },
    cookie: [],
  });

  try {
    const profile = await new EnhancedNcmClient().getUserProfile("42");
    assert.deepEqual(profile, {
      userId: "42",
      nickname: "target",
      signature: "hello",
      level: 9,
      listenSongs: 456,
      playlistCount: 12,
      follows: 3,
      followeds: 8,
    });
  } finally {
    mutable.user_detail = original;
  }
});

test("uses comment_new time cursors without a login cookie", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  let captured: Record<string, unknown> | undefined;
  mutable.comment_new = async (params) => {
    captured = params;
    return {
      status: 200,
      body: {
        code: 200,
        data: {
          comments: [{
            commentId: 7,
            user: { userId: 42, nickname: "target" },
            content: "live comment",
            time: 1_700_000_000_000,
          }],
          cursor: "1699999999999",
          hasMore: true,
          totalCount: 123,
        },
      },
    };
  };

  try {
    const page = await new EnhancedNcmClient({
      proxy: "http://127.0.0.1:7897/",
    }).getSongCommentsByCursor("186016", 1000, 2, "1700000000000");
    assert.equal(captured?.sortType, 3);
    assert.equal(captured?.pageSize, 1000);
    assert.equal(captured?.cursor, "1700000000000");
    assert.equal(captured?.cookie, undefined);
    assert.equal(captured?.proxy, "http://127.0.0.1:7897/");
    assert.equal(page.comments[0].userId, "42");
    assert.equal(page.nextCursor, "1699999999999");
    assert.equal(page.total, 123);
  } finally {
    mutable.comment_new = original;
  }
});

test("rejects a truncated HTTP 200 comment response instead of treating it as an empty final page", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  mutable.comment_new = async () => ({ status: 200, body: Buffer.from('{"code":200') });

  try {
    await assert.rejects(
      new EnhancedNcmClient().getSongCommentsByCursor("186016", 1000, 1, "1700000000000"),
      (error: unknown) => error instanceof ApiResponseError && error.status === 502 && /不完整/.test(error.message),
    );
  } finally {
    mutable.comment_new = original;
  }
});

test("rejects a structurally incomplete comment page without advancing its cursor", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  mutable.comment_new = async () => ({ status: 200, body: { code: 200, data: { hasMore: true } } });

  try {
    await assert.rejects(
      new EnhancedNcmClient().getSongCommentsByCursor("186016", 1000, 1, "1700000000000"),
      (error: unknown) => error instanceof ApiResponseError && error.status === 502,
    );
  } finally {
    mutable.comment_new = original;
  }
});

test("rejects a comment page containing an unidentifiable comment instead of silently skipping it", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  mutable.comment_new = async () => ({
    status: 200,
    body: {
      code: 200,
      data: {
        comments: [{ commentId: "broken", user: null, content: "cannot identify author" }],
        hasMore: false,
      },
    },
  });

  try {
    await assert.rejects(
      new EnhancedNcmClient().getSongCommentsByCursor("186016", 1000, 1, "1700000000000"),
      (error: unknown) => error instanceof ApiResponseError && error.status === 502,
    );
  } finally {
    mutable.comment_new = original;
  }
});

test("rejects a non-descending comment cursor so the current range remains resumable", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  mutable.comment_new = async () => ({
    status: 200,
    body: { code: 200, data: { comments: [], hasMore: true, cursor: "1700000000000" } },
  });

  try {
    await assert.rejects(
      new EnhancedNcmClient().getSongCommentsByCursor("186016", 1000, 1, "1700000000000"),
      (error: unknown) => error instanceof ApiResponseError && error.status === 502,
    );
  } finally {
    mutable.comment_new = original;
  }
});

test("uses an error body code as the retryable status and succeeds on the same cursor", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  let calls = 0;
  const cursors: unknown[] = [];
  mutable.comment_new = async (params) => {
    calls += 1;
    cursors.push(params.cursor);
    if (calls === 1) {
      return { status: 200, body: { code: 502, msg: "Unexpected end of JSON input" } };
    }
    return { status: 200, body: { code: 200, data: { comments: [], hasMore: false } } };
  };
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 1,
    retryBaseMs: 0,
    retryCapMs: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  });

  try {
    const client = new EnhancedNcmClient();
    const page = await governor.execute("comment_new:186016", () =>
      client.getSongCommentsByCursor("186016", 1000, 1, "1700000000000")
    );
    assert.equal(calls, 2);
    assert.deepEqual(cursors, ["1700000000000", "1700000000000"]);
    assert.equal(page.hasMore, false);
  } finally {
    mutable.comment_new = original;
  }
});

test("uses a rejected response body code when HTTP status is misleading", async () => {
  const mutable = upstream as unknown as {
    comment_new: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.comment_new;
  let calls = 0;
  mutable.comment_new = async () => {
    calls += 1;
    if (calls === 1) throw { status: 200, body: { code: 502, msg: "Unexpected end of JSON input" } };
    return { status: 200, body: { code: 200, data: { comments: [], hasMore: false } } };
  };
  const governor = new RequestGovernor({
    minDelayMs: 0,
    jitterMs: 0,
    maxRetries: 1,
    retryBaseMs: 0,
    retryCapMs: 0,
    forbiddenCooldownMs: 60_000,
    requestBudget: 10,
  });

  try {
    const client = new EnhancedNcmClient();
    await governor.execute("comment_new:186016", () =>
      client.getSongCommentsByCursor("186016", 1000, 1, "1700000000000")
    );
    assert.equal(calls, 2);
  } finally {
    mutable.comment_new = original;
  }
});

test("loads song metadata in one batch for liked-song names", async () => {
  const mutable = upstream as unknown as {
    song_detail: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.song_detail;
  let captured: Record<string, unknown> | undefined;
  mutable.song_detail = async (params) => {
    captured = params;
    return {
      status: 200,
      body: {
        code: 200,
        songs: [
          { id: 11, name: "first", ar: [{ name: "artist-a" }], al: { publishTime: 1 } },
          { id: 12, name: "second", ar: [{ name: "artist-b" }], al: { publishTime: 2 } },
        ],
      },
    };
  };

  try {
    const client = new EnhancedNcmClient({ proxy: "http://127.0.0.1:7890/" });
    const songs = await client.getSongInfos(["11", "12", "11"]);
    assert.equal(captured?.ids, "11,12");
    assert.equal(captured?.proxy, "http://127.0.0.1:7890/");
    assert.deepEqual(songs.map((song) => [song.id, song.name]), [["11", "first"], ["12", "second"]]);
  } finally {
    mutable.song_detail = original;
  }
});
