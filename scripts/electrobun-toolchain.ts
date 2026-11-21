/**
 * Electrobun's toolchain from archives pinned by sha256, for CI.
 *
 * `bun scripts/electrobun-toolchain.ts sync` (in `bun run desktop:sync:pinned`)
 * does what `electrobun sync` does, but runs nothing whose bytes do not match
 * scripts/electrobun-toolchain.json:
 *
 * - Hutch, the tool `electrobun` hands every command to, is downloaded and
 *   checked here, installed with the electrobun package's own installer, and
 *   named in ELECTROBUN_HUTCH_BINARY. The package then neither downloads it
 *   nor falls back to Hutch's install script.
 * - The Bun toolchain Hutch builds with, which it would download itself, is
 *   checked here and unpacked where Hutch keeps it.
 * - Hutch's two download bases (Electrobun's GitHub release and its artifact
 *   host) point at a server on 127.0.0.1 run here. It fetches each file it is
 *   asked for, checks it against its pin before handing it over, and answers
 *   a file with no pin with an error. The indexes Hutch reads name upstream
 *   URLs, which it would not follow from that server: they are rewritten to it.
 * - Anything else Hutch tries to download goes to a proxy that refuses it.
 * - Afterwards every archive Hutch records for the project must be pinned.
 *
 * In CI (GITHUB_ENV), the later steps of the job get ELECTROBUN_HUTCH_BINARY
 * and DASH_RELEASE_OFFLINE=1: the build runs the checked Hutch, finds
 * everything already in place, and can download nothing. It still fetches the
 * previous release of this app, for the macOS update patch.
 *
 * Exits 2 when a file does not match its pin or Hutch asks for one that has
 * none, where trying again cannot help, and 1 on any other failure.
 *
 * After `bun install` brings a new Electrobun, `bun scripts/electrobun-toolchain.ts pin`
 * writes the pins for it: the archives Electrobun's release indexes name,
 * each checked against the digest GitHub gives the asset; Cottontail's as its
 * manifest names them; Bun's as its SHASUMS256.txt and GitHub both name them.
 * The versions of Bun and Cottontail are the ones the new Electrobun asks for.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { gunzipSync, inflateRawSync } from "node:zlib";

const ROOT = resolve(import.meta.dir, "..");
const PINS_FILE = join(ROOT, "scripts", "electrobun-toolchain.json");
const ELECTROBUN_BIN = join(ROOT, "node_modules", "electrobun", "bin");

export const UPSTREAM = {
  releases: "https://github.com/blackboardsh/electrobun/releases/download",
  artifacts: "https://electrobun-artifacts.blackboard.sh",
} as const;
const BUN_RELEASES = "https://github.com/oven-sh/bun/releases/download";

/** The machines CI syncs on, as Hutch names them, and the name of Bun's build for each. */
const CI_PLATFORMS: Record<string, string> = {
  "macos-arm64": "bun-darwin-aarch64",
  "linux-x64": "bun-linux-x64",
  "windows-x64": "bun-windows-x64",
  "windows-arm64": "bun-windows-aarch64",
};

export interface Pin {
  url: string;
  sha256: string;
  size: number;
}

interface PlatformPins {
  hutch: Pin;
  bun: Pin;
  cottontail: Pin;
  core: Pin;
  cef: Pin;
}

interface Pins {
  electrobun: string;
  hutch: string;
  cottontail: string;
  bun: string;
  indexes: Pin[];
  platforms: Record<string, PlatformPins>;
}

/** What the electrobun package's resolve-hutch.cjs exports and this uses. */
interface HutchResolver {
  ELECTROBUN_VERSION: string;
  PAIRED_HUTCH_VERSION: string;
  CACHE_MANIFEST_FILENAME: string;
  hutchPlatformKey(platform: string, arch: string): string | null;
  downloadedHutchRoot(environment: NodeJS.ProcessEnv, platform: string, userHome: string, platformKey: string): string;
  validateCachedHutch(root: string, platformKey: string, platform: string, version: string, requireManifest: boolean, hostPlatform: string): string | null;
  installDownloadedArchive(options: { archive: Buffer; environment: NodeJS.ProcessEnv; platform: string; platformKey: string; root: string }): string;
}

