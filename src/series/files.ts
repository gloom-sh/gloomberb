import { logFailure } from "../utils/log-failure";
import { inferSeriesFrequency, parseSeriesCsv } from "./csv";
import type { SeriesDefinition, SeriesFrequency } from "./types";
import { SERIES_FREQUENCIES, isValidSeriesUnit } from "./validate";

/** The folder in the data directory whose CSV files become catalog series. */
const SERIES_FOLDER = "series";
const USER_GROUP = "Your series";

/** Where series files live for a data directory. */
function seriesFolder(dataDir: string): string {
  return `${dataDir.replace(/\/+$/, "")}/${SERIES_FOLDER}`;
}

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
export function seriesFromFile(
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

export interface SeriesFolderFile {
  name: string;
  mtimeMs: number;
  /** Reads the file again, so each chart load sees the latest edit. */
  readText(): Promise<string>;
}

/** The CSV files in the folder, or none when it does not exist. Bun only. */
export async function listSeriesFiles(dataDir: string): Promise<SeriesFolderFile[]> {
  const { readdir, readFile, stat } = await nodeFs();
  const folder = seriesFolder(dataDir);
  let names: string[];
  try {
    names = (await readdir(folder)).filter((name) => name.toLowerCase().endsWith(".csv"));
  } catch (error) {
    // Intentional ignore: an absent optional file or directory is expected.
    if ((error as { code?: unknown } | null)?.code !== "ENOENT") logFailure("series.files", "Listing series files failed")(error);
    return [];
  }
  const files = await Promise.all(names.map(async (name): Promise<SeriesFolderFile | null> => {
    const path = `${folder}/${name}`;
    try {
      const { mtimeMs } = await stat(path);
      return { name, mtimeMs, readText: () => readFile(path, "utf-8") };
    } catch (error) {
      // Intentional ignore: an absent optional file or directory is expected.
      if ((error as { code?: unknown } | null)?.code !== "ENOENT") logFailure("series.files", "Reading series file metadata failed")(error);
      return null;
    }
  }));
  return files.filter((file): file is SeriesFolderFile => file !== null);
}

/** Every series in the folder's files, read once. A file that does not parse is left out. */
export async function readSeriesFolder(dataDir: string): Promise<SeriesDefinition[]> {
  const files = await listSeriesFiles(dataDir);
  const definitions = await Promise.all(files.map(async (file) => {
    try {
      return seriesFromFile(file.name, await file.readText(), file.readText);
    } catch (error) {
      logFailure("series.files", "Reading series definitions failed")(error);
      return [];
    }
  }));
  return definitions.flat();
}
