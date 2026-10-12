import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { Jimp } from "jimp";
import { SHOT_VIEW_ARCHIVE } from "../src/cli/desktop-pane-shot-view";
import {
  OPEN_TUI_NATIVE_SMOKE_COMMAND,
  OPEN_TUI_RUNTIME_SMOKE_COMMAND,
  PLUGIN_HOST_SMOKE_COMMAND,
  SHOT_VIEW_SMOKE_COMMAND,
} from "../src/cli/native-smoke";

// Run against the extracted app or installed Windows package, not a source
// entry. All child processes start outside the checkout and use only its CLI.
const [launcherArg, evidenceArg] = process.argv.slice(2);
assert(launcherArg && evidenceArg, "Usage: bun scripts/verify-desktop-cli.ts <desktop launcher> <evidence directory>");
const launcher = await realpath(resolve(launcherArg));
const evidence = resolve(evidenceArg);
const resources = process.platform === "darwin" ? dirname(launcher) : resolve(dirname(launcher), "../Resources");
assert(await Bun.file(join(resources, "gloomberb-tui", SHOT_VIEW_ARCHIVE)).exists(), "Desktop pane archive is missing");
const cache = join(homedir(), ".cache/gloom-smoke/glo-645");
await mkdir(cache, { recursive: true });
await mkdir(evidence, { recursive: true });
// Chrome puts a Unix socket below TMPDIR; keep the path within its byte limit.
const work = await mkdtemp(join(cache, "v-"));
const caller = join(work, "caller with spaces");
const profile = join(work, "profile");
const temp = join(work, "t");
for (const dir of [caller, profile, temp]) await mkdir(dir);
await Bun.write(join(profile, "config.json"), JSON.stringify({ telemetry: { crashReports: false } }));
const env = {
  ...process.env,
  GLOOMBERB_HOME: profile,
  GLOOMBERB_API_URL: "http://127.0.0.1:9",
  TMPDIR: temp, TMP: temp, TEMP: temp,
  NO_COLOR: "1",
};
let command = launcher;

async function run(name: string, args: string[], expectedCode = 0): Promise<string> {
  // cmd /s strips the enclosing pair of quotes, leaving the quoted executable
  // and each argument intact. Do not let Bun add another layer of quoting.
  const windows = process.platform === "win32";
  const cmd = windows
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `""${command}" ${args.map((arg) => `"${arg}"`).join(" ")}"`]
    : [command, ...args];
  const child = Bun.spawn(cmd, {
    cwd: caller, env, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    ...(windows ? { windowsVerbatimArguments: true } : {}),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  await Bun.write(join(evidence, `${name}.stdout`), stdout);
  await Bun.write(join(evidence, `${name}.stderr`), stderr);
  assert.equal(code, expectedCode, `${name} exited ${code}: ${stderr}`);
  console.log(`${name}: exit ${code}`);
  return stdout;
}

try {
  // Homebrew links to Resources/gloomberb. Exercise both an absolute symlink
  // and a relative hop, including spaces, rather than only invoking the file.
  if (process.platform !== "win32") {
    const links = join(work, "linked bin");
    await mkdir(links);
    await symlink(launcher, join(links, "desktop cli"));
    command = join(links, "gloomberb");
    await symlink("desktop cli", command);
  }
  for (const [name, arg] of [
    ["native", OPEN_TUI_NATIVE_SMOKE_COMMAND],
    ["runtime", OPEN_TUI_RUNTIME_SMOKE_COMMAND],
    ["plugin-host", PLUGIN_HOST_SMOKE_COMMAND],
    ["archive", SHOT_VIEW_SMOKE_COMMAND],
    ["help", "help"],
  ] as const) await run(name, [arg]);
  await run("invalid-command", ["not-a-gloom-command"], 1);

  const output = "docs shot.png";
  const shot = JSON.parse(await run("shot-docs", ["shot", "DOCS", "--output", output, "--json"]));
  assert.equal(shot.ok, true);
  assert.equal(await realpath(shot.data.outputPath), await realpath(join(caller, output)), "Relative --output escaped the caller directory");
  assert.equal(shot.data.render.loadingStateDetected, false);
  assert.equal(shot.data.render.errorStateDetected, false);
  assert.match(shot.data.render.visibleText, /Install Gloomberb/);
  const png = join(evidence, output);
  await copyFile(join(caller, output), png);
  const { bitmap } = await Jimp.read(png);
  assert(bitmap.width >= 640 && bitmap.height >= 360, "PNG is too small");
  const colors = new Set<number>();
  for (let i = 0; i < bitmap.data.length; i += 4) colors.add(bitmap.data.readUInt32BE(i));
  assert(colors.size > 32, "PNG is blank or has no readable content");

  for (const target of ["DOCS", "DIAG"]) {
    const report = JSON.parse(await run(`fn-${target.toLowerCase()}`, ["fn", target, "--json"]));
    assert.equal(report.ok, true);
    assert.equal(report.data.kind, "rendered-view");
    assert.equal(report.data.source, "dom");
    assert.equal(report.data.target, target);
    if (target === "DOCS") {
      assert.equal(report.data.empty, false);
      assert(report.data.rowCount > 0);
      assert.equal(report.data.reason, undefined);
      assert.match(report.data.visibleText, /Install Gloomberb/);
    } else {
      // No ticker is intentional: DIAG's rendered empty state needs no quote,
      // filings or account. It still exercises the real browser and archive.
      assert.equal(report.data.empty, true);
      assert.equal(report.data.reason, "The rendered pane reported an empty state.");
      assert.match(report.data.visibleText, /Equity Diagnostic.*Select a ticker/);
    }
  }
  await Bun.write(join(evidence, "verification.json"), JSON.stringify({
    platform: process.platform, arch: process.arch, launcher, command, caller,
    archive: join(resources, "gloomberb-tui", SHOT_VIEW_ARCHIVE),
    relativeOutput: relative(caller, shot.data.outputPath),
    png: { width: bitmap.width, height: bitmap.height, colors: colors.size },
    reports: { DOCS: "rendered rows", DIAG: "rendered no-ticker empty state" },
    head: process.env.GITHUB_SHA ?? null,
  }, null, 2));
  console.log(`Desktop CLI verification passed. Evidence: ${evidence}`);
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
