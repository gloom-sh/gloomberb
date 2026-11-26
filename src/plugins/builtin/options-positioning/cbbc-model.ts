import type {
  HkCbbcSummary,
  HkCbbcZoneBucket,
} from "../../../api-client/hk-cbbc";
import { scalarPoint, staticSeries, type DataTableColumn } from "../../../components";
import type { ResolvedSeries } from "../../../time-series/types";
import { MISSING_VALUE, formatNumber } from "../../../utils/format";

export type CbbcViewTab = "zones" | "contracts" | "overview";

export const CBBC_TABS: readonly { value: CbbcViewTab; label: string }[] = [
  { value: "zones", label: "Knock-Out Map" },
  { value: "contracts", label: "Top Contracts" },
  { value: "overview", label: "HK Market" },
];

export const CBBC_QUICK_UNDERLYINGS: readonly { value: string; label: string }[] = [
  { value: "HSI", label: "HSI" },
  { value: "HSTEC", label: "HSTECH" },
  { value: "00700", label: "0700 Tencent" },
  { value: "09988", label: "9988 Alibaba" },
  { value: "01810", label: "1810 Xiaomi" },
  { value: "03690", label: "3690 Meituan" },
  { value: "01211", label: "1211 BYD" },
  { value: "00388", label: "0388 HKEX" },
  { value: "00005", label: "0005 HSBC" },
  { value: "00981", label: "0981 SMIC" },
];

export function fmtCbbcLevel(val: number | null | undefined, isIndex = true): string {
  if (val == null || !Number.isFinite(val)) return MISSING_VALUE;
  if (isIndex) return Math.round(val).toLocaleString("en-US");
  return val >= 100 ? formatNumber(val, 1) : formatNumber(val, 2);
}

export function fmtCbbcEquiv(
  val: number | null | undefined,
  isIndex: boolean,
): string {
  if (val == null || !Number.isFinite(val)) return MISSING_VALUE;
  const abs = Math.abs(val);
  if (isIndex) return `${Math.round(abs).toLocaleString("en-US")} fut`;
  if (abs >= 1e6) return `${formatNumber(abs / 1e6, 2)}M sh`;
  if (abs >= 1e3) return `${formatNumber(abs / 1e3, 1)}K sh`;
  return `${Math.round(abs).toLocaleString("en-US")} sh`;
}

export function fmtHkd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  if (value >= 1e9) return `HK$${formatNumber(value / 1e9, 2)}B`;
  if (value >= 1e6) return `HK$${formatNumber(value / 1e6, 1)}M`;
  if (value >= 1e3) return `HK$${formatNumber(value / 1e3, 0)}K`;
  return `HK$${Math.round(value)}`;
}

export function fmtDistPct(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return MISSING_VALUE;
  return `${val > 0 ? "+" : ""}${formatNumber(val, 1)}%`;
}

/**
 * Builds mirrored Bull (positive green) vs Bear (negative red) call-level street inventory
 * bars along a synthetic call-level axis for CompositeChart, with spot ratio marker.
 */
export function buildCbbcChartModel(
  summary: HkCbbcSummary,
  bullZones: readonly HkCbbcZoneBucket[],
  bearZones: readonly HkCbbcZoneBucket[],
  colors: { bull: string; bear: string },
): {
  series: ResolvedSeries[];
  orderedZones: HkCbbcZoneBucket[];
  spotRatio: number | null;
} {
  // Ordered low-to-high call level: deep bulls -> near bulls -> [SPOT] -> near bears -> high bears
  const bullsAsc = [...bullZones].slice(0, 10).reverse();
  const bearsAsc = [...bearZones].slice(0, 10);
  const orderedZones = [...bullsAsc, ...bearsAsc];
  if (orderedZones.length < 2) {
    return { series: [], orderedZones, spotRatio: null };
  }

  const baseMs = Date.UTC(2026, 0, 1);
  const slotDate = (idx: number) => new Date(baseMs + idx * 86_400_000);

  const metricOf = (z: HkCbbcZoneBucket) => z.equivFutures ?? z.equivUnits;
  const combinedPoints = orderedZones.map((z, idx) =>
    scalarPoint(slotDate(idx), z.direction === "bull" ? metricOf(z) : -metricOf(z)),
  );

  const spotRatio =
    bullsAsc.length > 0 && bearsAsc.length > 0
      ? (bullsAsc.length - 0.5) / Math.max(1, orderedZones.length - 1)
      : null;

  return {
    orderedZones,
    spotRatio,
    series: [
      staticSeries(combinedPoints, {
        id: "cbbc-street",
        label: summary.isIndex
          ? "Bull (+) / Bear (-) Street (fut)"
          : "Bull (+) / Bear (-) Street (sh)",
        color: colors.bull,
        negativeColor: colors.bear,
        style: "columns",
      }),
    ],
  };
}

export function cbbcZoneColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "zone", label: "Call Zone", width: 15, align: "left" },
    { id: "side", label: "Side", width: 6, align: "left" },
    { id: "dist", label: "Vs Spot", width: 9, align: "right" },
    { id: "equiv", label: "Street Equiv", width: 13, align: "right" },
    { id: "contracts", label: "Cts", width: 5, align: "right" },
  ];
  if (width >= 82) {
    cols.push({ id: "turnover", label: "Turnover", width: 11, align: "right" });
    cols.push({ id: "issuer", label: "Top Issuer", width: 14, align: "left" });
  }
  if (width >= 98) {
    cols.push({ id: "flag", label: "Kill Zone", width: 12, align: "left" });
  }
  return cols;
}

export function cbbcContractColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "code", label: "Code", width: 7, align: "left" },
    { id: "side", label: "Side", width: 6, align: "left" },
    { id: "call", label: "Call", width: 9, align: "right" },
    { id: "strike", label: "Strike", width: 9, align: "right" },
    { id: "outPct", label: "Out %", width: 7, align: "right" },
    { id: "equiv", label: "Street Equiv", width: 13, align: "right" },
  ];
  if (width >= 84) {
    cols.push({ id: "issuer", label: "Issuer", width: 14, align: "left" });
    cols.push({ id: "maturity", label: "Maturity", width: 11, align: "left" });
  }
  return cols;
}

export function cbbcOverviewColumns(width: number): DataTableColumn[] {
  const cols: DataTableColumn[] = [
    { id: "symbol", label: "Underlying", width: 10, align: "left" },
    { id: "name", label: "Name", width: width >= 96 ? 22 : 14, align: "left" },
    { id: "spot", label: "Spot", width: 9, align: "right" },
    { id: "bullPct", label: "Bull %", width: 8, align: "right" },
    { id: "heavyBull", label: "Heavy Bull", width: 12, align: "right" },
    { id: "heavyBear", label: "Heavy Bear", width: 12, align: "right" },
  ];
  if (width >= 96) {
    cols.push({ id: "turnover", label: "Turnover", width: 11, align: "right" });
  }
  return cols;
}
