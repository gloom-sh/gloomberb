import { getCurrentPluginTarget } from "../../current-target";
import { getSharedRegistry } from "../../registry";
import { listSeriesFiles, seriesFromFile } from "../../../series/files";
import type { SeriesDefinition } from "../../../series/types";
import type { GloomPluginContext } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";

interface RegisteredFile {
  mtimeMs: number;
  dispose: () => void;
}

/**
 * Keeps the catalog in step with the profile's series folder: a file added,
 * changed or removed shows up the next time the catalog opens.
 */
function watchUserSeriesFolder(ctx: GloomPluginContext): () => void {
  const registered = new Map<string, RegisteredFile>();
  let running: Promise<void> = Promise.resolve();

  const sync = async () => {
    const files = await listSeriesFiles(ctx.getConfig().dataDir);
    const present = new Set(files.map((file) => file.name));
    for (const [name, entry] of registered) {
      if (present.has(name)) continue;
      entry.dispose();
      registered.delete(name);
    }
    for (const file of files) {
      const existing = registered.get(file.name);
      if (existing?.mtimeMs === file.mtimeMs) continue;
      existing?.dispose();
      registered.delete(file.name);
      let definitions: SeriesDefinition[];
      try {
        definitions = seriesFromFile(file.name, await file.readText(), file.readText);
      } catch (error) {
        ctx.log.warn("Series file skipped", { file: file.name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const disposers = definitions.flatMap((definition) => {
        try {
          return [ctx.registerSeries(definition)];
        } catch (error) {
          ctx.log.warn("Series skipped", { file: file.name, error: error instanceof Error ? error.message : String(error) });
          return [];
        }
      });
      registered.set(file.name, { mtimeMs: file.mtimeMs, dispose: () => { for (const dispose of disposers) dispose(); } });
    }
  };
  const refresh = () => {
    running = running.then(sync, sync);
    return running;
  };

  void refresh();
  const removeRefresher = getSharedRegistry()?.series.addRefresher(refresh);
  return () => {
    removeRefresher?.();
    for (const entry of registered.values()) entry.dispose();
    registered.clear();
  };
}

let stopWatching: (() => void) | null = null;

/**
 * CSV files in `<data dir>/series/` as catalog series, chartable against
 * anything else. Files are read where the app can reach the disk: the
 * terminal, and the desktop's Bun process, which lists them for its view.
 */
export const userSeriesModule: PluginModule = {
  setup(ctx) {
    const target = getCurrentPluginTarget();
    if (target !== "cli" && target !== "tui") return;
    stopWatching?.();
    stopWatching = watchUserSeriesFolder(ctx);
  },
  dispose() {
    stopWatching?.();
    stopWatching = null;
  },
};
