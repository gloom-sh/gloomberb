import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getGloomberbDirs } from "../../../../data/config/home";
import { emptyScreenSetup, parseScreenSetup, type ScreenSetup } from "../../../desktop/screen-setup";
import type { ScreenSetupStore } from "../../../desktop/window-controller";

/**
 * The windows and where they sit, per monitor arrangement, beside the config
 * and never in it: launch reads it before the config, and it describes this
 * machine's screens, so it stays out of the synced config.
 */
const FILE_NAME = "desktop-windows.json";

function desktopScreenSetupPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(getGloomberbDirs(env).configFile), FILE_NAME);
}

export function desktopScreenSetupStore(path: string = desktopScreenSetupPath()): ScreenSetupStore {
  /** A file this build cannot read, and could not copy: the only one there is, so no save replaces it. */
  let keepUnreadable = false;
  return {
    load(): ScreenSetup {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        // Intentional ignore: no file yet; the windows start from the defaults.
        return emptyScreenSetup();
      }
      try {
        const raw: unknown = JSON.parse(text);
        if (raw && typeof raw === "object" && !Array.isArray(raw)) return parseScreenSetup(raw);
      } catch {
        // Intentional ignore: a file that is not JSON falls through to the copy and the error logged below.
      }
      // The next save would replace a file this build cannot read: a copy stays beside it. Without a copy, the
      // file stays as it is and this run saves nothing over it; the next launch tries the copy again.
      try {
        copyFileSync(path, `${path}.bak`);
        console.error("[desktop] the window setup could not be read; a copy was kept as desktop-windows.json.bak");
      } catch {
        keepUnreadable = true;
        console.error("[desktop] the window setup could not be read or copied; it is left as it is, and window changes are not saved until a later launch can keep a copy");
      }
      return emptyScreenSetup();
    },
    save(setup: ScreenSetup): void {
      if (keepUnreadable) return;
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temporary, JSON.stringify(setup));
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        console.error("[desktop] could not save the window setup", error instanceof Error ? error.message : String(error));
      }
    },
  };
}
