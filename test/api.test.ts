import assert from "node:assert/strict";
import { test } from "node:test";
import upstream = require("@neteasecloudmusicapienhanced/api");
import { EnhancedNcmClient } from "../src/api";

test("passes one static proxy and cookie to the upstream API", async () => {
  const mutable = upstream as unknown as {
    likelist: (params: Record<string, unknown>) => Promise<unknown>;
  };
  const original = mutable.likelist;
  let captured: Record<string, unknown> | undefined;
  mutable.likelist = async (params) => {
    captured = params;
    return { status: 200, body: { code: 200, ids: [123] }, cookie: [] };
  };

  try {
    const client = new EnhancedNcmClient({ proxy: "http://127.0.0.1:7890/" });
    const songs = await client.getLikedSongs("42", "MUSIC_U=test");
    assert.deepEqual(songs.map((song) => song.id), ["123"]);
    assert.equal(captured?.uid, "42");
    assert.equal(captured?.cookie, "MUSIC_U=test");
    assert.equal(captured?.proxy, "http://127.0.0.1:7890/");
    assert.equal(captured?.timeout, 30_000);
  } finally {
    mutable.likelist = original;
  }
});

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
