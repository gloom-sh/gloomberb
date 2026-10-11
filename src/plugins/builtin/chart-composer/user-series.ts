import { getCurrentPluginTarget } from "../../current-target";
import { getSharedRegistry } from "../../registry";
import { inferSeriesFrequency, parseSeriesCsv } from "../../../series/csv";
import { SERIES_FREQUENCIES, isValidSeriesUnit } from "../../../series/validate";
import type { SeriesDefinition, SeriesFrequency } from "../../../series/types";
import type { GloomPluginContext } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";

/** The folder in the profile whose CSV files become catalog series. */
const USER_SERIES_FOLDER = "series";
const USER_GROUP = "Your series";

async function nodeFs(): Promise<typeof import("fs/promises")> {
  // A variable path keeps the browser builds from bundling the module.
  const fsModulePath = "fs/promises";
  return await import(fsModulePath) as typeof import("fs/promises");
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "") || "series";
}

function titleFromFile(stem: string): string {
  const words = stem.replace(/[-_.]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : stem;
}

/**
 * The series one file holds: one per value column. `# name`, `# unit`,
 * `# frequency`, `# group` and `# description` lines set what the catalog
 * shows; without them the name comes from the file and the column, the unit
 * is a plain number and the frequency is read off the dates.
 */
export function userSeriesDefinitions(
  file: string,
  text: string,
  readText: () => Promise<string>,
): SeriesDefinition[] {
  const parsed = parseSeriesCsv(text);
  const stem = file.replace(/\.csv$/i, "");
  const { metadata } = parsed;
  const single = parsed.columns.length === 1;
  const unit = metadata.unit && isValidSeriesUnit(metadata.unit) ? metadata.unit : "number";
  const declared = SERIES_FREQUENCIES.find((frequency) => frequency === metadata.frequency?.trim().toLowerCase());
  return parsed.columns.map((column, index): SeriesDefinition => {
    const header = column.header && !/^(?:value|values|close)$/i.test(column.header) ? column.header : undefined;
    const base = metadata.name ?? titleFromFile(stem);
    const frequency: SeriesFrequency = declared ?? inferSeriesFrequency(column.points);
    return {
      id: `user:${slug(stem)}${single ? "" : `.${slug(column.header ?? String(index + 1))}`}`,
      name: single ? (metadata.name ?? header ?? base) : `${base}: ${header ?? `column ${index + 1}`}`,
      unit,
      frequency,
      group: metadata.group?.trim() || USER_GROUP,
      tags: [file, "user", "file"],
      ...(metadata.description ? { description: metadata.description } : {}),
      load: async () => {
        const current = parseSeriesCsv(await readText()).columns[index];
        if (!current) throw new Error(`${file} no longer has column ${index + 1}.`);
        return current.points;
      },
    };
  });
}

function seriesFolder(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}/${USER_SERIES_FOLDER}`;
}

/** Every series in the folder's files, read once: what a report without the plugin runtime charts. */
export async function readUserSeriesFolder(dataDir: string): Promise<SeriesDefinition[]> {
  const target = getCurrentPluginTarget();
  if (target !== "cli" && target !== "tui") return [];
  const { readdir, readFile } = await nodeFs();
  const folder = seriesFolder(dataDir);
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith(".csv"));
  } catch {
    return [];
  }
  const definitions = await Promise.all(names.map(async (name) => {
    const readText = () => readFile(`${folder}/${name}`, "utf-8");
    try {
      return userSeriesDefinitions(name, await readText(), readText);
    } catch {
      return [];
    }
  }));
  return definitions.flat();
}

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
    const { readdir, readFile, stat } = await nodeFs();
    const folder = seriesFolder(ctx.getConfig().dataDir);
    let names: string[];
    try {
      names = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith(".csv"));
    } catch {
      names = [];
    }
    const present = new Set(names);
    for (const [name, entry] of registered) {
      if (present.has(name)) continue;
      entry.dispose();
      registered.delete(name);
    }
    for (const name of names) {
      const path = `${folder}/${name}`;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        continue;
      }
      const existing = registered.get(name);
      if (existing?.mtimeMs === mtimeMs) continue;
      existing?.dispose();
      registered.delete(name);
      const readText = () => readFile(path, "utf-8");
      let definitions: SeriesDefinition[];
      try {
        definitions = userSeriesDefinitions(name, await readText(), readText);
      } catch (error) {
        ctx.log.warn("Series file skipped", { file: name, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const disposers = definitions.flatMap((definition) => {
        try {
          return [ctx.registerSeries(definition)];
        } catch (error) {
          ctx.log.warn("Series skipped", { file: name, error: error instanceof Error ? error.message : String(error) });
          return [];
        }
      });
      registered.set(name, { mtimeMs, dispose: () => { for (const dispose of disposers) dispose(); } });
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
