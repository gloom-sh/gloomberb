import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const installScript = join(import.meta.dir, "install.sh");

interface FakeMachine {
  /** What `uname -s` reports. */
  unameSystem: string;
  /** What `uname -m` reports. */
  unameMachine: string;
  /** `sysctl -n sysctl.proc_translated`, unset when the key does not exist. */
  procTranslated?: string;
  /** `sysctl -n hw.optional.arm64`, unset when the key does not exist. */
  hardwareArm64?: string;
}

interface InstallRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Every argument passed to the stubbed downloader, one per line. */
  downloadLog: string;
  /** What `gloom` runs, following links. */
  installed?: string;
  /** What `gloomberb` runs, following links. */
  legacy?: string;
  /** Where `gloom` and `gloomberb` point, when they are links. */
  links: { gloom?: string; gloomberb?: string };
  temporaryFiles: string[];
}

let workDir = "";

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gloomberb-install-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function writeStub(binDir: string, name: string, body: string) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
}

/**
 * Runs the real install script against a fake machine without network or sudo.
 * Unspecified downloads fail, allowing architecture checks to stop at download.
 */
async function runInstall(machine: FakeMachine, options: {
  downloads?: Record<string, string | Uint8Array>;
  script?: string;
  /** A `gloomberb` binary from before the rename, in the install folder. */
  existingInstall?: string;
} = {}): Promise<InstallRun> {
  const binDir = join(workDir, "bin");
  const installDir = join(workDir, "install");
  const appDir = join(workDir, "Applications");
  const downloadLog = join(workDir, "downloads.log");
  const tempDir = join(workDir, "tmp");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  mkdirSync(tempDir);
  if (options.existingInstall) writeFileSync(join(installDir, "gloomberb"), options.existingInstall);

  writeStub(binDir, "uname", [
    'case "$1" in',
    '  -m) printf "%s\\n" "$FAKE_UNAME_MACHINE" ;;',
    '  *) printf "%s\\n" "$FAKE_UNAME_SYSTEM" ;;',
    "esac",
  ].join("\n"));

  writeStub(binDir, "sysctl", [
    '# Only -n <key> is used by the installer.',
    'case "$2" in',
    '  sysctl.proc_translated) value="$FAKE_PROC_TRANSLATED" ;;',
    '  hw.optional.arm64) value="$FAKE_HW_ARM64" ;;',
    '  *) value="" ;;',
    "esac",
    'if [ -z "$value" ]; then',
    '  echo "sysctl: unknown oid \'$2\'" >&2',
    "  exit 1",
    "fi",
    'printf "%s\\n" "$value"',
  ].join("\n"));

  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const downloads = Object.entries(options.downloads ?? {}).map(([url, contents], index) => {
    const file = join(workDir, `download-${index}`);
    writeFileSync(file, contents);
    return `  ${quote(url)}) cp ${quote(file)} "$dest" ;;`;
  });
  const downloader = [
    'for arg in "$@"; do printf "%s\\n" "$arg" >> "$FAKE_DOWNLOAD_LOG"; done',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o|-O) shift; dest="$1" ;;',
    '    https://*) url="$1" ;;',
    '  esac',
    '  shift',
    'done',
    'case "$url" in',
    ...downloads,
    '  *) exit 22 ;;',
    'esac',
  ].join("\n");
  writeStub(binDir, "curl", downloader);
  writeStub(binDir, "wget", downloader);
  writeStub(binDir, "sudo", 'echo "Unexpected sudo invocation" >&2; exit 1');

  let script = installScript;
  if (options.script !== undefined) {
    script = join(workDir, "install.sh");
    writeFileSync(script, options.script);
  }

  const proc = Bun.spawn(["sh", script], {
    cwd: workDir,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      HOME: workDir,
      TMPDIR: tempDir,
      GLOOMBERB_INSTALL_DIR: installDir,
      GLOOMBERB_APP_DIR: appDir,
      FAKE_UNAME_SYSTEM: machine.unameSystem,
      FAKE_UNAME_MACHINE: machine.unameMachine,
      FAKE_PROC_TRANSLATED: machine.procTranslated ?? "",
      FAKE_HW_ARM64: machine.hardwareArm64 ?? "",
      FAKE_DOWNLOAD_LOG: downloadLog,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
    downloadLog: existsSync(downloadLog) ? readFileSync(downloadLog, "utf8") : "",
    installed: existsSync(join(installDir, "gloom")) ? readFileSync(join(installDir, "gloom"), "utf8") : undefined,
    legacy: existsSync(join(installDir, "gloomberb")) ? readFileSync(join(installDir, "gloomberb"), "utf8") : undefined,
    links: { gloom: linkTarget(join(installDir, "gloom")), gloomberb: linkTarget(join(installDir, "gloomberb")) },
    temporaryFiles: readdirSync(tempDir),
  };
}

