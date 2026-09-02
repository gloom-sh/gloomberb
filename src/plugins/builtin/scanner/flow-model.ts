import type { ScannerFlowEvent, ScannerStatus } from "../../../api-client";

export type FlowMinPremium = "50000" | "250000" | "1000000";
export type FlowSide = "calls" | "puts" | "both";
export type FlowKind = "all" | "sweeps" | "blocks";
export type FlowVolOi = "off" | "1" | "5";
export type FlowExpiry = "7" | "30" | "all";
export type FlowUniverse = "active" | "watchlist";

export interface FlowFilters {
  minPremium: FlowMinPremium;
  side: FlowSide;
  kind: FlowKind;
  volOi: FlowVolOi;
  expiry: FlowExpiry;
  universe: FlowUniverse;
}

export const DEFAULT_FLOW_FILTERS: FlowFilters = {
  minPremium: "250000",
  side: "both",
  kind: "all",
  volOi: "off",
  expiry: "all",
  universe: "active",
};

/**
 * One source for the in-pane filter chips and the settings dialog. `label` is the
 * dialog wording, `short` the chip wording.
 */
export const FLOW_FILTER_OPTIONS = {
  minPremium: [
    { value: "50000", label: "$50K", short: "50K" },
    { value: "250000", label: "$250K", short: "250K" },
    { value: "1000000", label: "$1M", short: "1M" },
  ],
  side: [
    { value: "both", label: "Calls and puts", short: "C+P" },
    { value: "calls", label: "Calls only", short: "C" },
    { value: "puts", label: "Puts only", short: "P" },
  ],
  kind: [
    { value: "all", label: "All prints", short: "all" },
    { value: "sweeps", label: "Sweeps only", short: "swp" },
    { value: "blocks", label: "Blocks only", short: "blk" },
  ],
  volOi: [
    { value: "off", label: "No floor", short: "any" },
    { value: "1", label: "1x and up", short: "1x" },
    { value: "5", label: "5x and up", short: "5x" },
  ],
  expiry: [
    { value: "all", label: "Any expiry", short: "any" },
    { value: "7", label: "7 days or less", short: "7d" },
    { value: "30", label: "30 days or less", short: "30d" },
  ],
  universe: [
    { value: "active", label: "Active names", short: "active" },
    { value: "watchlist", label: "My tickers only", short: "mine" },
  ],
} as const satisfies {
  [K in keyof FlowFilters]: readonly { value: FlowFilters[K]; label: string; short: string }[]
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function expiryDaysFromNow(expiry: string, now: number): number | null {
  const parsed = Date.parse(`${expiry}T00:00:00Z`);
  if (Number.isNaN(parsed)) return null;
  return (parsed - now) / MS_PER_DAY;
}

/**
 * The shared feed is published once for everyone, so every user preference is a
 * local predicate over the same events. Never push these upstream.
 */
export function filterFlowEvents(
  events: readonly ScannerFlowEvent[] | undefined,
  filters: FlowFilters,
  watchlist: ReadonlySet<string>,
  now = Date.now(),
): ScannerFlowEvent[] {
  const minPremium = Number(filters.minPremium);
  const minVolOi = filters.volOi === "off" ? null : Number(filters.volOi);
  const maxExpiryDays = filters.expiry === "all" ? null : Number(filters.expiry);

  return (events ?? []).filter((event) => {
    if (!(event.premium >= minPremium)) return false;
    if (filters.side === "calls" && event.right !== "C") return false;
    if (filters.side === "puts" && event.right !== "P") return false;
    if (filters.kind === "sweeps" && event.kind !== "sweep") return false;
    if (filters.kind === "blocks" && event.kind !== "block") return false;
    if (minVolOi != null && !(typeof event.volOi === "number" && event.volOi >= minVolOi)) return false;
    if (maxExpiryDays != null) {
      const days = expiryDaysFromNow(event.expiry, now);
      if (days == null || days > maxExpiryDays || days < -1) return false;
    }
    if (filters.universe === "watchlist" && !watchlist.has(event.underlying.toUpperCase())) return false;
    return true;
  });
}

/**
 * An empty table has two unrelated causes, and blaming the filters for a tape
 * the server never sent sends people to tune filters that were never the
 * problem. Say which one happened.
 */
export function flowEmptyState(
  received: number,
  visible: number,
  status: ScannerStatus | undefined,
): { title: string; hint: string } {
  if (received > visible) {
    return {
      title: `${received - visible} ${received - visible === 1 ? "print" : "prints"} hidden by filters.`,
      hint: "Loosen the premium, expiry, or universe filter.",
    };
  }
  if (status === "closed") {
    return {
      title: "No prints on the tape.",
      hint: "Options are closed; the tape fills again at the next session.",
    };
  }
  return {
    title: "No prints on the tape yet.",
    hint: "Large sweeps, blocks, and premium prints appear here as they cross.",
  };
}

export function formatFlowPremium(premium: number): string {
  if (premium >= 1e9) return `$${(premium / 1e9).toFixed(1)}B`;
  if (premium >= 1e6) return `$${(premium / 1e6).toFixed(1)}M`;
  if (premium >= 1e3) return `$${Math.round(premium / 1e3)}K`;
  return `$${Math.round(premium)}`;
}

export function formatFlowType(event: ScannerFlowEvent): string {
  return `${event.right} ${event.kind}`;
}

export function formatFlowSide(side: ScannerFlowEvent["side"]): string {
  return side === "unknown" ? "—" : side;
}

export function formatFlowVolOi(volOi: number | null | undefined): string {
  if (typeof volOi !== "number" || !Number.isFinite(volOi)) return "—";
  return volOi >= 10 ? `${Math.round(volOi)}x` : `${volOi.toFixed(1)}x`;
}

export function formatFlowExpiry(expiry: string): string {
  const parts = expiry.split("-");
  return parts.length === 3 ? `${parts[1]}/${parts[2]}` : expiry;
}

export function formatFlowTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
