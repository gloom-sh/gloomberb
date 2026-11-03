import type { HeadlessPaneColumn } from "../../../types/headless";
import { loadResolvedHeadlessPaneModel, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { resolvePaneFunction, UnknownPaneFunctionError } from "../../../cli/pane-functions/resolver";
import type { AppConfig } from "../../../types/config";
import { getSharedRegistry, type PluginRegistry } from "../../registry";
import { marketContextFromRegistry } from "../cloud/askg/host";
import { notViewSourceMessage, unknownViewSourceMessage } from "./sources";
import { applyViewProjection, unknownViewKeys, type UnknownViewKey, type ViewKeyPlace, type ViewRow, type ViewSource, type ViewSpec } from "./view-spec";

export interface LoadedView {
  rows: ViewRow[];
  columns: HeadlessPaneColumn[];
  errors: string[];
  sourceLabel: string;
}

/** Turns a `ref` source into its inline spec; installed by the cloud views module. */
export type ViewRefResolver = (source: Extract<ViewSource, { kind: "ref" }>) => Promise<ViewSpec | null>;

let refResolver: ViewRefResolver | null = null;

export function setViewRefResolver(resolver: ViewRefResolver | null): void {
  refResolver = resolver;
}

function rowsFromResult(result: Record<string, unknown>): { rows: ViewRow[]; columns: HeadlessPaneColumn[] } {
  if (Array.isArray(result.rows)) {
    return { rows: result.rows as ViewRow[], columns: (result.columns as HeadlessPaneColumn[] | undefined) ?? [] };
  }
  if (Array.isArray(result.items)) {
    return { rows: result.items as ViewRow[], columns: (result.columns as HeadlessPaneColumn[] | undefined) ?? [] };
  }
  if (Array.isArray(result.sections)) {
    // A bundle flattens into one table with a section column.
    const rows: ViewRow[] = [];
    const columns = new Map<string, HeadlessPaneColumn>([["section", { key: "section", header: "Section" }]]);
    for (const section of result.sections as Array<{ title: string; rows?: ViewRow[]; entries?: Array<{ label: string; value: unknown }>; columns?: HeadlessPaneColumn[] }>) {
      for (const column of section.columns ?? []) columns.set(column.key, column);
      for (const row of section.rows ?? []) rows.push({ section: section.title, ...row });
      for (const entry of section.entries ?? []) rows.push({ section: section.title, label: entry.label, value: entry.value });
    }
    return { rows, columns: [...columns.values()] };
  }
  if (Array.isArray(result.series)) {
    // A series flattens into rows of date plus one column per series.
    const byDate = new Map<string, ViewRow>();
    const columns: HeadlessPaneColumn[] = [{ key: "date", header: "Date" }];
    for (const series of result.series as Array<{ id: string; label: string; points: Array<Record<string, unknown>> }>) {
      columns.push({ key: series.id, header: series.label, align: "right" });
      for (const point of series.points) {
        const date = String(point.date);
        const row = byDate.get(date) ?? { date };
        row[series.id] = point.value ?? point.close ?? null;
        byDate.set(date, row);
      }
    }
    return { rows: [...byDate.values()], columns };
  }
  return { rows: [], columns: [] };
}

/**
 * Runs the spec's source through the same headless loader ASKG and the CLI
 * use, so a view shows exactly what those tools would read.
 */
export async function loadViewSource(
  spec: ViewSpec,
  config: AppConfig,
  signal: AbortSignal,
  registry: PluginRegistry | undefined = getSharedRegistry(),
  depth = 0,
): Promise<LoadedView> {
  if (spec.source.kind === "ref") {
    if (depth > 2) throw new Error("This view references itself.");
    if (!refResolver) throw new Error("Team views are not available right now.");
    const resolved = await refResolver(spec.source);
    if (!resolved) throw new Error("The referenced team view no longer exists.");
    return loadViewSource(resolved, config, signal, registry, depth + 1);
  }
  if (!registry) throw new Error("The plugin registry is not available.");
  const { pane } = spec.source;
  const options: Record<string, string | true> = {};
  for (const [key, value] of Object.entries(spec.source.options ?? {})) {
    options[key] = value === true ? true : String(value);
  }
  const context = marketContextFromRegistry(registry, config);
  const resolved = await resolvePaneFunction(registry, context, {
    target: pane,
    arg: spec.source.argument ?? "",
    options,
    outputPath: null,
    width: 1280,
    height: 720,
    theme: null,
    scale: 1,
    watermark: null,
    requireBotSafe: false,
  }, { strictHeadlessOptions: true }).catch((error: unknown) => {
    // The catalog search the resolver points at is a command line tool; say which sources a view takes.
    throw error instanceof UnknownPaneFunctionError ? new Error(unknownViewSourceMessage(registry, pane)) : error;
  });
  if (!resolved.headless) throw new Error(notViewSourceMessage(registry, resolved.label));
  const loaded = await loadResolvedHeadlessPaneModel(resolved, context, spec.source.argument ?? "", signal);
  const serialized = serializeHeadlessPaneResult(loaded.definition, loaded.result);
  const { rows, columns } = rowsFromResult(serialized);
  return {
    rows,
    columns,
    errors: [...(loaded.result.errors ?? []), ...(loaded.result.notes ?? [])].filter(Boolean),
    sourceLabel: resolved.label,
  };
}

/** How long a trial load waits; under the 10 s a remote tool call is given. */
const VIEW_TRIAL_TIMEOUT_MS = 8_000;
/** Source keys a refusal lists at most. */
const LISTED_SOURCE_KEYS = 60;

/** The spec names keys the source's rows never carry; nothing is kept. */
export class UnknownViewKeysError extends Error {
  override name = "UnknownViewKeysError";
}

const PLACE_NAMES: Record<ViewKeyPlace, [one: string, many: string]> = {
  column: ["column", "columns"],
  filter: ["filter key", "filter keys"],
  sort: ["sort key", "sort keys"],
  symbolKey: ["symbol key", "symbol keys"],
};

/** `columns change1d, low30d; sort key vol` */
function describeUnknownKeys(unknown: readonly UnknownViewKey[]): string {
  const byPlace = new Map<ViewKeyPlace, string[]>();
  for (const { key, place } of unknown) byPlace.set(place, [...(byPlace.get(place) ?? []), key]);
  return [...byPlace].map(([place, keys]) => `${PLACE_NAMES[place][keys.length === 1 ? 0 : 1]} ${keys.join(", ")}`).join("; ");
}

function comparable(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The source's keys, its listed columns first with their header where it says more than the key: `title (Market)`. */
function describeSourceKeys(columns: readonly HeadlessPaneColumn[], rowKeys: Iterable<string>): string {
  const entries = new Map<string, string>();
  for (const column of columns) {
    if (entries.has(column.key)) continue;
    const header = column.header?.trim();
    entries.set(column.key, header && comparable(header) !== comparable(column.key) ? `${column.key} (${header})` : column.key);
  }
  for (const key of rowKeys) if (!entries.has(key)) entries.set(key, key);
  const listed = [...entries.values()];
  const more = listed.length - LISTED_SOURCE_KEYS;
  return more > 0 ? `${listed.slice(0, LISTED_SOURCE_KEYS).join(", ")} and ${more} more` : listed.join(", ");
}

/**
 * What a trial load says about the spec. Names the spec uses that none of the
 * loaded rows carry throw `UnknownViewKeysError` with the keys they do carry,
 * so a view never opens on columns that stay blank or filters that drop every
 * row. With no rows to read, the source's listed columns are all there is to
 * check against and they need not list every key, so a mismatch only warns.
 */
function checkLoadedView(spec: ViewSpec, loaded: LoadedView): string[] {
  const notes = loaded.errors.slice(0, 2);
  const listed = new Set(loaded.columns.map((column) => column.key));
  if (loaded.rows.length === 0) {
    const unlisted = listed.size > 0 ? unknownViewKeys(spec, listed) : [];
    return [
      "The source loaded no rows.",
      ...notes,
      ...(unlisted.length > 0
        ? [`With no rows to check, these are not among the ${loaded.sourceLabel} columns: ${describeUnknownKeys(unlisted)}. Its columns: ${describeSourceKeys(loaded.columns, [])}.`]
        : []),
    ];
  }
  const rowKeys = new Set<string>();
  for (const row of loaded.rows) for (const key of Object.keys(row)) rowKeys.add(key);
  const unknown = unknownViewKeys(spec, new Set([...listed, ...rowKeys]));
  if (unknown.length > 0) {
    throw new UnknownViewKeysError(
      `Not in the ${loaded.sourceLabel} rows: ${describeUnknownKeys(unknown)}. `
        + `Its rows carry: ${describeSourceKeys(loaded.columns, rowKeys)}. `
        + "Use only those keys, and say which of the asked-for columns this source does not have.",
    );
  }
  const { filters } = spec.projection;
  if (filters.length > 0 && applyViewProjection(loaded.rows, { columns: [], filters }, null).length === 0) {
    const count = loaded.rows.length;
    const none = count === 1 ? "The one row the source loaded does not pass" : `None of the ${count} rows the source loaded pass`;
    return [`${none} the view's filters, so the view shows no rows.`, ...notes];
  }
  return notes;
}

/**
 * Loads the spec's source once through `loadViewSource`, the path its pane
 * takes, before the spec is kept. Throws what the source throws (an unknown
 * function with the valid ones, a usage or option error, a failed read), or
 * `UnknownViewKeysError` for keys its rows never carry, so nothing broken is
 * saved. Resolves with what to tell the person: notes the source carried, an
 * empty result, or that it had not answered in time, which is not a failure:
 * a slow source still opens.
 */
export async function trialLoadViewSource(
  spec: ViewSpec,
  config: AppConfig,
  options: { registry?: PluginRegistry; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string[]> {
  const { registry = getSharedRegistry(), signal, timeoutMs = VIEW_TRIAL_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
      controller.abort();
    }, timeoutMs);
  });
  try {
    const loading = loadViewSource(spec, config, controller.signal, registry);
    loading.catch(() => {
      // Intentional ignore: the race reports load failures; after timeout its result already explains the unchecked source.
    });
    const outcome = await Promise.race([loading, timedOut]);
    if (outcome === "timeout") {
      return [`The source had not answered after ${Math.max(1, Math.round(timeoutMs / 1_000))} s, so it was not checked. The view opens and keeps loading.`];
    }
    return checkLoadedView(spec, outcome);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
