import { withDeadline } from "../utils/async-deadline";
import { canonicalExchange } from "../utils/exchanges";
import { CloudApiRequestTransport } from "./request";

const LABELS = ["risk_count", "proxy_count", "filed_at", "call_count", "last_call_at", "filing_count_90d", "last_filed_at", "open_roles", "as_of"] as const;
type SummaryLabel = (typeof LABELS)[number];

export interface WallSummary {
  kind: "counts";
  items: Array<{ label: SummaryLabel; value: number | string }>;
}

/** Keep the optional public route at its counts-and-dates boundary even on a mismatched API. */
export function parseWallSummary(value: unknown): WallSummary | null {
  if (!value || typeof value !== "object") return null;
  const summary = value as Record<string, unknown>;
  if (summary.kind !== "counts" || !Array.isArray(summary.items) || summary.items.length === 0 || summary.items.length > 4) return null;
  const items: WallSummary["items"] = [];
  for (const raw of summary.items) {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    if (!LABELS.includes(item.label as SummaryLabel)) return null;
    const count = typeof item.value === "number" && Number.isSafeInteger(item.value) && item.value >= 0;
    const date = typeof item.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.value) && Number.isFinite(Date.parse(item.value));
    if (!count && !date) return null;
    items.push({ label: item.label as SummaryLabel, value: item.value as number | string });
  }
  return { kind: "counts", items };
}

// A public summary needs no session credential. A separate transport still
// follows the installed desktop/web bridge and keeps this optional feature
// out of clients, such as public share pages, that never render Pro walls.
const publicTransport = new CloudApiRequestTransport();

/** Public aggregate facts only. Missing routes and empty summaries fall back to the frozen sample. */
export async function getWallSummary(wall: string, symbol: string, exchange?: string): Promise<WallSummary | null> {
  const query = new URLSearchParams({ wall, symbol });
  if (exchange) query.set("exchange", canonicalExchange(exchange));
  const controller = new AbortController();
  try {
    const result = await withDeadline(publicTransport.request<unknown>(`/public/wall-summary?${query}`, {
      signal: controller.signal,
    }), 3_000, "Wall summary request timed out", (error) => controller.abort(error));
    return parseWallSummary(result);
  } catch {
    return null;
  }
}