/** A download that does not match its pin, or one with no pin: final, unlike a failed download. */
class PinError extends Error {}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkPin(pin: Pin, bytes: Uint8Array): void {
  const digest = sha256(bytes);
  if (digest === pin.sha256 && bytes.length === pin.size) return;
  throw new PinError([
    `${pin.url} does not match its pin in scripts/electrobun-toolchain.json`,
    `  pinned:   sha256 ${pin.sha256}, ${pin.size} bytes`,
    `  received: sha256 ${digest}, ${bytes.length} bytes`,
  ].join("\n"));
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  let failure: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      failure = error;
      if (attempt < 3) await Bun.sleep(attempt * 5_000);
    }
  }
  throw new Error(`could not download ${url}: ${failure instanceof Error ? failure.message : String(failure)}`);
}

async function downloadPinned(pin: Pin): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await download(pin.url);
  checkPin(pin, bytes);
  return bytes;
}

interface Mirror {
  origin: string;
  /** Requests refused because a file did not match its pin or had none. */
  refused: string[];
  /** Requests that failed for any other reason. */
  failed: string[];
  stop(): void;
}

/**
 * Serves `pins` on 127.0.0.1 under /releases and /artifacts, the two bases
 * Hutch downloads from, each file only once it matches its pin. JSON files
 * are indexes: their upstream URLs point back here.
 */
export function startMirror(pins: Pin[], fetchUpstream: (url: string) => Promise<Uint8Array<ArrayBuffer>> = download): Mirror {
  const byUrl = new Map(pins.map((pin) => [pin.url, pin]));
  const refused: string[] = [];
  const failed: string[] = [];
  let origin = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const [, route = "", ...rest] = pathname.split("/");
      const base = Object.hasOwn(UPSTREAM, route) ? UPSTREAM[route as keyof typeof UPSTREAM] : null;
      const url = base ? `${base}/${rest.join("/")}` : pathname;
      const pin = byUrl.get(url);
      if (!pin) {
        refused.push(`Hutch asked for ${url}, which has no pin in scripts/electrobun-toolchain.json`);
        return new Response(`no pin for ${url}\n`, { status: 404 });
      }
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await fetchUpstream(url);
        checkPin(pin, bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        (error instanceof PinError ? refused : failed).push(message);
        return new Response(`${message}\n`, { status: 502 });
      }
      if (!url.endsWith(".json")) return new Response(bytes);
      const index = new TextDecoder().decode(bytes)
        .replaceAll(UPSTREAM.releases, `${origin}/releases`)
        .replaceAll(UPSTREAM.artifacts, `${origin}/artifacts`);
      return new Response(index, { headers: { "content-type": "application/json" } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  return { origin, refused, failed, stop: () => void server.stop(true) };
}

/** An HTTPS proxy that refuses every connection and notes where each was going. */
function startRefusingProxy(): { url: string; attempts: string[]; stop(): void } {
  const attempts: string[] = [];
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        attempts.push(new TextDecoder().decode(data).split("\r\n")[0] ?? "");
        socket.end();
      },
    },
  });
  return { url: `http://127.0.0.1:${listener.port}`, attempts, stop: () => listener.stop(true) };
}

/** One file's bytes from a zip archive. */
function zipMember(zip: Uint8Array, name: string): Uint8Array {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("not a zip archive");
  const count = view.getUint16(end + 10, true);
  let entry = view.getUint32(end + 16, true);
  for (let index = 0; index < count; index += 1) {
    const method = view.getUint16(entry + 10, true);
    const compressedSize = view.getUint32(entry + 20, true);
    const size = view.getUint32(entry + 24, true);
    const nameLength = view.getUint16(entry + 28, true);
    const skip = nameLength + view.getUint16(entry + 30, true) + view.getUint16(entry + 32, true);
    const local = view.getUint32(entry + 42, true);
    if (new TextDecoder().decode(zip.subarray(entry + 46, entry + 46 + nameLength)) === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = zip.subarray(start, start + compressedSize);
      const bytes = method === 0 ? data : method === 8 ? new Uint8Array(inflateRawSync(data)) : null;
      if (!bytes || bytes.length !== size) throw new Error(`could not unpack ${name}`);
      return bytes;
    }
    entry += 46 + skip;
  }
  throw new Error(`${name} is not in the archive`);
}

