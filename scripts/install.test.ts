import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
  /** What `ldd --version` prints; the host's own ldd when unset. */
  lddVersion?: string;
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
  /** Puts other files in the install folder before the run. */
  prepare?: (installDir: string) => void;
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
  options.prepare?.(installDir);

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
  // musl's ldd prints its version to stderr and exits 1.
  if (machine.lddVersion !== undefined) writeStub(binDir, "ldd", `printf '%s\\n' ${quote(machine.lddVersion)} >&2\nexit 1`);
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

    expect(run.downloadLog).toContain("stable-macos-arm64-Gloom.app.zip");
    expect(run.stderr).not.toContain("does not support Intel Macs");
  });

  test("installs the arm64 app on an Apple Silicon Mac", async () => {
    const run = await runInstall({
      unameSystem: "Darwin",
      unameMachine: "arm64",
      hardwareArm64: "1",
    });

    // Without release metadata it tries the app's name, then its name before the rename.
    expect(run.downloadLog).toContain("releases/latest/download/stable-macos-arm64-Gloom.app.zip");
    expect(run.downloadLog).toContain("releases/latest/download/stable-macos-arm64-Gloomberb.app.zip");
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

  // The glibc binary crashed at startup on Alpine: "Error relocating
  // libopentui.so: getcontext: symbol not found".
  test.each([
    ["x86_64", "gloomberb-linux-x64-musl.gz"],
    ["aarch64", "gloomberb-linux-arm64-musl.gz"],
  ])("installs the musl binary on Alpine (%s)", async (unameMachine, asset) => {
    const run = await runInstall({
      unameSystem: "Linux",
      unameMachine,
      lddVersion: "musl libc (x86_64)\nVersion 1.2.5\nDynamic Program Loader",
    });

    expect(run.downloadLog).toContain(asset);
    expect(run.downloadLog).not.toMatch(/gloomberb-linux-(x64|arm64)\.gz/);
    // Downloads fail here, as they would against a release without musl builds.
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("bun install -g gloomberb");
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

  // Another program can own the name gloom. The script keeps its file and
  // installs Gloom as gloomberb, the way the app leaves such a file alone.
  test("keeps another program's gloom and installs gloomberb", async () => {
    const run = await runInstall(linuxMachine, {
      downloads: {
        [metadataUrl]: releaseMetadata(`sha256:${digest}`),
        [assetUrl]: compressed,
      },
      existingInstall: "old binary",
      prepare: (installDir) => writeFileSync(join(installDir, "gloom"), "another program"),
    });

    expect(run.exitCode).toBe(0);
    expect(run.installed).toBe("another program");
    expect(run.legacy).toBe(binary);
    expect(run.links).toEqual({ gloom: undefined, gloomberb: undefined });
    expect(run.stdout).toContain("it belongs to another program");
    expect(run.stdout).toContain("Run 'gloomberb' to start.");
  });

  test.each([
    ["the binary an earlier run installed", (installDir: string) => {
      writeFileSync(join(installDir, "gloom"), "old binary");
      symlinkSync("gloom", join(installDir, "gloomberb"));
    }],
    ["the link an old binary added when it updated", (installDir: string) => {
      writeFileSync(join(installDir, "gloomberb"), "old binary");
      symlinkSync("gloomberb", join(installDir, "gloom"));
    }],
  ] as const)("replaces a gloom that is ours: %s", async (_, prepare) => {
    const run = await runInstall(linuxMachine, {
      downloads: {
        [metadataUrl]: releaseMetadata(`sha256:${digest}`),
        [assetUrl]: compressed,
      },
      prepare,
    });

    expect(run.exitCode).toBe(0);
    expect(run.installed).toBe(binary);
    expect(run.links).toEqual({ gloom: undefined, gloomberb: "gloom" });
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
  const appAsset = "stable-macos-arm64-Gloom.app.zip";
  const legacyAsset = "stable-macos-arm64-Gloomberb.app.zip";
  const releaseUrl = "https://github.com/gloom-sh/gloomberb/releases/download/v1.2.3";
  const mac = { unameSystem: "Darwin", unameMachine: "arm64", hardwareArm64: "1" };
  const hasZip = Bun.which("zip") && Bun.which("unzip");

  /** A zipped app bundle named `bundle`, holding the given terminal commands. */
  function zippedApp(commands: string[], bundle = "Gloom.app"): Uint8Array {
    const root = mkdtempSync(join(workDir, "app-"));
    const resources = join(root, bundle, "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    for (const command of commands) {
      writeFileSync(join(resources, command), "#!/bin/sh\n");
      chmodSync(join(resources, command), 0o755);
    }
    const zip = Bun.spawnSync(["zip", "-qr", "app.zip", bundle], { cwd: root });
    if (zip.exitCode !== 0) throw new Error(zip.stderr.toString());
    return readFileSync(join(root, "app.zip"));
  }

  /** A release listing `archives` by name, with their digests. */
  function release(archives: Record<string, Uint8Array>): Record<string, string | Uint8Array> {
    const assets = Object.entries(archives).map(([name, archive]) => ({
      name,
      digest: `sha256:${new Bun.CryptoHasher("sha256").update(archive).digest("hex")}`,
      browser_download_url: `${releaseUrl}/${name}`,
    }));
    return {
      [metadataUrl]: JSON.stringify({ assets }),
      ...Object.fromEntries(Object.entries(archives).map(([name, archive]) => [`${releaseUrl}/${name}`, archive])),
    };
  }

  const resources = (bundle = "Gloom.app") => join(workDir, "Applications", bundle, "Contents", "Resources");

  /** An installed app at `Applications/<bundle>`, with the Info.plist Electrobun writes for `identifier`. */
  function installedApp(bundle: string, identifier: string): string {
    const app = join(workDir, "Applications", bundle);
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist version=\"1.0\">",
      "<dict>",
      "    <key>CFBundleIdentifier</key>",
      `    <string>${identifier}</string>`,
      "</dict>",
      "</plist>",
    ].join("\n"));
    for (const command of ["gloom", "gloomberb"]) writeFileSync(join(app, "Contents", "Resources", command), `${bundle} ${identifier}`);
    return app;
  }

  // gloom.sh/install serves this script from main, so it meets releases from
  // before the rename, which ship Gloomberb.app (and before that, only the
  // gloomberb command). The app goes in as Gloom.app either way.
  test.skipIf(!hasZip).each([
    ["a release that ships Gloom.app", { [appAsset]: ["Gloom.app", ["gloom", "gloomberb"]] }, "gloom"],
    ["a release from before the app's rename", { [legacyAsset]: ["Gloomberb.app", ["gloom", "gloomberb"]] }, "gloom"],
    ["a release from before the command's rename", { [legacyAsset]: ["Gloomberb.app", ["gloomberb"]] }, "gloomberb"],
  ] as const)("installs Gloom.app and links gloom and gloomberb for %s", async (_, archives, gloomTarget) => {
    const run = await runInstall(mac, {
      downloads: release(Object.fromEntries(Object.entries(archives).map(([name, [bundle, commands]]) => [name, zippedApp([...commands], bundle)]))),
      existingInstall: "old binary",
    });

    expect(run.exitCode).toBe(0);
    expect(readdirSync(join(workDir, "Applications"))).toEqual(["Gloom.app"]);
    expect(run.links).toEqual({ gloom: join(resources(), gloomTarget), gloomberb: join(resources(), "gloomberb") });
    expect(run.stdout).toContain("Run 'gloom' to start.");
  });

  // The links into the old bundle move wherever the app itself would move
  // them: the install folder, ~/.local/bin, ~/bin, Homebrew's and PATH's
  // folders. Left pointing at the removed bundle, they would run nothing.
  test.skipIf(!hasZip)("replaces a Gloomberb.app install and moves its command links to Gloom.app", async () => {
    const localBin = join(workDir, ".local", "bin");
    const homeBin = join(workDir, "bin");
    const run = await runInstall(mac, {
      downloads: release({ [appAsset]: zippedApp(["gloom", "gloomberb"]), [legacyAsset]: zippedApp(["gloom", "gloomberb"], "Gloomberb.app") }),
      prepare: (installDir) => {
        const legacy = installedApp("Gloomberb.app", "com.vincelwt.gloomberb");
        symlinkSync(join(legacy, "Contents", "Resources", "gloom"), join(installDir, "gloom"));
        symlinkSync(join(legacy, "Contents", "Resources", "gloomberb"), join(installDir, "gloomberb"));
        mkdirSync(localBin, { recursive: true });
        symlinkSync("../../Applications/Gloomberb.app/Contents/Resources/gloom", join(localBin, "gloom"));
        symlinkSync(join(legacy, "Contents", "Resources", "gloomberb"), join(homeBin, "gloomberb"));
        symlinkSync("/opt/other/Gloomberb.app/Contents/Resources/gloom", join(homeBin, "gloom"));
      },
    });

    expect(run.exitCode).toBe(0);
    expect(run.downloadLog).not.toContain(legacyAsset);
    expect(readdirSync(join(workDir, "Applications"))).toEqual(["Gloom.app"]);
    expect(run.links).toEqual({ gloom: join(resources(), "gloom"), gloomberb: join(resources(), "gloomberb") });
    expect(readlinkSync(join(localBin, "gloom"))).toBe("../../Applications/Gloom.app/Contents/Resources/gloom");
    expect(readlinkSync(join(homeBin, "gloomberb"))).toBe(join(resources(), "gloomberb"));
    // Into another bundle under the old name: not this install's.
    expect(readlinkSync(join(homeBin, "gloom"))).toBe("/opt/other/Gloomberb.app/Contents/Resources/gloom");
  });

  test.skipIf(!hasZip || process.getuid?.() === 0)("keeps Gloomberb.app while a link into it sits in a folder the user cannot write", async () => {
    const localBin = join(workDir, ".local", "bin");
    try {
      const run = await runInstall(mac, {
        downloads: release({ [appAsset]: zippedApp(["gloom", "gloomberb"]) }),
        prepare: () => {
          const legacy = installedApp("Gloomberb.app", "com.vincelwt.gloomberb");
          mkdirSync(localBin, { recursive: true });
          symlinkSync(join(legacy, "Contents", "Resources", "gloom"), join(localBin, "gloom"));
          chmodSync(localBin, 0o555);
        },
      });

      expect(run.exitCode).toBe(0);
      expect(readdirSync(join(workDir, "Applications")).sort()).toEqual(["Gloom.app", "Gloomberb.app"]);
      expect(readlinkSync(join(localBin, "gloom"))).toBe(join(resources("Gloomberb.app"), "gloom"));
      expect(run.stdout).toContain(`Kept ${join(workDir, "Applications", "Gloomberb.app")}`);
      expect(run.stdout).toContain(join(localBin, "gloom"));
    } finally {
      chmodSync(localBin, 0o755);
    }
  });

  // Only a Gloom.app with this app's bundle identifier is replaced. Another
  // program's stays, and Gloom goes in under its old name, which the app keeps
  // while the new one is taken.
  test.skipIf(!hasZip).each([
    ["this app's", "com.vincelwt.gloomberb", ["Gloom.app"], "Gloom.app"],
    ["another program's", "com.example.gloom", ["Gloom.app", "Gloomberb.app"], "Gloomberb.app"],
  ] as const)("an existing Gloom.app that is %s", async (_, identifier, apps, installedAs) => {
    const run = await runInstall(mac, {
      downloads: release({ [appAsset]: zippedApp(["gloom", "gloomberb"]) }),
      prepare: () => { installedApp("Gloom.app", identifier); },
    });

    expect(run.exitCode).toBe(0);
    expect(readdirSync(join(workDir, "Applications")).sort()).toEqual([...apps]);
    expect(run.links).toEqual({ gloom: join(resources(installedAs), "gloom"), gloomberb: join(resources(installedAs), "gloomberb") });
    // The installed commands are the release's; another program's Gloom.app is untouched.
    expect(readFileSync(join(resources(installedAs), "gloom"), "utf8")).toBe("#!/bin/sh\n");
    if (installedAs !== "Gloom.app") expect(readFileSync(join(resources(), "gloom"), "utf8")).toBe(`Gloom.app ${identifier}`);
  });

  test("refuses when Gloom.app and Gloomberb.app both belong to other programs", async () => {
    const run = await runInstall(mac, {
      downloads: release({ [appAsset]: new Uint8Array([1]) }),
      prepare: () => {
        installedApp("Gloom.app", "com.example.gloom");
        installedApp("Gloomberb.app", "com.example.gloomberb");
      },
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("both belong to other apps. Nothing was installed.");
    expect(run.downloadLog).not.toContain(appAsset);
    expect(readFileSync(join(resources(), "gloom"), "utf8")).toBe("Gloom.app com.example.gloom");
  });

  test.skipIf(!hasZip)("keeps another program's gloom link and links gloomberb", async () => {
    const run = await runInstall(mac, {
      downloads: release({ [appAsset]: zippedApp(["gloom", "gloomberb"]) }),
      prepare: (installDir) => symlinkSync("/opt/other/bin/gloom", join(installDir, "gloom")),
    });

    expect(run.exitCode).toBe(0);
    expect(run.links).toEqual({ gloom: "/opt/other/bin/gloom", gloomberb: join(resources(), "gloomberb") });
    expect(run.stdout).toContain("Run 'gloomberb' to start.");
  });
});
