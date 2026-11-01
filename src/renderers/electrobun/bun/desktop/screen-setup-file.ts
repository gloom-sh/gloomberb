import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
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
  return {
    load(): ScreenSetup {
      try {
        return parseScreenSetup(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        // Intentional ignore: no file yet, or one this build cannot read; the windows start from the defaults.
        return emptyScreenSetup();
      }
    },
    save(setup: ScreenSetup): void {
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
