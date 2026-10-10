import type { RemoteUiNodeSnapshot } from "../../remote/types";
import type { HeadlessFreshnessStatus, HeadlessPaneFreshness } from "../../types/headless";
import { isFiniteNumber } from "../../utils/guards";

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

const FRESHNESS_STATUSES: readonly HeadlessFreshnessStatus[] = ["live", "delayed", "stale", "not-a-feed"];

/**
 * How current a rendered pane says its data is, from the `report-freshness`
 * node it publishes: `{ asOf?, status?, delayMinutes? }`. A capture keeps no
 * footer status and few cells carry a time, so a pane that knows its feed
 * (OMON's chain) dates the report here, as the plain command over the same
 * data does.
 */
export function renderedReportFreshness(
  semanticUi: readonly RemoteUiNodeSnapshot[],
): Pick<HeadlessPaneFreshness, "asOf" | "status" | "delayMinutes"> {
  const metadata = semanticUi.find((node) => node.role === "report-freshness")?.metadata;
  if (!metadata) return {};
  const { asOf, status, delayMinutes } = metadata as { asOf?: unknown; status?: unknown; delayMinutes?: unknown };
  return {
    ...(typeof asOf === "string" || isFiniteNumber(asOf) ? { asOf } : {}),
    ...(FRESHNESS_STATUSES.includes(status as HeadlessFreshnessStatus) ? { status: status as HeadlessFreshnessStatus } : {}),
    ...(isFiniteNumber(delayMinutes) && delayMinutes > 0 ? { delayMinutes } : {}),
  };
}
