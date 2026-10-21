import type { CryptoEtfFlowAsset, CryptoEtfFlowDay, CryptoEtfFlowsPayload } from "../../../api-client/crypto-etf-flows";
import type { DataTableColumn } from "../../../components";
import { formatCompactAmount, formatNumber } from "../../../utils/format";

export const CRYPTO_ETF_FLOWS_PANE_ID = "crypto-etf-flows";

export const CRYPTO_ETF_FLOW_ASSETS: ReadonlyArray<{ value: CryptoEtfFlowAsset; label: string }> = [
  { value: "BTC", label: "Bitcoin" },
  { value: "ETH", label: "Ether" },
];

export type CryptoEtfFlowRange = "1M" | "3M" | "1Y" | "ALL";

/** The range the chart and the table show; the figures always read the whole history. */
export const CRYPTO_ETF_FLOW_RANGES: ReadonlyArray<{ value: CryptoEtfFlowRange; label: string; hint: string }> = [
  { value: "1M", label: "1M", hint: "1" },
  { value: "3M", label: "3M", hint: "2" },
  { value: "1Y", label: "1Y", hint: "3" },
  { value: "ALL", label: "All", hint: "4" },
];

export function cryptoEtfFlowRange(value: unknown): CryptoEtfFlowRange {
  return CRYPTO_ETF_FLOW_RANGES.find((range) => range.value === value)?.value ?? "1Y";
}

const RANGE_MONTHS: Record<Exclude<CryptoEtfFlowRange, "ALL">, number> = { "1M": 1, "3M": 3, "1Y": 12 };

/** The days within a range of the newest one listed, newest first. */
export function daysInRange(days: readonly CryptoEtfFlowDay[], range: CryptoEtfFlowRange): CryptoEtfFlowDay[] {
  const newest = days[0]?.date;
  if (!newest || range === "ALL") return [...days];
  const start = new Date(`${newest}T00:00:00Z`);
  start.setUTCMonth(start.getUTCMonth() - RANGE_MONTHS[range]);
  const from = start.toISOString().slice(0, 10);
  return days.filter((day) => day.date > from);
}

/** `btc`, `bitcoin`, `ETH`, `ether`, `ethereum`: the asset a setting or option names; bitcoin otherwise. */
export function cryptoEtfFlowAsset(value: unknown): CryptoEtfFlowAsset {
  const text = typeof value === "string" ? value.trim().toUpperCase() : "";
  return text === "ETH" || text === "ETHER" || text === "ETHEREUM" ? "ETH" : "BTC";
}

export const cryptoEtfFlowAssetLabel = (asset: CryptoEtfFlowAsset) => asset === "ETH" ? "Ether" : "Bitcoin";

/** A day's flow in US$ millions as the table shows it: `+665.2`, `-83.6`, `0.0`, `—` for none. */
export function formatFlow(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const text = formatNumber(Math.abs(value), 1);
  return value > 0 && text !== "0.0" ? `+${text}` : value < 0 && text !== "0.0" ? `-${text}` : text;
}

/** A sum of flows in US$ millions as a figure reads it: `+$526.7M`, `-$1.13B`, `$0`. */
export function formatFlowAmount(millions: number | null | undefined): string {
  if (millions == null || !Number.isFinite(millions)) return "—";
  const text = formatCompactAmount(millions * 1_000_000, { signed: true });
  return text.replace(/^([+-]?)/, "$1$");
}

/** Inflows green, outflows red; a day with no flow recedes, so the funds that moved stand out in a wide table. */
export const flowColor = (value: number | null | undefined, colors: { positive: string; negative: string; textMuted: string }) =>
  value == null || value === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative;

export interface CryptoEtfFlowSummary {
  latest: CryptoEtfFlowDay | null;
  /** Sums of the published daily totals over the newest days listed. */
  week: number | null;
  month: number | null;
  /** Every listed day's total: the net flow since the first fund launched. */
  sinceLaunch: number | null;
  firstDate: string | null;
}

const sumTotals = (days: readonly CryptoEtfFlowDay[]) => days.some((day) => day.total != null)
  ? days.reduce((sum, day) => sum + (day.total ?? 0), 0)
  : null;

/** The figures over the table: the newest day, the last 5 and 20 trading days, and since launch. */
export function cryptoEtfFlowSummary(payload: CryptoEtfFlowsPayload): CryptoEtfFlowSummary {
  const days = payload.days;
  return {
    latest: days[0] ?? null,
    week: days.length >= 5 ? sumTotals(days.slice(0, 5)) : null,
    month: days.length >= 20 ? sumTotals(days.slice(0, 20)) : null,
    sinceLaunch: sumTotals(days),
    firstDate: days.at(-1)?.date ?? null,
  };
}

/** The running sum of the daily totals, oldest first: what the chart draws. */
export function cumulativeFlows(payload: CryptoEtfFlowsPayload): Array<{ date: string; value: number }> {
  let running = 0;
  return payload.days.toReversed().map((day) => {
    running += day.total ?? 0;
    return { date: day.date, value: running };
  });
}

/** "IBIT pending" or "IBIT, ETHB pending": the funds a day still waits on. */
export function pendingText(day: CryptoEtfFlowDay | null | undefined): string | null {
  return day?.pending.length ? `${day.pending.join(", ")} pending` : null;
}

export type CryptoEtfFlowColumn = Omit<DataTableColumn, "id"> & { id: string };

/** Date and the day's total, then each fund in the publisher's order. */
export function cryptoEtfFlowColumns(payload: CryptoEtfFlowsPayload | null | undefined): CryptoEtfFlowColumn[] {
  return [
    { id: "date", label: "Date", width: 12, align: "left" },
    { id: "total", label: "Total", width: 9, align: "right", title: "The day's net flow across the funds, US$ millions" },
    ...(payload?.funds ?? []).map((fund): CryptoEtfFlowColumn => ({
      id: `fund:${fund.ticker}`,
      label: fund.ticker,
      width: Math.max(8, fund.ticker.length + 2),
      align: "right",
      ...(fund.name ? { title: fund.issuer ? `${fund.name} (${fund.issuer})` : fund.name } : {}),
    })),
  ];
}

export const fundTickerOfColumn = (columnId: string) => columnId.startsWith("fund:") ? columnId.slice(5) : null;
