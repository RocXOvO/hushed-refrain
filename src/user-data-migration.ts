import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LEGACY_USER_DATA_DIRECTORY = "ncm-comment-finder";
export const BRANDED_USER_DATA_DIRECTORY = "hushed-refrain";

interface UserDataMigrationFileSystem {
  exists(path: string): boolean;
  mkdir(path: string): void;
  rename(from: string, to: string): void;
}

const realFileSystem: UserDataMigrationFileSystem = {
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rename: renameSync,
};

export interface UserDataDirectoryResolution {
  path: string;
  migrated: boolean;
  usingLegacyPath: boolean;
  migrationError?: unknown;
}

export function resolveBrandedUserDataDirectory(
  appDataPath: string,
  fileSystem: UserDataMigrationFileSystem = realFileSystem,
): UserDataDirectoryResolution {
  const legacyPath = join(appDataPath, LEGACY_USER_DATA_DIRECTORY);
  const brandedPath = join(appDataPath, BRANDED_USER_DATA_DIRECTORY);
  if (fileSystem.exists(brandedPath)) {
    return { path: brandedPath, migrated: false, usingLegacyPath: false };
  }
  if (!fileSystem.exists(legacyPath)) {
    fileSystem.mkdir(brandedPath);
    return { path: brandedPath, migrated: false, usingLegacyPath: false };
  }
  try {
    fileSystem.rename(legacyPath, brandedPath);
    return { path: brandedPath, migrated: true, usingLegacyPath: false };
  } catch (migrationError) {
    // A second first-launch process may have won the same atomic rename before
    // Electron's branded single-instance lock exists. In that case converge
    // on its completed destination instead of returning a path that vanished.
    if (fileSystem.exists(brandedPath) && !fileSystem.exists(legacyPath)) {
      return { path: brandedPath, migrated: false, usingLegacyPath: false };
    }
    // A running legacy build can keep Chromium files open on Windows. Keep
    // using the complete legacy directory for this launch and retry the same
    // atomic rename next time instead of risking a partial recursive copy.
    return { path: legacyPath, migrated: false, usingLegacyPath: true, migrationError };
  }
}
