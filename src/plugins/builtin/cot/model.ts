import type { CotClass, CotClassSummary, CotContractPayload, CotFamily, CotHistoryPoint } from "../../../api-client/cot";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";

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
export function cotContractCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const input = value.trim().toUpperCase().replace(/=F$/, "");
  return ROOTS[input === "VIX" ? "VX" : input]?.code ?? (/^[0-9A-Z]{5}[0-9A-Z+]$/.test(input) ? input : null);
}
export function cotPriceMapping(code: string) { return Object.values(ROOTS).find((row) => row.code === code) ?? null; }
export function cotClass(family: CotFamily, value: unknown): CotClass {
  return COT_CLASSES[family].find((row) => row.value === value)?.value ?? COT_CLASSES[family][0]!.value;
}
export function cotInteger(value: number | null, signed = false): string {
  return value == null ? "--" : `${signed && value > 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
export function cotRank(position: CotClassSummary, years: 1 | 3): string {
  const rank = years === 1 ? position.percentile1Y : position.percentile3Y;
  return `${rank.value == null ? "--" : rank.value.toFixed(0)} pctl ${years}Y · ${rank.sampleCount} obs${rank.completeWindow ? "" : " · partial"}`;
}

/** Add explicit gaps so absent weeks are not silently joined across a release gap. */
export function cotNetPoints(history: readonly CotHistoryPoint[], traderClass: CotClass) {
  const points: Array<{ date: Date; observedAt: Date; value: number | null }> = [];
  let previous: number | null = null;
  for (const row of history) {
    const time = Date.parse(row.reportDate);
    if (previous != null && time - previous > 7 * 86_400_000) {
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
