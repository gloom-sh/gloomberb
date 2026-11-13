/**
 * The files a stable release has to carry, and the check the Release workflow
 * runs on them before it uploads anything:
 *
 *   bun scripts/release-assets.ts check <folder>
 *
 * The upload publishes the release, and a release with one platform missing
 * leaves that platform's installs, self-updates and desktop updates on a 404.
 * So a missing file fails the release job here, by name, and the draft stays
 * a draft. `gh run rerun <run> --failed` builds what is missing again, runs the
 * release job once more, and that publishes it.
 *
 * The terminal binaries are read from the build matrix in
 * build-release-assets.yml, so a platform added there is expected here too.
 */
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { legacyDesktopFiles } from "./write-legacy-desktop-files";

const BUILD_WORKFLOW = join(import.meta.dir, "../.github/workflows/build-release-assets.yml");

/**
 * What the desktop jobs make under the app's name: the update manifest and
 * archive installed apps update from, the installers the download page links,
 * and the zip Homebrew and install.sh put on a Mac.
 */
const DESKTOP_FILES = [
  "stable-macos-arm64-update.json",
  "stable-macos-arm64-Gloom.app.tar.zst",
  "stable-macos-arm64-Gloom.dmg",
  "stable-macos-arm64-Gloom.app.zip",
  "stable-win-x64-update.json",
  "stable-win-x64-Gloom.tar.zst",
  "stable-win-x64-GloomSetup.exe",
];

/** The macOS job packs this one itself, for a Homebrew cask that still installs Gloomberb.app. */
const LEGACY_HOMEBREW_ZIP = "stable-macos-arm64-Gloomberb.app.zip";

interface BuildWorkflow {
  jobs?: { build?: { strategy?: { matrix?: { include?: unknown } } } };
}

/** The gzipped binary each entry of the build matrix uploads: `gloomberb-linux-x64.gz`, `gloomberb-windows-x64.exe.gz`. */
export function terminalAssets(workflowYaml: string): string[] {
  const include = (Bun.YAML.parse(workflowYaml) as BuildWorkflow | null)?.jobs?.build?.strategy?.matrix?.include;
  if (!Array.isArray(include) || include.length === 0) {
    throw new Error("build-release-assets.yml has no build matrix to read the terminal binaries from");
  }
  return include.map((entry: { asset?: unknown } | null) => {
    const asset = entry?.asset;
    if (typeof asset !== "string" || !asset.startsWith("gloomberb-")) {
      throw new Error(`A build matrix entry names no gloomberb-* asset: ${JSON.stringify(entry)}`);
    }
    // scripts/build.ts names the Windows binary .exe before it gzips it.
    return `${asset}${asset.startsWith("gloomberb-windows-") ? ".exe" : ""}.gz`;
  });
}

export function expectedReleaseAssets(workflowYaml: string): string[] {
  return [
    ...terminalAssets(workflowYaml),
    ...DESKTOP_FILES,
    // Installs from before the rename update from these names.
    ...legacyDesktopFiles(DESKTOP_FILES).map((file) => file.legacy),
    LEGACY_HOMEBREW_ZIP,
  ];
}

if (import.meta.main) {
  const [command, dir] = process.argv.slice(2);
  if (command !== "check" || !dir) {
    console.error("Usage: bun scripts/release-assets.ts check <folder>");
    process.exit(2);
  }
  const expected = expectedReleaseAssets(await Bun.file(BUILD_WORKFLOW).text());
  const present = new Set(existsSync(dir) ? readdirSync(dir) : []);
  const missing = expected.filter((name) => !present.has(name));
  if (missing.length > 0) {
    const rerun = process.env.GITHUB_RUN_ID ? `gh run rerun ${process.env.GITHUB_RUN_ID} --failed` : "gh run rerun <run> --failed";
    console.error(`::error title=Release held back::${missing.length} of ${expected.length} release files were not built: ${missing.join(", ")}`);
    console.error(`Nothing was uploaded and the draft stays a draft. \`${rerun}\` builds them again and publishes the release.`);
    process.exit(1);
  }
  console.log(`All ${expected.length} release files are here:`);
  for (const name of expected) console.log(`  ${name}`);
}
