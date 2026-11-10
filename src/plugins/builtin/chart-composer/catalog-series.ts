/**
 * What G reads a series as from the catalog, the same in the pane and in
 * `fn G`: a bare FRED id or a series alias typed where a ticker goes
 * (`G DFII10`, `G hashrate`), and the short name a catalog series is
 * labelled by however it was typed (`FRED:DFII10` is "10Y TIPS real yield",
 * not FRED's own title).
 */
import { getSharedRegistry } from "../../registry";
import { seriesExpression, seriesNamedBy } from "../../../series/registry";
import type { ChartSeriesSpec } from "../../../time-series/types";
import { buildSeriesSpec } from "./chart-spec-edit";
import { CHART_FIELD_IDS, parseSeriesExpression } from "./series-expression";

/** Where the catalog's series are looked up: the app's registry, or the standalone catalog `fn` reads. */
export interface CatalogSeriesLookups {
  /** A catalog series' name by its expression (`FRED:DFII10`). */
  catalogSeriesName?: (expression: string) => string | undefined;
  /** The catalog series a word names as its alias (`hashrate`). */
  catalogSeriesNamed?: (word: string) => { expression: string; name: string } | undefined;
}

/** The catalog of the plugins the app has loaded. */
export function registryCatalogLookups(): CatalogSeriesLookups {
  return {
    catalogSeriesName: (expression) => getSharedRegistry()?.series?.findByExpression(expression)?.definition.name,
    catalogSeriesNamed: (word) => {
      const definitions = getSharedRegistry()?.series?.list().map(({ definition }) => definition) ?? [];
      const definition = seriesNamedBy(definitions, word);
      return definition ? { expression: seriesExpression(definition), name: definition.name } : undefined;
    },
  };
}

/**
 * The catalog series a bare symbol typed where a ticker goes names: a FRED id
 * the catalog lists (DFII10 is FRED:DFII10) or a word a series lists as its
 * alias, with its id, transform, axis and panel kept. Null for any other
 * series. It does not check that no ticker answers to the symbol: the caller
 * charts it only once the symbol's quote says it is no ticker.
 */
export function bareCatalogCandidate(series: ChartSeriesSpec, lookups: CatalogSeriesLookups): ChartSeriesSpec | null {
  const { source } = series;
  if (source.kind !== "security" || source.instrument.exchange || source.instrument.instrument || source.fieldId !== CHART_FIELD_IDS.price) return null;
  const id = source.instrument.symbol.trim().toUpperCase();
  const fredLabel = /^[A-Z0-9]+$/.test(id) ? lookups.catalogSeriesName?.(`FRED:${id}`) : undefined;
  const named = fredLabel ? undefined : lookups.catalogSeriesNamed?.(id);
  const parsed = named ? parseSeriesExpression(named.expression) : null;
  const label = fredLabel ?? (parsed ? named?.name : undefined);
  if (!label) return null;
  const spec = parsed ? buildSeriesSpec({ ...parsed, label }, 0) : buildSeriesSpec({ kind: "economic", provider: "fred", seriesId: id, label }, 0);
  return { ...spec, id: series.id, transform: series.transform, axis: series.axis, panelId: series.panelId };
}

/** A FRED series typed without a label of its own, labelled by the catalog's short name where the catalog lists it. */
export function withCatalogLabel(series: ChartSeriesSpec, lookups: CatalogSeriesLookups): ChartSeriesSpec {
  if (series.source.kind !== "economic" || series.label?.trim()) return series;
  const label = lookups.catalogSeriesName?.(`FRED:${series.source.seriesId.trim().toUpperCase()}`);
  return label ? { ...series, label } : series;
}