/** One file's bytes from a .tar.gz archive. */
function tarMember(archive: Uint8Array, name: string): Uint8Array {
  const tar = gunzipSync(archive);
  const text = (start: number, length: number) => tar.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  for (let offset = 0; offset + 512 <= tar.length && tar[offset] !== 0;) {
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    if (text(offset, 100).replace(/^\.\//, "") === name) return new Uint8Array(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} is not in the archive`);
}

function readPins(electrobun: string, hutch: string): Pins {
  const pins = JSON.parse(readFileSync(PINS_FILE, "utf8")) as Pins;
  if (pins.electrobun !== electrobun || pins.hutch !== hutch) {
    throw new PinError(
      `scripts/electrobun-toolchain.json pins Electrobun ${pins.electrobun} with Hutch ${pins.hutch}, but electrobun ${electrobun} pairs with Hutch ${hutch}: `
      + "run `bun scripts/electrobun-toolchain.ts pin`",
    );
  }
  return pins;
}

function hutchHome(): string {
  return process.env.HUTCH_HOME || process.env.DASH_HOME || join(homedir(), ".hutch");
}

/** Installs the pinned Hutch where the electrobun package keeps it, unless it is there already. */
async function installHutch(resolver: HutchResolver, pin: Pin, platformKey: string): Promise<string> {
  const root = resolver.downloadedHutchRoot(process.env, process.platform, homedir(), platformKey);
  const cached = () => resolver.validateCachedHutch(root, platformKey, process.platform, resolver.PAIRED_HUTCH_VERSION, true, process.platform);
  let binary = cached();
  if (!binary) {
    const archive = await downloadPinned(pin);
    binary = resolver.installDownloadedArchive({ archive: Buffer.from(archive), environment: process.env, platform: process.platform, platformKey, root });
  }
  const manifest = JSON.parse(readFileSync(join(root, resolver.CACHE_MANIFEST_FILENAME), "utf8")) as { archiveSha256?: string };
  if (manifest.archiveSha256 !== pin.sha256 || cached() !== binary) {
    throw new PinError(`the Hutch in ${root} was not installed from the pinned archive: remove that folder and run this again`);
  }
  return binary;
}

/** Unpacks the pinned Bun where Hutch keeps its toolchains, unless it is there already. */
async function installBun(pins: Pins, platformKey: string): Promise<{ binary: string; bytes: Uint8Array }> {
  const name = process.platform === "win32" ? "bun.exe" : "bun";
  const bytes = zipMember(await downloadPinned(pins.platforms[platformKey]!.bun), `${CI_PLATFORMS[platformKey]}/${name}`);
  const folder = join(hutchHome(), "toolchains", "bun", pins.bun, platformKey);
  const binary = join(folder, name);
  const marker = join(folder, ".hutch-toolchain");
  const installed = existsSync(binary) && existsSync(marker)
    && readFileSync(marker, "utf8") === pins.bun && Buffer.from(bytes).equals(readFileSync(binary));
  if (!installed) {
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    writeFileSync(binary, bytes, { mode: 0o755 });
    writeFileSync(marker, pins.bun);
  }
  return { binary, bytes };
}

interface DependencyRecord {
  objects: Array<Record<string, string>>;
}

/** What Hutch recorded installing for the project, where it is not what was pinned. */
function unpinnedDependencies(pins: Pins, platformKey: string): string[] {
  const platform = pins.platforms[platformKey]!;
  const pinned = new Set([platform.cottontail.sha256, platform.core.sha256, platform.cef.sha256]);
  const bunRoot = `toolchains/bun/${pins.bun}/${platformKey}`;
  const record = JSON.parse(readFileSync(join(ROOT, ".hutch", "dependencies.lock"), "utf8")) as DependencyRecord;
  const problems: string[] = [];
  for (const object of record.objects) {
    const name = `${object.product ?? object.toolchain ?? object.type} ${object.version}`;
    if (object.type === "toolchain") {
      if (object.toolchain !== "bun" || object.relativeRoot?.replaceAll("\\", "/") !== bunRoot) {
        problems.push(`Hutch uses the ${name} toolchain from ${object.relativeRoot}, not the pinned Bun in ${bunRoot}`);
      }
      continue;
    }
    // sourceManifestSha256 is a file in the core archive, covered by its pin.
    const hashes = Object.entries(object).filter(([key]) => key.endsWith("Sha256") && !key.startsWith("source"));
    if (hashes.length === 0) problems.push(`Hutch installed ${name} with no archive hash to check`);
    for (const [key, value] of hashes) {
      if (!pinned.has(value)) problems.push(`Hutch installed ${name} with ${key} ${value}, which is not pinned`);
    }
  }
  return problems;
}

async function sync(): Promise<number> {
  const resolver = require(join(ELECTROBUN_BIN, "resolve-hutch.cjs")) as HutchResolver;
  const pins = readPins(resolver.ELECTROBUN_VERSION, resolver.PAIRED_HUTCH_VERSION);
  const platformKey = resolver.hutchPlatformKey(process.platform, process.arch) ?? `${process.platform}-${process.arch}`;
  const platform = pins.platforms[platformKey];
  if (!platform) {
    throw new PinError(`scripts/electrobun-toolchain.json pins no toolchain for ${platformKey}; \`bun run desktop:sync\` syncs unpinned`);
  }

  const hutch = await installHutch(resolver, platform.hutch, platformKey);
  const bun = await installBun(pins, platformKey);
  console.log(`Hutch ${pins.hutch} and Bun ${pins.bun} for ${platformKey} match their pins`);

  const mirror = startMirror([...pins.indexes, platform.cottontail, platform.core, platform.cef]);
  const proxy = startRefusingProxy();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTROBUN_HUTCH_BINARY: hutch,
    ELECTROBUN_RELEASES_BASE_URL: `${mirror.origin}/releases`,
    DASH_ARTIFACTS_BASE_URL: `${mirror.origin}/artifacts`,
    BUN_CONFIG_REGISTRY: `${mirror.origin}/npm/`,
    npm_config_registry: `${mirror.origin}/npm/`,
    HUTCH_NO_UPDATE_CHECK: "1",
    https_proxy: proxy.url,
    HTTPS_PROXY: proxy.url,
    no_proxy: "127.0.0.1,localhost",
    NO_PROXY: "127.0.0.1,localhost",
  };
  delete environment.DASH_RELEASE_OFFLINE;
  let status: number;
  try {
    const child = Bun.spawn([process.execPath, join(ELECTROBUN_BIN, "electrobun.cjs"), "sync"], {
      cwd: ROOT,
      env: environment,
      stdio: ["inherit", "inherit", "inherit"],
    });
    status = await child.exited;
  } finally {
    mirror.stop();
    proxy.stop();
  }

  const refused = [...mirror.refused, ...proxy.attempts.map((line) => `Hutch tried to download outside the pins: ${line}`)];
  if (status === 0) refused.push(...unpinnedDependencies(pins, platformKey));
  if (status === 0 && !Buffer.from(bun.bytes).equals(readFileSync(bun.binary))) {
    refused.push(`Hutch replaced the pinned Bun in ${bun.binary}`);
  }
  // Hutch asks up to three times for a file it was refused.
  for (const line of new Set([...refused, ...mirror.failed])) console.error(`electrobun-toolchain: ${line}`);
  if (refused.length > 0) return 2;
  if (status !== 0) return status;

  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `ELECTROBUN_HUTCH_BINARY=${hutch}\nDASH_RELEASE_OFFLINE=1\nHUTCH_NO_UPDATE_CHECK=1\n`);
  }
  console.log(`Electrobun ${pins.electrobun}'s toolchain for ${platformKey} synced from pinned archives only`);
  return 0;
}

