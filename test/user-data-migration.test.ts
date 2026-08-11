import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BRANDED_USER_DATA_DIRECTORY,
  LEGACY_USER_DATA_DIRECTORY,
  resolveBrandedUserDataDirectory,
} from "../src/user-data-migration";

test("creates the branded user-data directory for a fresh installation", () => {
  const root = mkdtempSync(join(tmpdir(), "hushed-refrain-user-data-"));
  try {
    const resolution = resolveBrandedUserDataDirectory(root);
    assert.equal(resolution.path, join(root, BRANDED_USER_DATA_DIRECTORY));
    assert.equal(resolution.migrated, false);
    assert.equal(resolution.usingLegacyPath, false);
    assert.equal(existsSync(resolution.path), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomically renames the complete legacy directory", () => {
  const root = mkdtempSync(join(tmpdir(), "hushed-refrain-user-data-"));
  const legacy = join(root, LEGACY_USER_DATA_DIRECTORY);
  mkdirSync(legacy);
  writeFileSync(join(legacy, "desktop-settings.json"), "saved", "utf8");
  try {
    const resolution = resolveBrandedUserDataDirectory(root);
    assert.equal(resolution.path, join(root, BRANDED_USER_DATA_DIRECTORY));
    assert.equal(resolution.migrated, true);
    assert.equal(existsSync(legacy), false);
    assert.equal(readFileSync(join(resolution.path, "desktop-settings.json"), "utf8"), "saved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a complete legacy directory when the atomic rename is temporarily unavailable", () => {
  const root = "/app-data";
  const legacy = join(root, LEGACY_USER_DATA_DIRECTORY);
  const branded = join(root, BRANDED_USER_DATA_DIRECTORY);
  const failure = new Error("directory is in use");
  const resolution = resolveBrandedUserDataDirectory(root, {
    exists: (path) => path === legacy,
    mkdir: () => assert.fail("must not create a partial branded directory"),
    rename: (from, to) => {
      assert.equal(from, legacy);
      assert.equal(to, branded);
      throw failure;
    },
  });
  assert.equal(resolution.path, legacy);
  assert.equal(resolution.migrated, false);
  assert.equal(resolution.usingLegacyPath, true);
  assert.equal(resolution.migrationError, failure);
});

test("converges on a branded directory when another first launch wins the rename", () => {
  const root = "/app-data";
  const legacy = join(root, LEGACY_USER_DATA_DIRECTORY);
  const branded = join(root, BRANDED_USER_DATA_DIRECTORY);
  let renameAttempted = false;
  const resolution = resolveBrandedUserDataDirectory(root, {
    exists: (path) => {
      if (path === legacy) return !renameAttempted;
      if (path === branded) return renameAttempted;
      return false;
    },
    mkdir: () => assert.fail("must not create during migration"),
    rename: () => {
      renameAttempted = true;
      throw new Error("source was already renamed");
    },
  });
  assert.deepEqual(resolution, { path: branded, migrated: false, usingLegacyPath: false });
});

test("never overwrites an existing branded directory", () => {
  const root = "/app-data";
  const branded = join(root, BRANDED_USER_DATA_DIRECTORY);
  const resolution = resolveBrandedUserDataDirectory(root, {
    exists: (path) => path === branded,
    mkdir: () => assert.fail("must keep the existing branded authority"),
    rename: () => assert.fail("must not merge two authorities"),
  });
  assert.deepEqual(resolution, { path: branded, migrated: false, usingLegacyPath: false });
});
