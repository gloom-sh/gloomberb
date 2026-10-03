import type { GpuBasis, GpuBoardRow, GpuEvent, GpuObservation } from "../../../api-client/gpu";
import { staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";

export const GPU_TABS = [{ value: "board", label: "Board" }, { value: "history", label: "History" },
  { value: "changes", label: "Changes" }, { value: "equities", label: "Equities" }] as const;
export type GpuTab = typeof GPU_TABS[number]["value"];
export const gpuTab = (value: unknown): GpuTab => GPU_TABS.find((tab) => tab.value === value)?.value ?? "board";
export const GPU_MODELS = ["H100", "H200", "B200", "B300", "GB200", "GB300", "A100", "MI300X", "MI355X", "L40S", "RTX PRO 6000"];
export const gpuArgument = (value: string | null | undefined) => (value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
export const gpuBasisLabel = (basis: GpuBasis, compact = false): string => compact
  ? ({ list: "List", spot: "Spot", ask: "Ask", reserved: "Rsvd", index: "Locked" })[basis]
  : ({ list: "List price", spot: "Provider-declared spot", ask: "Ask", reserved: "Reserved", index: "Index (licensed)" })[basis];
export const gpuPrice = (value: number | null | undefined) => value == null ? "-" : value.toFixed(2);
export function gpuChange(value: number | null | undefined): string {
  if (value == null) return "-";
  const rounded = Math.round(Math.abs(value) * 10) / 10;
  return `${rounded === 0 ? "" : value > 0 ? "+" : "-"}${rounded.toFixed(1)}%`;
}
export const gpuLabel = (row: Pick<GpuObservation, "gpuModel" | "memoryGb" | "formFactor">) =>
  [row.gpuModel, row.memoryGb ? `${row.memoryGb}GB` : null, row.formFactor].filter(Boolean).join(" ");

const PROVIDER_NAMES: Record<string, string> = {
  aws: "AWS", azure: "Azure", gcp: "GCP", oci: "OCI", lambdalabs: "Lambda", lambda: "Lambda",
  coreweave: "CoreWeave", digitalocean: "DigitalOcean", nebius: "Nebius", voltagepark: "Voltage Park",
  massedcompute: "Massed Compute", paperspace: "Paperspace", hyperstack: "Hyperstack", denvr: "Denvr",
  scaleway: "Scaleway", horizon: "Horizon", verda: "Verda", latitude: "Latitude", imwt: "IMWT",
};

/** Cloud operators are the product being compared. The data collection intermediary stays invisible. */
export function gpuSource(row: Pick<GpuObservation, "source" | "provider" | "skuKey">): string {
  if (row.source === "vast" || row.source === "vast-ai") return "Marketplace ask median";
  if (row.source === "akash") return "Decentralized ask median";
  if (row.source === "runpod") return /community/i.test(`${row.provider} ${row.skuKey}`) ? "Community cloud asks" : "Secure cloud asks";
  return PROVIDER_NAMES[row.provider.toLowerCase()] ?? row.provider;
}

export function gpuTime(value: string | null | undefined, compact = false): string {
  if (!value) return "-";
  const date = new Date(value);
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const time = date.toISOString().slice(11, 16);
  return compact ? `${day} ${time}` : `${day}, ${date.getUTCFullYear()} ${time} UTC`;
}

export function gpuRows(rows: readonly GpuBoardRow[], model = "", basis = "all"): GpuBoardRow[] {
  const rank = (row: GpuBoardRow) => row.providerClass === "aggregate" ? 0 : row.basis === "list" ? 1 : row.basis === "spot" ? 2 : row.basis === "reserved" ? 3 : 4;
  return rows.filter((row) => (!model || row.gpuModel === model) && (basis === "all" || row.basis === basis)).sort((a, b) => {
    const modelRank = (name: string) => GPU_MODELS.indexOf(name) < 0 ? 99 : GPU_MODELS.indexOf(name);
    return modelRank(a.gpuModel) - modelRank(b.gpuModel) || a.gpuModel.localeCompare(b.gpuModel) || rank(a) - rank(b)
      || gpuSource(a).localeCompare(gpuSource(b)) || (b.memoryGb ?? 0) - (a.memoryGb ?? 0) || (a.formFactor ?? "").localeCompare(b.formFactor ?? "");
  });
}

export const gpuSeriesLabel = (row: GpuObservation, compact = false) => `${gpuLabel(row)} / ${compact ? gpuSource(row).replace(" list median", " median") : gpuSource(row)} / ${gpuBasisLabel(row.basis, compact)}`;
export const gpuRowId = (row: GpuBoardRow) => row.id;
export const gpuMatches = (row: GpuBoardRow, query: string) => query.split(/\s+/).every((part) => gpuSeriesLabel(row).toLowerCase().includes(part));

/** Observation timestamps alone draw the line. Publisher effective dates never invent a past snapshot. */
export function gpuHistorySeries(row: GpuBoardRow, points: readonly GpuObservation[], events: readonly GpuEvent[], color: string, markerColor: string): ResolvedSeries[] {
  const own = points.filter((point) => `${point.source}:${point.skuKey}` === row.id).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  if (own.length < 3) return [];
  const line: ResolvedSeries = {
    ...staticSeries(own.map((point) => ({ date: new Date(point.observedAt), observedAt: new Date(point.observedAt), value: point.pricePerGpuHr })),
      { id: "rental-price", label: `${gpuSource(row)} ${gpuBasisLabel(row.basis).toLowerCase()}`, color, style: "step", calendarSpaced: true }),
    unit: "$/GPU-hr", unitGroup: "gpu-rental-usd", interpolation: "step-after",
  };
  const markerDate = (event: GpuEvent) => event.origin === "published" ? event.effectiveAt ?? event.observedAt : event.observedAt;
  const markers = events.filter((event) => event.kind === "price" && event.basis === "list"
    && `${event.source}:${event.skuKey}` === row.id && markerDate(event) >= own[0]!.observedAt && markerDate(event) <= own.at(-1)!.observedAt);
  return [line, ...(markers.length ? [{ ...staticSeries(markers.map((event) => ({ date: new Date(markerDate(event)), observedAt: new Date(event.observedAt), value: event.newPrice })),
    { id: "price-changes", label: "List-price changes", color: markerColor, style: "points", calendarSpaced: true }), unit: "$/GPU-hr", unitGroup: "gpu-rental-usd" }] : [])];
}

export const GPU_EQUITIES = [
  { symbol: "NVDA", exchange: "NASDAQ", role: "Chips" }, { symbol: "AMD", exchange: "NASDAQ", role: "Chips" },
  { symbol: "AMZN", exchange: "NASDAQ", role: "Cloud", provider: "AWS" }, { symbol: "MSFT", exchange: "NASDAQ", role: "Cloud", provider: "Azure" },
  { symbol: "GOOGL", exchange: "NASDAQ", role: "Cloud", provider: "GCP" }, { symbol: "ORCL", exchange: "NYSE", role: "Cloud", provider: "OCI" },
  { symbol: "CRWV", exchange: "NASDAQ", role: "Cloud", provider: "CoreWeave" }, { symbol: "NBIS", exchange: "NASDAQ", role: "Cloud", provider: "Nebius" },
  { symbol: "DOCN", exchange: "NYSE", role: "Cloud", provider: "DigitalOcean" }, { symbol: "IREN", exchange: "NASDAQ", role: "Host" },
  { symbol: "APLD", exchange: "NASDAQ", role: "Host" }, { symbol: "CIFR", exchange: "NASDAQ", role: "Host" },
  { symbol: "WULF", exchange: "NASDAQ", role: "Host" }, { symbol: "SMCI", exchange: "NASDAQ", role: "Hardware" },
  { symbol: "DELL", exchange: "NYSE", role: "Hardware" }, { symbol: "AVGO", exchange: "NASDAQ", role: "Hardware" },
] as const;

export function gpuEquityRows(rows: readonly GpuBoardRow[], selectedModel: string) {
  return GPU_EQUITIES.map((equity) => {
    const model = equity.symbol === "AMD" && !selectedModel.startsWith("MI") ? "MI300X"
      : equity.symbol === "NVDA" && selectedModel.startsWith("MI") ? "H100" : selectedModel;
    const candidates = gpuRows(rows, model, "list");
    const aggregates = candidates.filter((row) => row.providerClass === "aggregate").sort((a, b) =>
      Number(b.formFactor === "SXM") - Number(a.formFactor === "SXM") || (b.stats?.n ?? 0) - (a.stats?.n ?? 0) || (b.memoryGb ?? 0) - (a.memoryGb ?? 0));
    const reference = "provider" in equity ? candidates.find((row) => gpuSource(row) === equity.provider)
      : aggregates.find((row) => row.provider === "Neocloud list median") ?? aggregates[0];
    return { ...equity, gpuModel: model, reference: reference ?? null };
  });
}

export function equityFiveDayReturn(history: readonly PricePoint[]): { value: number | null; asOf: string | null } {
  const dates = new Map<string, { time: number; close: number }>();
  for (const point of history) {
    const time = new Date(point.date).getTime();
    if (Number.isFinite(time) && Number.isFinite(point.close) && point.close > 0) {
      const day = new Date(time).toISOString().slice(0, 10);
      if (time >= (dates.get(day)?.time ?? -Infinity)) dates.set(day, { time, close: point.close });
    }
  }
  const ordered = [...dates].sort(([a], [b]) => a.localeCompare(b));
  const latest = ordered.at(-1);
  const previous = ordered.at(-6);
  // Six sessions spanning more than two weeks indicate a gap, not a five-day return.
  return { value: latest && previous && Date.parse(latest[0]) - Date.parse(previous[0]) <= 14 * 86_400_000
    ? (latest[1].close / previous[1].close - 1) * 100 : null, asOf: latest?.[0] ?? null };
}
