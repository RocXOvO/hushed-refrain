const { spawn } = require("node:child_process");
const { copyFile, mkdir, mkdtemp, readdir, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const projectRoot = resolve(__dirname, "..");
const releaseDirectory = join(projectRoot, "release");
const requestedArchitectures = process.argv.slice(2);
const architectures = requestedArchitectures.length > 0
  ? requestedArchitectures
  : [process.arch === "x64" ? "x64" : "arm64"];

for (const architecture of architectures) {
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error(`Unsupported macOS architecture: ${architecture}`);
  }
}

async function run() {
  const temporaryOutput = await mkdtemp(join(tmpdir(), "ncm-comment-finder-build-"));
  try {
    const executable = join(projectRoot, "node_modules", ".bin", "electron-builder");
    const builderArgs = [
      "--mac",
      "dmg",
      ...architectures.map((architecture) => `--${architecture}`),
      `-c.directories.output=${temporaryOutput}`,
    ];
    await runProcess(executable, builderArgs);

    await mkdir(releaseDirectory, { recursive: true });
    const artifacts = (await readdir(temporaryOutput))
      .filter((name) => name.endsWith(".dmg") || name.endsWith(".dmg.blockmap"));
    if (artifacts.length === 0) throw new Error("electron-builder produced no DMG artifacts.");
    for (const artifact of artifacts) {
      await copyFile(join(temporaryOutput, artifact), join(releaseDirectory, artifact));
      process.stdout.write(`macOS artifact: ${join(releaseDirectory, artifact)}\n`);
    }
  } finally {
    await rm(temporaryOutput, { recursive: true, force: true });
  }
}

function runProcess(executable, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd: projectRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`electron-builder failed (${signal ?? code}).`));
    });
  });
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
