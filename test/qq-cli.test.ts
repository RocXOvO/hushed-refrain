import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("QQ CLI advertises the live page size 25 maximum for new tasks", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/qq-cli.ts", "--help"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /new task default: 25 \(current API maximum\)/);
  assert.match(result.stdout, /legacy resume values above 25 migrate to 25/);
  assert.match(result.stdout, /liked-page-size N\s+new task default: 500 \(API maximum\)/);
  assert.match(result.stdout, /max-workers N\s+default: 8; hard cap 1\.\.32/);
  assert.match(result.stdout, /request-budget N\s+default: 250; task-wide logical comment pages/);
  assert.match(result.stdout, /data\/qq\/state-<stable-task-key>\.json/);
  assert.doesNotMatch(result.stdout, /data\/qq-state-/);
});

test("QQ CLI rejects an explicit comment page size 26 before scanning", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "src/qq-cli.ts", "scan-song",
      "--user", "opaque-user", "--song-id", "7", "--comment-page-size", "26", "--fresh",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /comment-page-size.*between 1 and 25/);
});
