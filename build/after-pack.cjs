const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

module.exports = async function removeMacMetadata(context) {
  if (context.electronPlatformName !== "darwin") return;
  await execFileAsync("/usr/bin/xattr", ["-cr", context.appOutDir]);
};
