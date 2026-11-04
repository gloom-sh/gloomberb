/**
 *   bun scripts/desktop-measure/update-in-place.ts --app <installed app> --release <artifacts> --out <dir>
 *
 * An installed desktop app (macOS or Linux) updated in the app the way a user
 * updates it, from a copy of the release served on this machine:
 *
 * 1. The installed build (an earlier release, built with Electrobun 1) finds
 *    the release in --release (this build's artifacts), downloads it, and
 *    the command bar's "Update ready, restart to apply" restarts it into
 *    this build, in the same place.
 * 2. This build updates the same way to a newer one (the same build under
 *    another hash and the next patch version, with a file of its own), with
 *    Electrobun 2's own update manager.
 *
 * `--app` is the installed app: `/Applications/Gloom.app` on macOS, the
 * `app` folder under `~/.local/share/<identifier>/<channel>` on Linux, where
 * Electrobun's updater keeps it. It seeds the config in ~/.gloomberb and
 * changes the installed app, so it runs only on a CI machine. The command bar
 * is driven through the app's remote control.
 * Writes what it saw, step by step, to <out>/update-in-place.json.
 */
import { existsSync, readdirSync, readlinkSync } from "fs";
import { cp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const appPath = option("--app");
const releaseDir = option("--release");
const outDir = resolve(option("--out") ?? "update-in-place");
if (!appPath || !releaseDir) throw new Error("Usage: update-in-place.ts --app <installed app> --release <artifacts> --out <dir>");
if (process.env.GITHUB_ACTIONS !== "true") {
  console.error("Skipping the in-app update of an installed app outside CI.");
  process.exit(0);
}

const mac = process.platform === "darwin";
const platform = mac ? "macos" : "linux";
const arch = process.arch === "arm64" ? "arm64" : "x64";
const prefix = `stable-${platform}-${arch}`;
const resources = mac ? join(appPath, "Contents", "Resources") : join(appPath, "Resources");
const launcher = mac ? join(appPath, "Contents", "MacOS", "launcher") : join(appPath, "bin", "launcher");
const identifier = "com.vincelwt.gloomberb";
const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const channelRoot = mac
  ? join(homedir(), "Library", "Application Support", identifier, "stable")
  : join(dataHome, identifier, "stable");
const work = join(homedir(), ".cache", "gloom-smoke", "update-in-place");
const served = join(work, "release");
const configHome = join(homedir(), ".gloomberb");
const updateHash = "verifyupdate2";

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const steps: Array<Record<string, unknown>> = [];
function log(message: string): void {
  console.error(`[update ${new Date().toISOString().slice(11, 23)}] ${message}`);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

interface Build { version?: string; hash?: string; electrobun?: string | null }

async function installedBuild(): Promise<Build> {
  const version = await readJson<{ version?: string; hash?: string }>(join(resources, "version.json"));
  const build = await readJson<{ electrobunVersion?: string }>(join(resources, "build.json"));
  return { version: version?.version, hash: version?.hash, electrobun: build?.electrobunVersion ?? null };
}

/** A release this build updates to: another hash and version than its own. */
interface NewerBuild { hash: string; version: string }

async function setUpdateSource(versionJson: string, baseUrl: string, newer?: NewerBuild): Promise<void> {
  const info = await readJson<Record<string, unknown>>(versionJson);
  if (!info) throw new Error(`No version.json at ${versionJson}`);
  await writeFile(versionJson, JSON.stringify({ ...info, baseUrl, ...newer }));
}

/** The next patch release after `version`: the stable channel only takes a newer release. */
function newerVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`This build's version, "${version}", is not major.minor.patch`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function run(command: string[], cwd?: string): string {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`${command.join(" ")}: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** The app's processes: whatever runs from inside it. */
function appProcesses(): Array<{ pid: number; path: string }> {
  const root = `${resolve(appPath!)}/`;
  if (!mac) {
    return readdirSync("/proc").flatMap((entry) => {
      if (!/^\d+$/.test(entry)) return [];
      try {
        const path = readlinkSync(join("/proc", entry, "exe"));
        return path.startsWith(root) ? [{ pid: Number(entry), path }] : [];
      } catch {
        return [];
      }
    });
  }
  return run(["ps", "-axo", "pid=,comm="]).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) return [];
    const path = match[2]!.trim();
    return path.startsWith(root) ? [{ pid: Number(match[1]), path }] : [];
  });
}

async function waitUntil(seconds: number, condition: () => boolean | Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await sleep(1000);
  }
  return Boolean(await condition());
}

async function stopApp(): Promise<void> {
  for (const { pid } of appProcesses()) {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
  await waitUntil(20, () => appProcesses().length === 0);
}

function openApp(label: string): void {
  Bun.spawn([launcher], {
    cwd: resolve(launcher, ".."),
    env: { ...process.env, ELECTROBUN_CONSOLE: "1", GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1" },
    stdout: Bun.file(join(outDir, `${label}.out.txt`)),
    stderr: Bun.file(join(outDir, `${label}.err.txt`)),
  }).unref();
}

/** A request to the app's remote control, which writes where it listens into its data folder. */
async function remoteControl(request: Record<string, unknown>): Promise<{ ok?: boolean; error?: { message?: string } } | null> {
  const endpoint = await readJson<{ port: number; token: string }>(join(work, "data", "remote-control.desktop.json"));
  if (!endpoint) return null;
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
    method: "POST",
    headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return await response.json() as { ok?: boolean; error?: { message?: string } };
}

/**
 * Restarts the app into the downloaded update as a person does from the
 * command bar: "update" finds Check for Updates, which reads "Update ready,
 * restart to apply" once the download is in, and Enter restarts. Through the
 * app's remote control rather than keys: a runner's macOS takes no synthetic
 * keys without an accessibility grant.
 */
async function askForRestart(): Promise<void> {
  try {
    const opened = await remoteControl({ type: "call", operation: "app.openCommandBar", input: { query: "update" } });
    if (!opened) {
      log("restart: no remote control yet");
      return;
    }
    const activated = await remoteControl({ type: "call", operation: "commandBar.activateResult", input: { label: "Update ready, restart to apply" } });
    log(`restart: ${activated?.ok ? "asked" : `not yet (${activated?.error?.message ?? opened.error?.message ?? "no answer"})`}`);
  } catch (error) {
    // The app quitting for the restart cuts the request off.
    log(`restart: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Waits for the download of `hash`, then asks for the restart until the app that ran quits for it. */
async function restartIntoUpdate(hash: string, label: string): Promise<void> {
  const downloaded = join(channelRoot, "self-extraction", `${hash}.tar`);
  if (!await waitUntil(300, () => existsSync(downloaded))) {
    throw new Error(`${label}: the app did not download the update into ${downloaded}`);
  }
  const before = appProcesses().map(({ pid }) => pid);
  if (before.length === 0) throw new Error(`${label}: the app is not running before U`);
  const alive = () => before.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (let attempt = 0; attempt < 30 && alive().length === before.length; attempt += 1) {
    await askForRestart();
    await waitUntil(5, () => alive().length < before.length);
  }
  if (alive().length === before.length) throw new Error(`${label}: the app did not restart into the downloaded update`);
  log(`${label}: the app quits for the restart`);
}

async function writeRelease(hash?: string): Promise<string> {
  await rm(served, { recursive: true, force: true });
  await mkdir(served, { recursive: true });
  const manifest = await readJson<Record<string, unknown> & { hash: string; version: string; artifact?: { file?: string } }>(join(releaseDir!, `${prefix}-update.json`));
  if (!manifest) throw new Error(`No ${prefix}-update.json in ${releaseDir}`);
  // Electrobun 2 installs it only when the archive's version.json names the manifest's version and hash.
  const newer = hash ? { hash, version: newerVersion(manifest.version) } : undefined;
  const archive = manifest.artifact?.file ?? `${prefix}-Gloom${mac ? ".app" : ""}.tar.zst`;
  const unpacked = join(work, "release-build");
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  await writeFile(join(work, "release.tar"), Bun.zstdDecompressSync(await Bun.file(join(releaseDir!, archive)).bytes()));
  run(["tar", "-xf", join(work, "release.tar"), "-C", unpacked]);
  const top = readdirSync(unpacked);
  if (top.length !== 1) throw new Error(`${archive} should hold one folder; it holds ${top.join(", ")}`);
  const buildResources = mac ? join(unpacked, top[0]!, "Contents", "Resources") : join(unpacked, top[0]!, "Resources");
  await setUpdateSource(join(buildResources, "version.json"), baseUrl, newer);
  if (hash) await writeFile(join(buildResources, "verify-added-by-update.txt"), "added by the update\n");
  run(["tar", "-cf", join(work, "release.tar"), "-C", unpacked, top[0]!], undefined);
  await writeFile(join(served, archive), Bun.zstdCompressSync(await Bun.file(join(work, "release.tar")).bytes(), { level: 3 }));
  await writeFile(join(served, `${prefix}-update.json`), JSON.stringify({ ...manifest, ...newer }));
  // The earlier release's patch to this build, as the release carries it.
  if (!hash) {
    for (const name of readdirSync(releaseDir!)) {
      if (name.startsWith(`${prefix}-`) && name.endsWith(".patch")) await cp(join(releaseDir!, name), join(served, name));
    }
  }
  return hash ?? manifest.hash;
}

const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const file = Bun.file(join(served, name));
    const found = !name.includes("/") && !name.includes("..") && await file.exists();
    requests.push(`${new Date().toISOString()} ${request.method} /${name} ${found ? 200 : 404}`);
    return found ? new Response(file) : new Response("", { status: 404 });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}`;

async function seedConfig(): Promise<void> {
  if (existsSync(configHome)) throw new Error(`Refusing to overwrite the config in ${configHome}`);
  const dataDir = join(work, "data");
  await mkdir(dataDir, { recursive: true });
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, "config.json"), JSON.stringify({ dataDir }));
  const { EXTRACTED_PLUGINS } = await import("../../src/plugins/extracted-plugins");
  await writeFile(join(dataDir, "config.json"), JSON.stringify({
    dataDir,
    onboardingComplete: true,
    // Plugin restoration has its own tests and must not add network installs here.
    seededPlugins: EXTRACTED_PLUGINS.map((plugin) => plugin.id),
    telemetry: { crashReports: false, usage: false },
  }));
}

async function step(label: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const state = {
    label,
    build: await installedBuild(),
    running: appProcesses().map(({ path }) => path),
    installRecords: existsSync(join(channelRoot, ".electrobun-uninstall.json")) && existsSync(join(channelRoot, "uninstall")),
    ...extra,
  };
  steps.push(state);
  log(`${label}: ${JSON.stringify(state)}`);
  return state;
}

let failure: string | null = null;
try {
  await mkdir(outDir, { recursive: true });
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  await seedConfig();
  const earlier = await step("earlier");

  // 1. The earlier release updates to this build.
  const bridgeHash = await writeRelease();
  if ((earlier.build as Build).hash === bridgeHash) throw new Error("The earlier release is this build");
  await setUpdateSource(join(resources, "version.json"), baseUrl);
  openApp("earlier");
  if (!await waitUntil(120, () => appProcesses().length > 0)) throw new Error("The earlier release did not start");
  await restartIntoUpdate(bridgeHash, "bridge");
  const bridged = await waitUntil(240, async () => appProcesses().length > 0 && (await installedBuild()).hash === bridgeHash);
  const afterBridge = await step("bridged");
  if (!bridged) throw new Error(`The earlier release's update should open this build (${bridgeHash}) from ${appPath}`);
  if (!(afterBridge.build as Build).electrobun?.startsWith("2.")) throw new Error(`This build reports Electrobun ${(afterBridge.build as Build).electrobun}`);
  if (!await waitUntil(60, () => existsSync(join(channelRoot, ".electrobun-uninstall.json")))) {
    throw new Error(`This build's first start wrote no install records in ${channelRoot}`);
  }

  // 2. This build updates to a newer one in place, with Electrobun 2's own update manager.
  await stopApp();
  await writeRelease(updateHash);
  openApp("update-start");
  if (!await waitUntil(120, () => appProcesses().length > 0)) throw new Error("This build did not start");
  await restartIntoUpdate(updateHash, "update");
  const updated = await waitUntil(240, async () => appProcesses().length > 0
    && (await installedBuild()).hash === updateHash
    && existsSync(join(resources, "verify-added-by-update.txt")));
  await step("updated");
  if (!updated) throw new Error(`The update should open the newer build (${updateHash}) from ${appPath}`);
  log("updated in place twice");
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  await step("failed", { error: failure }).catch(() => {});
} finally {
  await stopApp().catch(() => {});
  server.stop(true);
  await writeFile(join(outDir, "requests.log"), `${requests.join("\n")}\n`);
  await writeFile(join(outDir, "update-in-place.json"), `${JSON.stringify({ platform, arch, steps, failure }, null, 2)}\n`);
  await rm(configHome, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
