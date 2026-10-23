import type { RemoteUiNodeSnapshot } from "../../remote/types";
import type { HeadlessFreshnessStatus, HeadlessPaneFreshness } from "../../types/headless";
import type { PaneDef, PaneTemplateDef } from "../../types/plugin";
import { isFiniteNumber, isRecord } from "../../utils/guards";

/**
 * What a function declares its view's data to be: its pane's
 * `reportFreshness`, or its template's, which names the one view it opens
 * when the pane hosts several (DDIS in Fixed Income).
 */
export function declaredReportFreshness(resolved: {
  pane: Pick<PaneDef, "reportFreshness">;
  template?: Pick<PaneTemplateDef, "reportFreshness">;
}): NonNullable<PaneDef["reportFreshness"]> {
  return { ...resolved.pane.reportFreshness, ...resolved.template?.reportFreshness };
}

export interface RenderedReportNotices {
  /** Lines a report prints under its title, such as "21 of 145 strikes". */
  notices: string[];
  /** The same facts by key, for `metadata` in JSON: `strikes: { shown, total, window }`. */
  facts: Record<string, unknown>;
}

/**
 * What a rendered pane says about the rows it lists, from the `report-notice`
 * nodes it publishes: `{ text, key?, value? }`. The pane knows what its view
 * leaves out (the option chain's strike window); the report repeats it.
 */
export function renderedReportNotices(semanticUi: readonly RemoteUiNodeSnapshot[]): RenderedReportNotices {
  const notices: string[] = [];
  const facts: Record<string, unknown> = {};
  for (const node of semanticUi) {
    if (node.role !== "report-notice" || !node.metadata) continue;
    const { text, key, value } = node.metadata as { text?: unknown; key?: unknown; value?: unknown };
    if (typeof text === "string" && text.trim() && !notices.includes(text.trim())) notices.push(text.trim());
    if (typeof key === "string" && key && value !== undefined) facts[key] = value;
  }
  return { notices, facts };
}

/**
 * Why a rendered pane cannot give the report it was asked for, from the
 * `report-failure` node it publishes: `{ message, details? }`. OMON opened on
 * an expiry the chain does not list says so in its body; the report fails with
 * the error the plain command (`options --expiration`) prints, instead of
 * reading that body back as a view. Null when the pane publishes none.
 */
export function renderedReportFailure(semanticUi: readonly RemoteUiNodeSnapshot[]): { message: string; details?: string } | null {
  const metadata = semanticUi.find((node) => node.role === "report-failure")?.metadata;
  const message = typeof metadata?.message === "string" ? metadata.message.trim() : "";
  if (!message) return null;
  const details = typeof metadata?.details === "string" && metadata.details.trim() ? metadata.details.trim() : undefined;
  return details ? { message, details } : { message };
}

const FRESHNESS_STATUSES: readonly HeadlessFreshnessStatus[] = ["live", "delayed", "stale", "not-a-feed"];

/** The `sources` a pane publishes: each a name and a time. */
function publishedSources(value: unknown): NonNullable<HeadlessPaneFreshness["sources"]> | null {
  if (!Array.isArray(value)) return null;
  const sources = value.flatMap((entry) => (
    isRecord(entry) && typeof entry.source === "string" && (typeof entry.asOf === "string" || isFiniteNumber(entry.asOf))
      ? [{ source: entry.source, asOf: entry.asOf }] : []
  ));
  return sources.length ? sources : null;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * How current a rendered pane says its data is, from the `report-freshness`
 * node it publishes: `{ asOf?, status?, delayMinutes?, source?, sources?,
 * maxAgeMinutes?, oldestAge?, note?, noteVariants?, basis?, asOfLabel?, datesEachVenue? }`; `basis` names what a pane
 * that is not a feed lists, when one pane lists different things (NI's
 * stories, and its LTR code's letters). A capture keeps no footer status and
 * few cells carry a time, so a pane that knows its feed (OMON's chain) dates
 * the report here, as the plain command over the same data does, and a pane
 * over several venues (PERP) dates each one as its report does, as does one
 * whose quotes trade on several markets (RV's `datesEachVenue`). A pane whose
 * figures come from several dated quotes (FXC's pair rates) publishes them
 * instead, see `renderedReportObservations`.
 */
export function renderedReportFreshness(
  semanticUi: readonly RemoteUiNodeSnapshot[],
): Pick<HeadlessPaneFreshness, "asOf" | "status" | "delayMinutes" | "source" | "sources" | "maxAgeMinutes" | "oldestAge" | "note" | "noteVariants" | "basis" | "asOfLabel" | "datesEachVenue"> {
  const metadata = semanticUi.find((node) => node.role === "report-freshness")?.metadata;
  if (!metadata) return {};
  const { asOf, status, delayMinutes, source, maxAgeMinutes, oldestAge, note, noteVariants, basis, asOfLabel, datesEachVenue } = metadata as Record<string, unknown>;
  const sources = publishedSources(metadata.sources);
  return {
    ...(typeof asOf === "string" || isFiniteNumber(asOf) ? { asOf } : {}),
    ...(FRESHNESS_STATUSES.includes(status as HeadlessFreshnessStatus) ? { status: status as HeadlessFreshnessStatus } : {}),
    ...(isFiniteNumber(delayMinutes) && delayMinutes > 0 ? { delayMinutes } : {}),
    ...(typeof source === "string" && source.trim() ? { source } : {}),
    ...(sources ? { sources } : {}),
    ...(isFiniteNumber(maxAgeMinutes) && maxAgeMinutes > 0 ? { maxAgeMinutes } : {}),
    ...(oldestAge === true ? { oldestAge } : {}),
    ...(typeof note === "string" && note.trim() ? { note } : {}),
    ...(isStringList(noteVariants) && noteVariants.length > 0 ? { noteVariants } : {}),
    ...(typeof basis === "string" && basis.trim() ? { basis } : {}),
    ...(typeof asOfLabel === "string" && asOfLabel.trim() ? { asOfLabel } : {}),
    ...(datesEachVenue === true ? { datesEachVenue } : {}),
  };
}

/**
 * The dated observations a rendered pane's figures come from, from the
 * `observations` its `report-freshness` node publishes: one record per quote
 * or rate, in the fields of a headless report's rows (`quoteTime`,
 * `dataSource`, `delayMinutes`, `stale`, `sessionExchange`, `marketState`).
 * The report reads them as it reads those rows, so it says what the newest is,
 * how far the feed is held back, which are stale and where the market stands.
 */
export function renderedReportObservations(semanticUi: readonly RemoteUiNodeSnapshot[]): Record<string, unknown>[] {
  const observations = semanticUi.find((node) => node.role === "report-freshness")?.metadata?.observations;
  return Array.isArray(observations) ? observations.filter(isRecord) : [];
}
