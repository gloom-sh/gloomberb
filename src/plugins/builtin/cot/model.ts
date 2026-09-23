import type { CotClass, CotClassSummary, CotContractPayload, CotFamily, CotHistoryPoint } from "../../../api-client/cot";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";
import { formatPriceObservation } from "../../../market-data/market/format";
import { cleanFloat32Price } from "../../../cli/history-rows";

export const COT_CLASSES: Record<CotFamily, Array<{ value: CotClass; label: string }>> = {
  legacy: [{ value: "noncommercial", label: "Noncommercial" }, { value: "commercial", label: "Commercial" }, { value: "nonreportable", label: "Nonreportable" }],
  disaggregated: [{ value: "managed-money", label: "Managed Money" }, { value: "producer", label: "Producer/Merchant" }, { value: "swap", label: "Swap Dealers" }, { value: "other-reportable", label: "Other Reportables" }, { value: "nonreportable", label: "Nonreportable" }],
};
const ROOTS: Record<string, { code: string; exchange: string; priceSymbol: string | null }> = {
  ZN: { code: "043602", exchange: "CBT", priceSymbol: "ZN=F" },
  ZQ: { code: "045601", exchange: "CBT", priceSymbol: "ZQ=F" },
  CL: { code: "067651", exchange: "NYM", priceSymbol: "CL=F" },
  SI: { code: "084691", exchange: "CMX", priceSymbol: "SI=F" },
  GC: { code: "088691", exchange: "CMX", priceSymbol: "GC=F" },
  VX: { code: "1170E1", exchange: "CFE", priceSymbol: null },
  SR3: { code: "134741", exchange: "CME", priceSymbol: null },
  ES: { code: "13874A", exchange: "CME", priceSymbol: "ES=F" },
};
/**
 * The markets most readers mean by "positioning", verified against the live
 * CFTC boards on 2026-09-22. A code missing from a report family simply does
 * not appear; nothing is substituted. Everything else is one scope switch away.
 */
export const COT_MAJOR_CODES: ReadonlySet<string> = new Set([
  // Equity index and volatility
  "13874A", "209742", "239742", "124603", "1170E1",
  // Rates
  "042601", "044601", "043602", "043607", "020601", "020604", "045601", "134741",
  // Currencies
  "099741", "097741", "096742", "090741", "232741", "092741", "095741", "098662",
  // Crypto
  "133741", "146021",
  // Energy
  "067651", "023651", "111659", "022651", "06765T",
  // Metals
  "088691", "084691", "085692", "076651", "075651",
  // Grains and softs
  "002602", "005602", "001602", "001612", "007601", "026603", "083731", "080732", "033661", "073732",
  // Livestock
  "057642", "054642", "061641",
]);
export const COT_SCOPES = [{ value: "major", label: "Major markets" }, { value: "all", label: "All markets" }] as const;
export type CotScope = typeof COT_SCOPES[number]["value"];
export function cotScope(value: unknown): CotScope { return value === "all" ? "all" : "major"; }

export function cotContractCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toUpperCase().replace(/=F$/, "");
  return ROOTS[input === "VIX" ? "VX" : input]?.code ?? (/^[0-9A-Z]{5}[0-9A-Z+]$/.test(input) ? input : null);
}
/** The verified futures root a CFTC code belongs to, for titles readers recognize. */
export function cotRoot(code: string): string | null {
  return Object.entries(ROOTS).find(([, row]) => row.code === code)?.[0] ?? null;
}
export function cotPriceMapping(code: string) { return Object.values(ROOTS).find((row) => row.code === code) ?? null; }
export function cotClass(family: CotFamily, value: unknown): CotClass {
  return COT_CLASSES[family].find((row) => row.value === value)?.value ?? COT_CLASSES[family][0]!.value;
}
/**
 * CFTC names every market "COMMODITY - EXCHANGE" ("JAPANESE YEN - CHICAGO
 * MERCANTILE EXCHANGE"). The exchange repeats down the board; the market is
 * the part a reader scans for. CFTC spelling is kept, since title-casing would
 * mangle its abbreviations (UST, WTI, SOFR, ULSD).
 */
export function cotMarketName(name: string): string {
  const cut = name.lastIndexOf(" - ");
  return cut > 0 ? name.slice(0, cut).trim() : name.trim();
}
export function cotInteger(value: number | null, signed = false): string {
  return value == null ? "--" : `${signed && value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
export function cotRank(position: CotClassSummary, years: 1 | 3): string {
  const rank = years === 1 ? position.percentile1Y : position.percentile3Y;
  return `${rank.value == null ? "--" : rank.value.toFixed(0)} pctl ${years}Y · ${rank.sampleCount} obs${rank.completeWindow ? "" : " · partial"}`;
}

/** Legend values stay exact: a compact 7.8K hides the futures price and -100K the net position. */
export function cotLegendValue(value: number, series: Pick<ResolvedSeries, "id">): string {
  // Drop the float32 tail of provider bars without rounding away a 1/128 Treasury tick.
  return series.id === "price" ? formatPriceObservation(cleanFloat32Price(value)) : cotInteger(value, true);
}

/**
 * A holiday moves a report date a day or two (2025-11-10 then 2025-11-18), so
 * consecutive weekly reports can sit eight or nine days apart. Only a gap that
 * leaves room for a whole missing week is one.
 */
const COT_MISSING_WEEK_MS = 11 * 86_400_000;

/** Add explicit gaps so absent weeks are not silently joined across a release gap. */
export function cotNetPoints(history: readonly CotHistoryPoint[], traderClass: CotClass) {
  const points: Array<{ date: Date; observedAt: Date; value: number | null }> = [];
  let previous: number | null = null;
  for (const row of history) {
    const time = Date.parse(row.reportDate);
    if (previous != null && time - previous >= COT_MISSING_WEEK_MS) {
      const date = new Date(previous + 7 * 86_400_000);
      points.push({ date, observedAt: date, value: null });
    }
    const date = new Date(time);
    points.push({ date, observedAt: date, value: row.positions.find((position) => position.id === traderClass)?.net ?? null });
    previous = time;
  }
  return points;
}
export function cotChartSeries(data: CotContractPayload, traderClass: CotClass, price: readonly PricePoint[], colors: { positive: string; warning: string }): ResolvedSeries[] {
  const series: ResolvedSeries[] = [{
    ...staticSeries(cotNetPoints(data.history, traderClass), { id: "net", label: `${COT_CLASSES[data.reportFamily].find((row) => row.value === traderClass)?.label ?? traderClass} net`, color: colors.warning, calendarSpaced: true }),
    panelId: "net", unit: "contracts", unitGroup: "positions",
  }];
  if (price.length) series.unshift({
    ...staticSeries(price.map((row) => ({ date: row.date, observedAt: row.date, value: row.close })), { id: "price", label: "Front price", color: colors.positive, calendarSpaced: true }),
    panelId: "price", unit: "", unitGroup: "price",
  });
  return series;
}
