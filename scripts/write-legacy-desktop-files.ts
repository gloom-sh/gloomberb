/**
 * Writes the desktop release files under the app's old name, Gloomberb, beside
 * the ones Electrobun names after Gloom: `bun scripts/write-legacy-desktop-files.ts <artifacts>`.
 *
 * An install from 0.18.4 or before updates itself by asking the latest
 * release for `<channel>-<os>-<arch>-Gloomberb.app.tar.zst` (macOS) or
 * `-Gloomberb.tar.zst` (Windows), the name it was built with. Its macOS
 * updater installs whatever `.app` the archive holds, so that one is a copy;
 * its Windows updater looks for a `Gloomberb` folder inside, so that archive
 * is packed again with the folder renamed. The disk image and the Windows
 * installer are copied too, for links that still name them (the download
 * page, the README) until they move to the new names.
 *
 * Every release must keep carrying these for as long as such installs may
 * still update. The Homebrew zip under the old name holds `Gloomberb.app`,
 * which takes `ditto`, so the macOS job makes it.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { join, resolve } from "path";
import { DESKTOP_APP_NAME, LEGACY_DESKTOP_APP_NAME } from "../src/renderers/electrobun/shared/app-name";

interface LegacyFile {
  source: string;
  legacy: string;
  /** Packed again with its top folder renamed, rather than copied. */
  renameTopFolder: boolean;
}

const PREFIX = String.raw`(?:stable|nightly)-(?:macos|win|linux)-(?:arm64|x64)-`;
const NEW = DESKTOP_APP_NAME;
const OLD = LEGACY_DESKTOP_APP_NAME;

/** For each desktop release file under the new name, the old name an earlier build asks for. */
export function legacyDesktopFiles(names: readonly string[]): LegacyFile[] {
  const rules: Array<{ pattern: RegExp; renameTopFolder: boolean }> = [
    // The macOS update archive and disk image: any .app inside does for the old updater.
    { pattern: new RegExp(`^(${PREFIX})${NEW}(\\.app\\.tar\\.zst|\\.dmg)$`), renameTopFolder: false },
    // The Windows update archive: the old updater opens <name>\ inside it.
    { pattern: new RegExp(`^(${PREFIX.replace("(?:macos|win|linux)", "win")})${NEW}(\\.tar\\.zst)$`), renameTopFolder: true },
    // Linux takes whatever folder the archive holds.
    { pattern: new RegExp(`^(${PREFIX.replace("(?:macos|win|linux)", "linux")})${NEW}(\\.tar\\.zst)$`), renameTopFolder: false },
    { pattern: new RegExp(`^(${PREFIX})${NEW}(Setup\\.exe)$`), renameTopFolder: false },
  ];
  return names.flatMap((source) => {
    for (const { pattern, renameTopFolder } of rules) {
      const match = pattern.exec(source);
      if (match) return [{ source, legacy: `${match[1]}${OLD}${match[2]}`, renameTopFolder }];
    }
    return [];
  });
}

function run(command: string[], cwd: string): void {
  // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble ._ files, as Electrobun's own packing does.
  const result = Bun.spawnSync(command, { cwd, stdout: "inherit", stderr: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed with exit code ${result.exitCode}`);
}

/**
 * Packs `source` (a .tar.zst holding one top folder, `from`) again as
 * `destination` with that folder named `to`. Unpacked and packed with the
 * system tar, as Electrobun packs it; paths stay relative, since Windows tar
 * reads `C:` as a remote host.
 */
async function renameTopFolder(source: string, destination: string, from: string, to: string, workRoot: string): Promise<void> {
  const work = join(workRoot, `${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(work, { recursive: true });
  try {
    await Bun.write(join(work, "in.tar"), Bun.zstdDecompressSync(await Bun.file(source).bytes()));
    run(["tar", "-xf", "in.tar"], work);
    rmSync(join(work, "in.tar"));
    const top = readdirSync(work);
    if (top.length !== 1 || top[0] !== from) throw new Error(`${source} should hold one folder, ${from}; it holds ${top.join(", ") || "nothing"}`);
    renameSync(join(work, from), join(work, to));
    run(["tar", "-cf", "out.tar", to], work);
    await Bun.write(destination, Bun.zstdCompressSync(await Bun.file(join(work, "out.tar")).bytes()));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Writes the old-name files beside the new ones in `dir`. Resolves to the names it wrote. */
export async function writeLegacyDesktopFiles(dir: string, workRoot = join(dir, "..", "build", "legacy-desktop-files")): Promise<string[]> {
  const written: string[] = [];
  for (const file of legacyDesktopFiles(readdirSync(dir).sort())) {
    const source = join(dir, file.source);
    const legacy = join(dir, file.legacy);
    if (file.renameTopFolder) await renameTopFolder(source, legacy, NEW, OLD, workRoot);
    else copyFileSync(source, legacy);
    written.push(file.legacy);
  }
  return written;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir || !existsSync(dir)) {
    console.error("Usage: bun scripts/write-legacy-desktop-files.ts <artifacts folder>");
    process.exit(1);
  }
  const written = await writeLegacyDesktopFiles(resolve(dir));
  if (written.length === 0) {
    console.error(`No desktop release files named ${NEW} in ${dir}.`);
    process.exit(1);
  }
  for (const name of written) console.log(`Wrote ${name}`);
}
