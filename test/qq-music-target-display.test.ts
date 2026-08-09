import assert from "node:assert/strict";
import test from "node:test";
import { encodeClassicEncryptUin } from "../src/qq-music/classic-encrypt-uin";
import { describeQQMusicTarget, qqMusicTargetAvatarUrl } from "../src/qq-music/target-display";

test("describes numeric QQ and its official profile URL without masking", () => {
  const expected = { kind: "qq-number", label: "QQ 123456789", profileLookup: "123456789" };
  assert.deepEqual(describeQQMusicTarget("123456789"), expected);
  assert.deepEqual(
    describeQQMusicTarget("https://y.qq.com/n/ryqq/profile/123456789"),
    expected,
  );
  assert.equal(
    qqMusicTargetAvatarUrl(describeQQMusicTarget("123456789")),
    "https://q1.qlogo.cn/g?b=qq&nk=123456789&s=100",
  );
});

test("keeps a directly entered 19-digit numeric identity in the QQ-number category", () => {
  const value = "1150000000000000472";
  assert.deepEqual(describeQQMusicTarget(value), {
    kind: "qq-number",
    label: `QQ ${value}`,
    profileLookup: value,
  });
});

test("decodes classic EncryptUin and its official profile URL to the same full QQ label", () => {
  const token = encodeClassicEncryptUin("123456789012");
  const expected = { kind: "qq-number", label: "QQ 123456789012", profileLookup: "123456789012" };
  assert.deepEqual(describeQQMusicTarget(token), expected);
  assert.deepEqual(
    describeQQMusicTarget(`https://y.qq.com/n/ryqq_v2/profile?uin=${token}`),
    expected,
  );
  assert.equal(
    qqMusicTargetAvatarUrl(describeQQMusicTarget(token)),
    "https://q1.qlogo.cn/g?b=qq&nk=123456789012&s=100",
  );
});

test("labels the 28-character wxuin form as a WeChat user instead of a QQ or WeChat number", () => {
  const identifier = "1150000000000000472";
  const token = encodeClassicEncryptUin(identifier);
  assert.deepEqual(describeQQMusicTarget(token), {
    kind: "wechat-user",
    label: "微信用户",
    profileLookup: identifier,
  });
  assert.doesNotMatch(describeQQMusicTarget(token).label, /QQ|QQ号|微信号/);
  assert.equal(qqMusicTargetAvatarUrl(describeQQMusicTarget(token)), undefined);
});

test("shows an irreversible opaque target as a full EncryptUin without inventing a QQ", () => {
  const token = "opaque-user_1234";
  const expected = { kind: "encrypt-uin", label: `EncryptUin ${token}`, profileLookup: token };
  assert.deepEqual(describeQQMusicTarget(token), expected);
  assert.deepEqual(
    describeQQMusicTarget(`https://y.qq.com/portal/profile.html?uin=${token}`),
    expected,
  );
  assert.equal(qqMusicTargetAvatarUrl(describeQQMusicTarget(token)), undefined);
});
