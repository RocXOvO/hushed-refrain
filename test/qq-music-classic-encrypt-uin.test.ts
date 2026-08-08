import assert from "node:assert/strict";
import test from "node:test";
import {
  ClassicEncryptUinError,
  decodeClassicEncryptUin,
  encodeClassicEncryptUin,
  maskMusicIdentifier,
  parseClassicEncryptUinExperimentInput,
  type ClassicEncryptUinErrorCode,
} from "../src/qq-music/classic-encrypt-uin";

test("decodes a synthetic classic EncryptUin vector with strict masking", () => {
  assert.deepEqual(decodeClassicEncryptUin("oK-i7e4s7icqoe6A"), {
    format: "classic-qq-short",
    identityKind: "qq-number-candidate",
    encryptUin: "oK-i7e4s7icqoe6A",
    identifier: "123456789012",
    maskedIdentifier: "12****12",
  });
  assert.equal(maskMusicIdentifier("12345", "qq-number-candidate"), "1****5");
});

test("decodes an independent synthetic 28-character WeChat vector as a 19-digit internal ID candidate", () => {
  assert.deepEqual(decodeClassicEncryptUin("oK6koenzoenzoenzoenzoevloc**"), {
    format: "wechat-28",
    identityKind: "wxuin-candidate",
    encryptUin: "oK6koenzoenzoenzoenzoevloc**",
    identifier: "1150000000000000472",
    maskedIdentifier: "115***472",
  });
});

test("round-trips every supported synthetic QQ length through the frozen table", () => {
  for (const qq of [
    "12345",
    "123456",
    "1234567",
    "12345678",
    "123456789",
    "1234567890",
    "12345678901",
    "123456789012",
  ]) {
    const encrypted = encodeClassicEncryptUin(qq);
    assert.equal(decodeClassicEncryptUin(encrypted).identifier, qq);
  }
  const internalId = "1150000000000000472";
  assert.equal(encodeClassicEncryptUin(internalId), "oK6koenzoenzoenzoenzoevloc**");
  assert.equal(decodeClassicEncryptUin(encodeClassicEncryptUin(internalId)).identifier, internalId);
});

test("classifies bare values and three exact official profile URL forms without network access", () => {
  const qqToken = "oK-i7e4s7icqoe6A";
  const wxToken = "oK6koenzoenzoenzoenzoevloc**";
  assert.deepEqual(parseClassicEncryptUinExperimentInput(qqToken), {
    inputKind: "raw-encrypt-uin",
    resolution: "local",
    encryptUin: qqToken,
  });
  assert.deepEqual(parseClassicEncryptUinExperimentInput("123456789012"), {
    inputKind: "numeric-identifier",
    resolution: "network",
    identifier: "123456789012",
    identityKind: "qq-number-candidate",
  });
  assert.deepEqual(
    parseClassicEncryptUinExperimentInput(`https://y.qq.com/n/ryqq/profile/${qqToken}`),
    { inputKind: "profile-url-encrypt-uin", resolution: "local", encryptUin: qqToken },
  );
  assert.deepEqual(
    parseClassicEncryptUinExperimentInput("https://y.qq.com/n/ryqq_v2/profile?uin=oK6koenzoenzoenzoenzoevloc%2A%2A"),
    { inputKind: "profile-url-encrypt-uin", resolution: "local", encryptUin: wxToken },
  );
  assert.deepEqual(
    parseClassicEncryptUinExperimentInput("https://y.qq.com/portal/profile.html?uin=1150000000000000472"),
    {
      inputKind: "profile-url-numeric",
      resolution: "network",
      identifier: "1150000000000000472",
      identityKind: "wxuin-candidate",
    },
  );
});

test("rejects ambiguous, malformed, or non-official profile URLs before any network stage", () => {
  const invalid = [
    "http://y.qq.com/n/ryqq/profile/123456",
    "https://evil.example/n/ryqq/profile/123456",
    "https://y.qq.com.evil.example/n/ryqq/profile/123456",
    "https://user@y.qq.com/n/ryqq/profile/123456",
    "https://y.qq.com:443/n/ryqq/profile/123456",
    "https://y.qq.com:/n/ryqq/profile/123456",
    "https://y.qq.com/n/ryqq/profile/../profile/123456",
    "https://y.qq.com/n/ryqq/profile/%2e%2e/profile/123456",
    "https://y.qq.com/n/ryqq_v2/a/../profile?uin=123456",
    "https://y.qq.com/n/ryqq_v2/%2e%2e/profile?uin=123456",
    "https://y.qq.com/other/profile/123456",
    "https://y.qq.com/n/ryqq/profile/123456?uin=123456",
    "https://y.qq.com/n/ryqq_v2/profile",
    "https://y.qq.com/n/ryqq_v2/profile?uin=",
    "https://y.qq.com/n/ryqq_v2/profile?uin=123456&uin=123456",
    "https://y.qq.com/n/ryqq_v2/profile?uin=123456&uin=654321",
    "https://y.qq.com/n/ryqq_v2/profile?uin=123456&id=123456",
    "https://y.qq.com/n/ryqq_v2/profile?uin=123456&from=share",
    "https://y.qq.com/n/ryqq_v2/profile?uin=123456#profile",
    "https://y.qq.com/n/ryqq_v2/profile?uin=%ZZ",
    "//y.qq.com/n/ryqq/profile/123456",
  ];
  for (const input of invalid) {
    assertClassicError(() => parseClassicEncryptUinExperimentInput(input), "invalid-profile-url");
  }
});

test("rejects unknown characters and unsupported opaque or new-format identifiers", () => {
  assertClassicError(() => decodeClassicEncryptUin("oK-i7e4!"), "unknown-character");
  assertClassicError(() => decodeClassicEncryptUin(`${"n".repeat(27)}!`), "unknown-character");
  assertClassicError(() => decodeClassicEncryptUin("n".repeat(32)), "unsupported-format");
  assertClassicError(() => decodeClassicEncryptUin("opaque-token"), "unknown-character");
});

test("rejects malformed Base64, non-decimal payloads, and unreasonable QQ lengths", () => {
  assertClassicError(() => decodeClassicEncryptUin("****nnnn"), "invalid-base64");
  assertClassicError(() => decodeClassicEncryptUin("nnnnnnnn"), "non-decimal");
  assertClassicError(() => decodeClassicEncryptUin("oK-i7n**"), "invalid-identifier-length");
  assertClassicError(() => decodeClassicEncryptUin("oK-i7e4s7icqoe6Aoivk7wSFNKn5"), "invalid-identifier-length");
  assertClassicError(() => decodeClassicEncryptUin("oe6koenzoenzoenzoenzoevloc**"), "invalid-identifier-length");
  assertClassicError(() => encodeClassicEncryptUin("01234"), "invalid-identifier-length");
  assertClassicError(() => encodeClassicEncryptUin("1234567890123"), "invalid-identifier-length");
  assertClassicError(() => encodeClassicEncryptUin("12a45"), "non-decimal");
});

function assertClassicError(operation: () => unknown, code: ClassicEncryptUinErrorCode): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof ClassicEncryptUinError);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /12345|EncryptUin=|QQ=/);
    return true;
  });
}
