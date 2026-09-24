import type { CotClass, CotContractPayload, CotFamily, CotHistoryPoint } from "../../../api-client/cot";
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
 * Front-month price overlays for major markets without a root alias, each
 * checked to return five years of daily history (2026-09-24). Keyed by CFTC
 * code, never added to ROOTS: an alias would also claim the equity ticker under
 * the cursor (ZM, ZS, PL). No cash index stands in, so the dollar index has none.
 */
const PRICE_OVERLAYS: Record<string, { exchange: string; priceSymbol: string }> = {
  "209742": { exchange: "CME", priceSymbol: "NQ=F" }, "239742": { exchange: "CME", priceSymbol: "RTY=F" },
  "124603": { exchange: "CBT", priceSymbol: "YM=F" },
  "042601": { exchange: "CBT", priceSymbol: "ZT=F" }, "044601": { exchange: "CBT", priceSymbol: "ZF=F" },
  "043607": { exchange: "CBT", priceSymbol: "TN=F" }, "020601": { exchange: "CBT", priceSymbol: "ZB=F" },
  "020604": { exchange: "CBT", priceSymbol: "UB=F" },
  "099741": { exchange: "CME", priceSymbol: "6E=F" }, "097741": { exchange: "CME", priceSymbol: "6J=F" },
  "096742": { exchange: "CME", priceSymbol: "6B=F" }, "090741": { exchange: "CME", priceSymbol: "6C=F" },
  "232741": { exchange: "CME", priceSymbol: "6A=F" }, "092741": { exchange: "CME", priceSymbol: "6S=F" },
  "095741": { exchange: "CME", priceSymbol: "6M=F" },
  "133741": { exchange: "CME", priceSymbol: "BTC=F" }, "146021": { exchange: "CME", priceSymbol: "ETH=F" },
  "023651": { exchange: "NYM", priceSymbol: "NG=F" }, "111659": { exchange: "NYM", priceSymbol: "RB=F" },
  "022651": { exchange: "NYM", priceSymbol: "HO=F" }, "06765T": { exchange: "NYM", priceSymbol: "BZ=F" },
  "085692": { exchange: "CMX", priceSymbol: "HG=F" }, "076651": { exchange: "NYM", priceSymbol: "PL=F" },
  "075651": { exchange: "NYM", priceSymbol: "PA=F" },
  "002602": { exchange: "CBT", priceSymbol: "ZC=F" }, "005602": { exchange: "CBT", priceSymbol: "ZS=F" },
  "001602": { exchange: "CBT", priceSymbol: "ZW=F" }, "001612": { exchange: "CBT", priceSymbol: "KE=F" },
  "007601": { exchange: "CBT", priceSymbol: "ZL=F" }, "026603": { exchange: "CBT", priceSymbol: "ZM=F" },
  "083731": { exchange: "NYB", priceSymbol: "KC=F" }, "080732": { exchange: "NYB", priceSymbol: "SB=F" },
  "033661": { exchange: "NYB", priceSymbol: "CT=F" }, "073732": { exchange: "NYB", priceSymbol: "CC=F" },
  "057642": { exchange: "CME", priceSymbol: "LE=F" }, "054642": { exchange: "CME", priceSymbol: "HE=F" },
  "061641": { exchange: "CME", priceSymbol: "GF=F" },
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
export function cotPriceMapping(code: string) { return Object.values(ROOTS).find((row) => row.code === code) ?? PRICE_OVERLAYS[code] ?? null; }
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
