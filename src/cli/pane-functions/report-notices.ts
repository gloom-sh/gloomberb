import type { RemoteUiNodeSnapshot } from "../../remote/types";

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
