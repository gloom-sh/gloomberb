import { lstat, mkdir } from "fs/promises";
import { dirname, join, resolve } from "path";
import { logFailure } from "../../../../utils/log-failure";

/**
 * Electrobun 2 keeps an install's records (its uninstaller and the manifest
 * of what the app put where) in the app's folder under Application Support,
 * and its launcher writes them at every start until they exist. It never
 * makes that folder: on a Mac the app is copied out of the disk image or by
 * Homebrew, and the folder only appears once an update downloads into it.
 * Until then every start logged "Bootstrap install failed ... FileNotFound".
 * So the app makes the folder and has its bundled uninstaller write the
 * records right away, as the launcher would have.
 */

export interface InstallRecordsContext {
  platform: string;
  /** The running Bun: `<bundle>/Contents/MacOS/bun`. */
  execPath: string;
  /** Electrobun's folder for this install, `~/Library/Application Support/<identifier>/<channel>`. */
  channelRoot: () => Promise<string>;
  /** The build's channel; a dev build has no records. */
  channel: () => Promise<string>;
  run?: (command: string[]) => Promise<number>;
}

export type InstallRecordsResult = "none" | "written" | "failed";

const MANIFEST = ".electrobun-uninstall.json";
const MANAGER = "uninstall";

async function isFile(path: string): Promise<boolean> {
  return lstat(path).then((stat) => stat.isFile(), () => false);
}

async function runQuietly(command: string[]): Promise<number> {
  const child = Bun.spawn(command, { stdio: ["ignore", "ignore", "pipe"] });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0 && stderr.trim()) console.error(`[desktop] ${stderr.trim()}`);
  return code;
}

export async function ensureInstallRecords(context: InstallRecordsContext): Promise<InstallRecordsResult> {
  if (context.platform !== "darwin") return "none";
  try {
    if ((await context.channel()) === "dev") return "none";
    const root = await context.channelRoot();
    if (await isFile(join(root, MANIFEST)) && await isFile(join(root, MANAGER))) return "none";
    const bundledManager = resolve(dirname(context.execPath), "..", "Resources", MANAGER);
    if (!await isFile(bundledManager)) return "none";
    await mkdir(root, { recursive: true });
    const code = await (context.run ?? runQuietly)([bundledManager, "--bootstrap-install", root, "--quiet"]);
    if (code !== 0) throw new Error(`the uninstaller exited with ${code}`);
    return "written";
  } catch (error) {
    logFailure("desktop-install-records", "Could not write the app's install records")(error);
    return "failed";
  }
}