interface ReleaseAsset {
  name: string;
  size: number;
  digest?: string | null;
}

/** Each asset of a GitHub release by name, with the size and sha256 GitHub gives it. */
async function releaseAssets(repository: string, tag: string): Promise<Map<string, { size: number; sha256?: string }>> {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`could not read the ${repository} release ${tag}: HTTP ${response.status}`);
  const { assets } = await response.json() as { assets: ReleaseAsset[] };
  return new Map(assets.map((asset) => [asset.name, {
    size: asset.size,
    sha256: asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined,
  }]));
}

/** The one pin every source that names `url` agrees on. */
function agreed(url: string, ...sources: Array<Partial<Omit<Pin, "url">> | null | undefined>): Pin {
  const known = sources.filter((source): source is Partial<Omit<Pin, "url">> => source != null);
  const sha256 = [...new Set(known.map((source) => source.sha256).filter((value) => value != null))];
  const size = [...new Set(known.map((source) => source.size).filter((value) => value != null))];
  if (sha256.length !== 1 || size.length !== 1 || !/^[0-9a-f]{64}$/.test(sha256[0]!)) {
    throw new Error(`the sources for ${url} do not agree on one sha256 and size: ${JSON.stringify(known)}`);
  }
  return { url, sha256: sha256[0]!, size: size[0]! };
}

