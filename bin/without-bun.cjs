"use strict";

// Gloom runs on Bun, and `bin/gloom` starts with `#!/usr/bin/env bun`. npm and
// npx install it on machines without Bun too, where that line failed with
// "env: bun: No such file or directory" before any of Gloom ran.
//
// Run as npm's preinstall (before npm links the command, so Windows' shims
// follow it too), this points the command at Node when no Bun is found.
// Under Node, `bin/gloom` then hands over to Bun once one is installed, or
// says in one line how to get it (runWithoutBun). A machine with Bun, and
// every Bun install, keeps the Bun line untouched. Never fails an install.

const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { delimiter, join } = require("node:path");

const BUN_LINE = "#!/usr/bin/env bun";
const NODE_LINE = "#!/usr/bin/env node";

/**
 * A Bun on PATH, or where Bun's installer puts it; null when there is none.
 * On Windows only bun.exe counts, as Node cannot start a .cmd shim without a
 * shell: an npm-installed Bun is found by the bun.exe beside its shims.
 */
function findBun(env = process.env, platform = process.platform) {
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter),
    join(env.BUN_INSTALL || join(homedir(), ".bun"), "bin"),
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidates = platform === "win32"
      ? [join(dir, "bun.exe"), join(dir, "node_modules", "bun", "bin", "bun.exe")]
      : [join(dir, "bun")];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) return found;
  }
  return null;
}

/** The one line a machine without Bun gets, naming both ways out. */
function missingBunMessage(platform = process.platform) {
  return platform === "win32"
    ? "gloom runs on Bun, which is not installed. Install Bun (powershell -c \"irm bun.sh/install.ps1 | iex\") and run gloom again, or install Gloom with: irm https://gloom.sh/install.ps1 | iex"
    : "gloom runs on Bun, which is not installed. Install Bun (curl -fsSL https://bun.sh/install | bash) and run gloom again, or install Gloom with: curl -fsSL https://gloom.sh/install | bash";
}

/**
 * Points `launcher` at Node when npm installs it on a machine with no Bun.
 * True when it changed it. A Bun install, and a source checkout (not under
 * node_modules), keep the Bun line.
 */
function useNodeWithoutBun(launcher, env = process.env, platform = process.platform) {
  if ((env.npm_config_user_agent ?? "").startsWith("bun/")) return false;
  if (!launcher.split(/[\\/]/).includes("node_modules")) return false;
  if (findBun(env, platform)) return false;
  const text = readFileSync(launcher, "utf8");
  if (!text.startsWith(`${BUN_LINE}\n`)) return false;
  writeFileSync(launcher, `${NODE_LINE}\n${text.slice(BUN_LINE.length + 1)}`);
  return true;
}

/**
 * `bin/gloom` under Node: runs `script` with the Bun found now, passing the
 * arguments, stdio and exit status through, or prints missingBunMessage.
 * Resolves to the exit code.
 */
function runWithoutBun(script, args) {
  const bun = findBun();
  if (!bun) {
    process.stderr.write(`${missingBunMessage()}\n`);
    return Promise.resolve(1);
  }
  const { spawn } = require("node:child_process");
  const { constants } = require("node:os");
  return new Promise((resolve) => {
    const child = spawn(bun, [script, ...args], { stdio: "inherit" });
    // The terminal sends Ctrl+C to Bun as well; Node waits for it to finish.
    const ignore = () => {};
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, ignore);
    child.on("error", (error) => {
      process.stderr.write(`gloom: could not start Bun at ${bun}: ${error.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(code ?? 128 + (signal ? constants.signals[signal] ?? 0 : 0));
    });
  });
}

module.exports = { findBun, missingBunMessage, runWithoutBun, useNodeWithoutBun };

if (require.main === module && !process.versions.bun) {
  try {
    useNodeWithoutBun(join(__dirname, "gloom"));
  } catch {
    // Intentional ignore: a launcher that cannot be rewritten keeps the Bun line, as before.
  }
}
