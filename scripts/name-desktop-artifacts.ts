/**
 * `bun scripts/name-desktop-artifacts.ts <artifacts> <channel>`, after a
 * release build (package.json, desktop:release). Electrobun 2 names
 * the installers it makes without the channel prefix: `macos-arm64-Gloom.dmg`
 * and `win-x64-Gloom-Setup.zip`. Releases have always carried the disk image
 * as `stable-macos-arm64-Gloom.dmg`, the name the download page, Homebrew and
 * install.sh fetch, so it takes that name. Windows ships its own installer
 * (scripts/windows-installer.iss), so Electrobun's setup zip goes.
 */
import { existsSync, readdirSync, renameSync, rmSync } from "fs";
import { join } from "path";

/** What to do with each file in `names` for a build of `channel`: the files to rename, and to remove. */
export function desktopArtifactNames(names: readonly string[], channel: string): { rename: Array<[string, string]>; remove: string[] } {
  const rename: Array<[string, string]> = [];
  const remove: string[] = [];
  const unprefixed = /^(?:macos|win|linux)-(?:arm64|x64)-/;
  for (const name of names) {
    if (!unprefixed.test(name)) continue;
    if (name.endsWith(".dmg")) rename.push([name, `${channel}-${name}`]);
    else if (/^win-.*-Setup\.zip$/.test(name)) remove.push(name);
  }
  return { rename, remove };
}

if (import.meta.main) {
  const [dir, channel] = process.argv.slice(2);
  if (!dir || !channel) {
    console.error("Usage: bun scripts/name-desktop-artifacts.ts <artifacts folder> <channel>");
    process.exit(1);
  }
  if (existsSync(dir)) {
    const { rename, remove } = desktopArtifactNames(readdirSync(dir), channel);
    for (const [from, to] of rename) {
      renameSync(join(dir, from), join(dir, to));
      console.log(`Named ${from} ${to}`);
    }
    for (const name of remove) {
      rmSync(join(dir, name), { force: true });
      console.log(`Removed ${name}`);
    }
  }
}
