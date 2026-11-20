import { formatWeekdayDay } from "../../../utils/datetime-format";
import type { PaneFooterSegment } from "../../../components/layout/pane/footer";
import { deriveHeadlessFreshness, paneSourceLineVariants, type ReportFreshness } from "../../../cli/pane-functions/freshness";
import { quotesFreshness } from "../../../cli/freshness";
import type { BrokerNameOf } from "../../../market-data/quotes/export-identity";
import { quoteHeadlineTime } from "../../../market-data/market/status";
import type { Quote } from "../../../types/financials";
import type { HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessPaneResult } from "../../../types/headless";
import { getSharedRegistry } from "../../registry";
import { useRemoteUiNode } from "../../../remote/semantic-tree";

/**
 * The footer's one form for where a pane's data comes from and how current it
 * is, the line its `fn` report ends with (paneSourceLineVariants): `DTCC · Thu
 * 12 Nov 2026 · not a live feed (daily levels of public trades)`. A narrow row
 * shortens it to the source and the date, then the date alone. `feed: false`
 * leaves out the delay a pane's clock already shows.
 */
function sourceFooterSegment(
  freshness: ReportFreshness,
  { id = "source", feed = true, time }: {
    id?: string;
    feed?: boolean;
    /** The data's time in its fewest cells (`12:25 UTC`), for a row too narrow for the line's own date: after the sourced lines and last. */
    time?: string;
  } = {},
): PaneFooterSegment {
  const lines = paneSourceLineVariants(freshness, { feed });
  const sourced = freshness.source ? lines.filter((line) => line.startsWith(`${freshness.source} · `)) : [];
  const ordered = time
    ? [...sourced, ...freshness.source ? [`${freshness.source} · ${time}`] : [], ...lines.filter((line) => !sourced.includes(line)), time]
    : lines;
  const [line, ...shorter] = [...new Set(ordered)].map((text) => [{ text, tone: "muted" as const }]);
  return { id, asOf: true, parts: line!, ...(shorter.length ? { variants: shorter } : {}) };
}

/** `12:25 UTC` on the day it is read, `Thu 12 Nov 12:25 UTC` before. */
function compactTime(time: number, now: number): string {
  const at = new Date(time);
  const clock = `${at.toISOString().slice(11, 16)} UTC`;
  if (at.toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) return clock;
  return `${formatWeekdayDay(at, { timeZone: "UTC" })} ${clock}`;
}

/** {@link sourceFooterSegment} for a pane's data read as its report reads it: the definition's freshness over `result`. */
export function reportFooterSegment(
  definition: Pick<HeadlessPaneDefinition, "shape" | "freshness">,
  result: HeadlessPaneResult,
  options: { id?: string; feed?: boolean; now?: number } = {},
): PaneFooterSegment {
  return sourceFooterSegment(deriveHeadlessFreshness(definition, result, options.now), options);
}

const registeredBrokerName: BrokerNameOf = (providerId) => getSharedRegistry()?.getBrokerAdapter(providerId)?.name;

/**
 * {@link sourceFooterSegment} for the quotes a pane shows, as `quote` ends: where they are from (Gloom Cloud, a
 * broker by its name) and the newest's session or time, `Gloom Cloud · EGX trading day Thu 12 Nov 2026 close`,
 * down to `Gloom Cloud · 12:25 UTC` and the time alone in a narrow pane. Its delay is left to the pane's clock.
 * A quote whose source has no name to give leaves the source out rather than calling it Gloom Cloud. Null with
 * no quote.
 */
export function quoteSourceFooterSegment(
  quotes: Iterable<Quote | null | undefined>,
  { id = "source", now = Date.now(), brokerName = registeredBrokerName }: { id?: string; now?: number; brokerName?: BrokerNameOf } = {},
): PaneFooterSegment | null {
  const shown = [...quotes].filter((quote): quote is Quote => quote != null && quote.lastUpdated > 0);
  const freshness = quotesFreshness(shown, undefined, now, brokerName);
  if (!freshness) return null;
  const newest = Math.max(...shown.map((quote) => quoteHeadlineTime(quote)));
  return sourceFooterSegment(freshness, { id, feed: false, ...Number.isFinite(newest) && newest > 0 ? { time: compactTime(newest, now) } : {} });
}

/**
 * A pane that shows a stored, past or dated observation in place of its live
 * data (OVDV's stored close) dates that observation once for every reader, as
 * its report declares it (`{ status: "not-a-feed", basis, asOf }`): the
 * footer's source line, the `report-freshness` a capture's status line and a
 * rendered report read, and the report `options` that print the same view
 * (`report-options`, read by `shot` for what the capture covers). None of them
 * is dated by the live quote of the underlying beside it. Null while the pane
 * shows its live data, which dates itself.
 */
export function useShownObservationFooter(
  shown: { freshness: HeadlessPaneFreshness; options?: Readonly<Record<string, string>> } | null,
  { id = "source" }: { id?: string } = {},
): PaneFooterSegment | null {
  useRemoteUiNode(shown ? { role: "report-freshness", label: "Shown observation", getMetadata: () => ({ ...shown.freshness }) } : null);
  useRemoteUiNode(shown?.options ? { role: "report-options", label: "Shown view", getMetadata: () => ({ options: { ...shown.options } }) } : null);
  return shown ? reportFooterSegment({ shape: "bundle", freshness: shown.freshness }, { sections: [] }, { id }) : null;
}