async function pin(): Promise<number> {
  const resolver = require(join(ELECTROBUN_BIN, "resolve-hutch.cjs")) as HutchResolver;
  const electrobun = resolver.ELECTROBUN_VERSION;
  const release = `${UPSTREAM.releases}/v${electrobun}`;
  const electrobunAssets = await releaseAssets("blackboardsh/electrobun", `v${electrobun}`);
  const fromRelease = (url: string, index?: Partial<Pin>): Pin => {
    if (!url.startsWith(`${release}/`)) throw new Error(`${url} is not in Electrobun's ${electrobun} release`);
    return agreed(url, electrobunAssets.get(url.slice(release.length + 1)), index && { sha256: index.sha256, size: index.size });
  };
  const fetchIndex = async (pinned: Pin) => JSON.parse(new TextDecoder().decode(await downloadPinned(pinned)));

  const artifactsIndex = fromRelease(`${release}/electrobun-artifacts.json`);
  const artifacts = await fetchIndex(artifactsIndex) as { platforms: Record<string, { core: Pin; cef: Pin }> };
  const hutchIndex = await fetchIndex(fromRelease(`${release}/hutch-artifacts.json`)) as {
    hutch: { version: string };
    platforms: Record<string, { archive: Pin }>;
  };
  if (hutchIndex.hutch.version !== resolver.PAIRED_HUTCH_VERSION) {
    throw new Error(`Electrobun's release pairs Hutch ${hutchIndex.hutch.version}, its package ${resolver.PAIRED_HUTCH_VERSION}`);
  }

  // The Bun and Cottontail this Electrobun asks for, from its devkit manifest.
  const linuxCore = artifacts.platforms["linux-x64"]!.core;
  const devkit = JSON.parse(new TextDecoder().decode(tarMember(await downloadPinned(fromRelease(linuxCore.url, linuxCore)), "native-devkit.json"))) as {
    toolchains: { bun: { defaultVersion: string }; cottontail: { defaultVersion: string } };
  };
  const bunVersion = devkit.toolchains.bun.defaultVersion;
  const cottontailVersion = devkit.toolchains.cottontail.defaultVersion;

  const manifestUrl = `${UPSTREAM.artifacts}/cottontail/releases/${cottontailVersion}/manifest.json`;
  const manifestBytes = await download(manifestUrl);
  const cottontailIndex: Pin = { url: manifestUrl, sha256: sha256(manifestBytes), size: manifestBytes.length };
  const cottontail = JSON.parse(new TextDecoder().decode(manifestBytes)) as { platforms: Record<string, { archive: Pin }> };

  const bunAssets = await releaseAssets("oven-sh/bun", `bun-v${bunVersion}`);
  const bunSums = new Map(new TextDecoder().decode(await download(`${BUN_RELEASES}/bun-v${bunVersion}/SHASUMS256.txt`))
    .split("\n").map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length === 2).map(([sum, file]) => [file!, sum!]));

  const platforms: Record<string, PlatformPins> = {};
  for (const [platformKey, bunBuild] of Object.entries(CI_PLATFORMS)) {
    const { core, cef } = artifacts.platforms[platformKey]!;
    const archive = cottontail.platforms[platformKey]!.archive;
    if (!archive.url.startsWith(`${UPSTREAM.artifacts}/`)) throw new Error(`${archive.url} is not on Electrobun's artifact host`);
    const hutchArchive = hutchIndex.platforms[platformKey]!.archive;
    const zip = `${bunBuild}.zip`;
    platforms[platformKey] = {
      hutch: fromRelease(hutchArchive.url, hutchArchive),
      bun: agreed(`${BUN_RELEASES}/bun-v${bunVersion}/${zip}`, bunAssets.get(zip), { sha256: bunSums.get(zip) }),
      cottontail: agreed(archive.url, archive),
      core: fromRelease(core.url, core),
      cef: fromRelease(cef.url, cef),
    };
  }

  const pins: Pins = {
    electrobun,
    hutch: resolver.PAIRED_HUTCH_VERSION,
    cottontail: cottontailVersion,
    bun: bunVersion,
    indexes: [artifactsIndex, cottontailIndex],
    platforms,
  };
  writeFileSync(PINS_FILE, `${JSON.stringify(pins, null, 2)}\n`);
  console.log(`Pinned Electrobun ${electrobun}: Hutch ${pins.hutch}, Cottontail ${cottontailVersion}, Bun ${bunVersion}, for ${Object.keys(CI_PLATFORMS).join(", ")}`);
  return 0;
}

if (import.meta.main) {
  const command = process.argv[2];
  const run = command === "sync" ? sync : command === "pin" ? pin : null;
  if (!run) {
    console.error("usage: bun scripts/electrobun-toolchain.ts sync|pin");
    process.exit(1);
  }
  try {
    process.exit(await run());
  } catch (error) {
    console.error(`electrobun-toolchain: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(error instanceof PinError ? 2 : 1);
  }
}