function linkTarget(path: string): string | undefined {
  try {
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

describe("install.sh architecture detection", () => {
  // https://github.com/gloom-sh/gloomberb/issues/539: an Intel Mac used to get
  // the arm64 app and only found out at launch, with "Bad CPU type in
  // executable". It now gets the x64 terminal build, never the app bundle.
  test("installs the x64 terminal build on a genuine Intel Mac", async () => {
    const run = await runInstall({
      unameSystem: "Darwin",
      unameMachine: "x86_64",
    });

    expect(run.downloadLog).toContain("gloomberb-darwin-x64.gz");
    expect(run.downloadLog).not.toContain("stable-macos-arm64");
    // Downloads always fail here, so this also covers a release that ships no
    // Intel asset: the installer has to explain itself.
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("gloomberb-darwin-x64.gz is not available");
    expect(run.stderr).toContain("https://term.gloom.sh");
  });

  test("installs the arm64 app from an x86_64 shell translated by Rosetta", async () => {
    const run = await runInstall({
      unameSystem: "Darwin",
      unameMachine: "x86_64",
      procTranslated: "1",
    });

    expect(run.downloadLog).toContain("stable-macos-arm64-Gloomberb.app.zip");
    expect(run.stderr).not.toContain("does not support Intel Macs");
  });

  test("installs the arm64 app on an Apple Silicon Mac", async () => {
    const run = await runInstall({
      unameSystem: "Darwin",
      unameMachine: "arm64",
      hardwareArm64: "1",
    });

    expect(run.downloadLog).toContain("stable-macos-arm64-Gloomberb.app.zip");
  });

  test("installs the x64 binary on Linux", async () => {
    const run = await runInstall({
      unameSystem: "Linux",
      unameMachine: "x86_64",
    });

    expect(run.downloadLog).toContain("gloomberb-linux-x64.gz");
  });

  test("installs the arm64 binary on Linux", async () => {
    const run = await runInstall({
      unameSystem: "Linux",
      unameMachine: "aarch64",
    });

    expect(run.downloadLog).toContain("gloomberb-linux-arm64.gz");
  });


});

const linuxMachine = { unameSystem: "Linux", unameMachine: "x86_64" };
const metadataUrl = "https://api.github.com/repos/gloom-sh/gloomberb/releases/latest";
const assetName = "gloomberb-linux-x64.gz";
const assetUrl = `https://github.com/gloom-sh/gloomberb/releases/download/v1.2.3/${assetName}`;
const binary = "#!/bin/sh\necho installed\n";
const compressed = Bun.gzipSync(binary);
const digest = new Bun.CryptoHasher("sha256").update(compressed).digest("hex");

function releaseMetadata(assetDigest: string | null, checksumName?: string): string {
  return JSON.stringify({
    name: 'Release with "quotes", {braces} and a backslash \\',
    assets: [
      { name: "other.gz", digest: `sha256:${"0".repeat(64)}`, browser_download_url: `${assetUrl}.other` },
      { name: assetName, uploader: { name: "Uploader" }, digest: assetDigest, browser_download_url: assetUrl },
      ...(checksumName ? [{ name: checksumName, browser_download_url: `${assetUrl}/${checksumName}` }] : []),
    ],
  });
}

describe("install.sh verification", () => {
  test("verifies the selected release asset before installing without sudo", async () => {
    const run = await runInstall(linuxMachine, { downloads: {
      [metadataUrl]: releaseMetadata(`sha256:${digest}`),
      [assetUrl]: compressed,
    } });

    expect(run.exitCode).toBe(0);
    expect(run.installed).toBe(binary);
    expect(run.stdout).toContain(`Verified SHA-256 for ${assetName}`);
    expect(run.stdout).toContain(assetUrl);
    expect(run.stdout).toContain(join(workDir, "install", "gloom"));
    expect(run.temporaryFiles).toEqual([]);
  });

  // Installs from before the rename have the binary itself at gloomberb.
  // Reinstalling puts it at gloom and leaves gloomberb as a link that runs it.
  test("an install from before the rename becomes gloom, with gloomberb still running it", async () => {
    const run = await runInstall(linuxMachine, {
      downloads: {
        [metadataUrl]: releaseMetadata(`sha256:${digest}`),
        [assetUrl]: compressed,
      },
      existingInstall: "old binary",
    });

    expect(run.exitCode).toBe(0);
    expect(run.installed).toBe(binary);
    expect(run.links).toEqual({ gloom: undefined, gloomberb: "gloom" });
    expect(run.legacy).toBe(binary);
    expect(run.stdout).toContain("Run 'gloom' to start.");
  });

  test("rejects a digest mismatch without replacing an existing install", async () => {
    const run = await runInstall(linuxMachine, {
      downloads: {
        [metadataUrl]: releaseMetadata(`sha256:${"0".repeat(64)}`),
        [assetUrl]: compressed,
      },
      existingInstall: "old binary",
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("SHA-256 mismatch");
    expect(run.installed).toBeUndefined();
    expect(run.legacy).toBe("old binary");
    expect(run.temporaryFiles).toEqual([]);
  });

  test("a macOS app digest mismatch aborts before extraction or terminal fallback", async () => {
    const name = "stable-macos-arm64-Gloomberb.app.zip";
    const url = `https://github.com/gloom-sh/gloomberb/releases/download/v1.2.3/${name}`;
    const run = await runInstall({ unameSystem: "Darwin", unameMachine: "arm64" }, {
      downloads: {
        [metadataUrl]: JSON.stringify({ assets: [{ name, digest: `sha256:${"0".repeat(64)}`, browser_download_url: url }] }),
        [url]: "corrupt archive",
      },
      existingInstall: "old binary",
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("SHA-256 mismatch");
    expect(run.downloadLog).not.toContain("gloomberb-darwin-arm64.gz");
    expect(run.installed).toBeUndefined();
    expect(run.legacy).toBe("old binary");
    expect(run.temporaryFiles).toEqual([]);
  });

  test.each([
    ["SHA256SUMS", `${digest}  unrelated.gz\n${digest} *${assetName}\n`, true],
    ["checksums.txt", `SHA256 (${assetName}) = ${digest}\n`, true],
    [`${assetName}.sha256`, `${digest}\n`, true],
    ["SHA256SUMS", `${"0".repeat(64)}  ${assetName}\n`, false],
  ] as const)("uses %s when the asset digest is unavailable", async (name, contents, valid) => {
    const run = await runInstall(linuxMachine, { downloads: {
      [metadataUrl]: releaseMetadata(null, name),
      [assetUrl]: compressed,
      [`${assetUrl}/${name}`]: contents,
    } });

    expect(run.exitCode === 0).toBe(valid);
    expect(run.installed).toBe(valid ? binary : undefined);
    expect(valid ? run.stdout : run.stderr).toContain(valid ? "Verified SHA-256" : "SHA-256 mismatch");
    expect(run.temporaryFiles).toEqual([]);
  });

  test.each([true, false])("warns when no checksum is obtainable (metadata available: %p)", async (metadataAvailable) => {
    const url = metadataAvailable ? assetUrl : `https://github.com/gloom-sh/gloomberb/releases/latest/download/${assetName}`;
    const run = await runInstall(linuxMachine, { downloads: {
      ...(metadataAvailable ? { [metadataUrl]: releaseMetadata(null) } : {}),
      [url]: compressed,
    } });

    expect(run.exitCode).toBe(0);
    expect(run.installed).toBe(binary);
    expect(run.stderr).toContain("Continuing without checksum verification.");
    expect(run.temporaryFiles).toEqual([]);
  });

  test("a script truncated before the last invocation does not download or install", async () => {
    const source = readFileSync(installScript, "utf8");
    const run = await runInstall(linuxMachine, {
      script: source.slice(0, source.lastIndexOf('main "$@"')),
      existingInstall: "old binary",
    });

    expect(run.exitCode).toBe(0);
    expect(run.downloadLog).toBe("");
    expect(run.installed).toBeUndefined();
    expect(run.legacy).toBe("old binary");
    expect(run.temporaryFiles).toEqual([]);
  });
});

describe("install.sh on an Apple Silicon Mac", () => {
  const appAsset = "stable-macos-arm64-Gloomberb.app.zip";
  const appUrl = `https://github.com/gloom-sh/gloomberb/releases/download/v1.2.3/${appAsset}`;

  /** A zipped app bundle holding the given terminal commands. */
  function zippedApp(commands: string[]): Uint8Array {
    const root = mkdtempSync(join(workDir, "app-"));
    const resources = join(root, "Gloomberb.app", "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    for (const command of commands) {
      writeFileSync(join(resources, command), "#!/bin/sh\n");
      chmodSync(join(resources, command), 0o755);
    }
    const zip = Bun.spawnSync(["zip", "-qr", "app.zip", "Gloomberb.app"], { cwd: root });
    if (zip.exitCode !== 0) throw new Error(zip.stderr.toString());
    return readFileSync(join(root, "app.zip"));
  }

  // gloom.sh/install serves this script from main, so it meets releases from
  // before the rename, whose app has only the gloomberb command.
  test.skipIf(!Bun.which("zip") || !Bun.which("unzip")).each([
    ["a release that ships gloom", ["gloom", "gloomberb"], "gloom"],
    ["a release from before the rename", ["gloomberb"], "gloomberb"],
  ] as const)("links gloom and gloomberb for %s", async (_, commands, gloomTarget) => {
    const archive = zippedApp([...commands]);
    const checksum = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
    const run = await runInstall({ unameSystem: "Darwin", unameMachine: "arm64", hardwareArm64: "1" }, {
      downloads: {
        [metadataUrl]: JSON.stringify({ assets: [{ name: appAsset, digest: `sha256:${checksum}`, browser_download_url: appUrl }] }),
        [appUrl]: archive,
      },
      existingInstall: "old binary",
    });

    const resources = join(workDir, "Applications", "Gloomberb.app", "Contents", "Resources");
    expect(run.exitCode).toBe(0);
    expect(run.links).toEqual({ gloom: join(resources, gloomTarget), gloomberb: join(resources, "gloomberb") });
    expect(run.stdout).toContain("Run 'gloom' to start.");
  });
});
