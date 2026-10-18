import type { StablecoinSupplyCoin, StablecoinSupplyPayload } from "../../../api-client/crypto-markets";
import { formatCompact, formatCompactAmount } from "../../../utils/format";
import { formatCryptoPercent, type CryptoRowSupply } from "./model";

const DAY_MS = 86_400_000;

export type SupplyRangeId = "1M" | "3M" | "1Y" | "ALL";

/** The ranges the supply chart offers, as other chart panes label theirs. */
export const SUPPLY_RANGES: ReadonlyArray<{ value: SupplyRangeId; label: string; days: number | null }> = [
  { value: "1M", label: "1M", days: 30 },
  { value: "3M", label: "3M", days: 91 },
  { value: "1Y", label: "1Y", days: 365 },
  { value: "ALL", label: "All", days: null },
];

/**
 * Each board code's supply, by upper-case symbol. Symbols repeat across
 * issuers; the payload lists the largest first, and that one keeps the code.
 */
export function supplyByCode(payload: StablecoinSupplyPayload | null | undefined): ReadonlyMap<string, CryptoRowSupply> {
  if (!payload) return NO_CODES;
  const cached = codesByPayload.get(payload);
  if (cached) return cached;
  const byCode = new Map<string, CryptoRowSupply>();
  for (const coin of payload.coins) {
    const code = coin.symbol.toUpperCase();
    if (!byCode.has(code)) byCode.set(code, rowSupply(coin));
  }
  codesByPayload.set(payload, byCode);
  return byCode;
}

const NO_CODES: ReadonlyMap<string, CryptoRowSupply> = new Map();
/** One map per payload, so rows joined to it keep their identity across renders. */
const codesByPayload = new WeakMap<StablecoinSupplyPayload, ReadonlyMap<string, CryptoRowSupply>>();

function rowSupply(coin: StablecoinSupplyCoin): CryptoRowSupply {
  return {
    supply: coin.supply,
    supply7d: coin.change7d,
    supply7dPercent: coin.change7dPercent,
    supply30d: coin.change30d,
    supply30dPercent: coin.change30dPercent,
    supplyShare: coin.share,
    pegType: coin.pegType,
  };
}

/** One layer of the stacked chart, bottom first, with a value per day of `dates`. */
interface SupplyLayer {
  id: string;
  label: string;
  values: Array<number | null>;
}

export interface StackedSupply {
  dates: Date[];
  /** The charted coins, largest first, then everything else as Other. */
  layers: SupplyLayer[];
}

/**
 * The chart's days in `range`, counted back from the newest day, and its
 * layers: the coins the payload charts (the six largest), then Other, the
 * total less those coins. A day before a coin existed counts it as nothing in
 * Other's sum; a day the total is missing has no Other.
 */
export function stackedSupply(payload: StablecoinSupplyPayload | null | undefined, range: SupplyRangeId): StackedSupply | null {
  const history = payload?.history;
  if (!history || history.total.length < 2) return null;
  const startMs = Date.parse(`${history.start}T00:00:00Z`);
  const last = history.total.findLastIndex((value) => value != null);
  if (last < 1) return null;
  const days = SUPPLY_RANGES.find((option) => option.value === range)?.days ?? null;
  const first = days == null ? 0 : Math.max(0, last - days);
  const dates = Array.from({ length: last - first + 1 }, (_, index) => new Date(startMs + (first + index) * DAY_MS));
  const coins = history.coins.map((coin) => ({
    id: coin.symbol.toUpperCase(),
    label: coin.symbol,
    values: coin.values.slice(first, last + 1).map((value) => value ?? null),
  }));
  const other = history.total.slice(first, last + 1).map((total, day) => {
    if (total == null) return null;
    const charted = coins.reduce((sum, coin) => sum + (coin.values[day] ?? 0), 0);
    // A coin read later in the day than the total can top it by a rounding.
    return Math.max(0, total - charted);
  });
  return { dates, layers: [...coins, { id: "other", label: "Other", values: other }] };
}

/** The supply series as dated rows: the total, each charted coin and Other, oldest first. */
export function supplyHistoryRows(payload: StablecoinSupplyPayload): Array<Record<string, string | number | null>> {
  const stacked = stackedSupply(payload, "ALL");
  if (!stacked) return [];
  // The whole history starts on the payload's first day, so day N is total N.
  const total = payload.history!.total;
  return stacked.dates.map((date, day) => ({
    date: date.toISOString().slice(0, 10),
    total: total[day] ?? null,
    ...Object.fromEntries(stacked.layers.map((layer) => [layer.id, layer.values[day] ?? null])),
  }));
}

/** `Total supply 306.33B · 7D -1.45B (-0.47%) · 30D +1.75B (+0.57%) · as of 2026-10-18`, as the CLI states it. */
export function supplySummaryLine(payload: StablecoinSupplyPayload): string | null {
  const total = payload.total;
  if (!total) return null;
  const change = (amount: number | null, percent: number | null) => (
    amount == null ? "—" : `${formatCompactAmount(amount, { signed: true })} (${formatCryptoPercent(percent)})`
  );
  return [
    `Total supply ${formatCompact(total.supply, { fixedDecimals: true })}`,
    `7D ${change(total.change7d, total.change7dPercent)}`,
    `30D ${change(total.change30d, total.change30dPercent)}`,
    ...(payload.asOf ? [`as of ${payload.asOf}`] : []),
  ].join(" · ");
}

/** A supply failure as a notice: said once, with what failed when the message does not name it. */
export function supplyFailure(message: string): string {
  return /^stablecoin supply\b/i.test(message) ? message : `Stablecoin supply: ${message}`;
}
