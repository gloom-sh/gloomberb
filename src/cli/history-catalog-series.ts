import type { GloomPlugin } from "../types/plugin";
import type { HeadlessSeriesResult } from "../types/headless";
import type { PriceWindow } from "../utils/price-window";
import { createPaneCatalog } from "./pane-functions/discovery";
import { loadResolvedHeadlessPaneModel } from "./pane-functions/headless";
import { parsePaneFunctionArgsFor, resolvePaneFunction } from "./pane-functions/resolver";
import type { MarketContext } from "./types";

/** A catalog series as `history` takes it beside listings: `CAP:bond-yield:jp-10y`, `FRED:DGS10`. */
const CATALOG_SERIES_ID = /^(?:CAP|FRED):[A-Za-z0-9][A-Za-z0-9._~%:/-]*$/i;

/** The id of a catalog series an entry of a list names, its prefix in capitals and the rest as typed; null for a listing. */
export function catalogSeriesId(entry: string): string | null {
  const typed = entry.trim();
  if (!CATALOG_SERIES_ID.test(typed)) return null;
  const at = typed.indexOf(":");
  const prefix = typed.slice(0, at).toUpperCase();
  // A FRED id is in capitals, as FRED writes it; a capability's ids are as their source names them.
  return `${prefix}:${prefix === "FRED" ? typed.slice(at + 1).toUpperCase() : typed.slice(at + 1)}`;
}

/** A catalog series' observations as `history --wide` sets them beside listings' closes. */
export interface CatalogSeriesHistory {
  id: string;
  /** What the series is, as the catalog names it: `Japan 10Y JGB yield`. */
  label: string | null;
  /** The unit of its values: `%`, `index`, `USD bn`. */
  unit: string | null;
  /** One value a date, oldest first, as ISO dates. */
  points: Array<{ date: string; value: number }>;
  /** What its chart said of it: a gap, a revision, a series it stands in for. */
  notes: string[];
}

/** The chart's range a history range reads: G has no YTD (the year so far is in its 1Y). */
type ChartRange = "1D" | "1W" | "1M" | "3M" | "6M" | "1Y" | "5Y" | "ALL";

/**
 * A catalog series' daily values over a history's range or window, read as
 * `gloom fn G <id>` charts it, so a series `history` takes is the one the
 * catalog lists. A window reads the whole series and keeps its dates. Throws
 * with the chart's own reason for one that has no values (an id nothing
 * answers to, a source that failed).
 */
export async function loadCatalogSeriesHistory(
  id: string,
  market: MarketContext,
  plugins: GloomPlugin[],
  ask: { range: string; window: PriceWindow | null },
  signal?: AbortSignal,
): Promise<CatalogSeriesHistory> {
  const range: ChartRange = ask.window ? "ALL" : ask.range === "YTD" ? "1Y" : ask.range as ChartRange;
  const registry = await createPaneCatalog(market, plugins);
  try {
    const parsed = parsePaneFunctionArgsFor(registry, ["G", id, "--range-preset", range]);
    const resolved = await resolvePaneFunction(registry, market, parsed, { seriesSources: plugins });
    const loaded = await loadResolvedHeadlessPaneModel(resolved, market, id, signal ?? new AbortController().signal);
    const result = loaded.result as HeadlessSeriesResult;
    const series = result.series?.[0];
    const yearStart = `${new Date().getUTCFullYear()}-01-01`;
    const inAsk = (date: string) => ask.window ? date >= ask.window.from && date <= ask.window.to : ask.range !== "YTD" || date >= yearStart;
    const points = (series?.points ?? []).flatMap((point) => {
      const value = typeof point.value === "number" ? point.value : null;
      const date = new Date(point.date as string).toISOString().slice(0, 10);
      return value != null && Number.isFinite(value) && inAsk(date) ? [{ date, value }] : [];
    });
    // The chart's reason names the series after its line's label ("zz-10y: CAP:bond-yield:zz-10y is not covered"): said from the id.
    const reason = [...result.errors ?? [], ...result.notes ?? []][0];
    const at = reason?.indexOf(id) ?? -1;
    if (points.length === 0) throw new Error(reason ? at > 0 ? reason.slice(at) : reason : `No values for ${id} in this range.`);
    return { id, label: series?.label ?? null, unit: series?.unit ?? null, points, notes: result.notes ?? [] };
  } finally {
    registry.destroy();
  }
}
