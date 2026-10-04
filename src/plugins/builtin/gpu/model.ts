import type { GpuBasis, GpuBoardRow, GpuEvent, GpuObservation } from "../../../api-client/gpu";
import { staticSeries } from "../../../components/chart/static/series";
import { SERIES_COLORS } from "../../../time-series/resolve";
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
/** A move's colour; an unchanged rate reads quiet rather than as a figure. */
export const gpuChangeColor = (value: number, colors: { positive: string; negative: string; textMuted: string }) =>
  Math.round(Math.abs(value) * 10) === 0 ? colors.textMuted : value > 0 ? colors.positive : colors.negative;
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

/** A source inside its basis section: the section already says list or ask, so a median drops the word. */
export const gpuShortSource = (row: Pick<GpuObservation, "source" | "provider" | "skuKey">) => gpuSource(row).replace(/ (?:list|ask) median$/, " median");

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

/** The bases in board order. The licensed index never reaches the board. */
const GPU_BASES = ["list", "spot", "reserved", "ask"] as const satisfies readonly GpuBasis[];
const basisRank = (basis: GpuBasis) => { const index = (GPU_BASES as readonly GpuBasis[]).indexOf(basis); return index < 0 ? GPU_BASES.length : index; };

/** One colour per basis from the shared series palette, the same in the ladder, the chart and the table. */
export function gpuBasisColor(basis: GpuBasis): string {
  return SERIES_COLORS[basis === "list" ? 0 : basis === "spot" ? 1 : basis === "ask" ? 2 : 3];
}

/** Hardware variant chips: form factor, then memory. */
export const gpuVariant = (row: Pick<GpuObservation, "formFactor" | "memoryGb">): string[] =>
  [row.formFactor, row.memoryGb ? `${row.memoryGb}GB` : null].filter((part): part is string => !!part);

/** Medians lead their section: provider-class medians and the marketplace offer medians. */
export const gpuHeadline = (row: Pick<GpuObservation, "providerClass" | "source">) =>
  row.providerClass === "aggregate" || row.source === "vast" || row.source === "vast-ai" || row.source === "akash";

export interface GpuBoardSection { id: string; label: string; basis: GpuBasis; gpuModel: string; rows: GpuBoardRow[] }

/**
 * The board grouped by model, then basis, medians first. One model reads its
 * sections by basis alone; every model names the model in each heading.
 */
export function gpuBoardSections(rows: readonly GpuBoardRow[], model = ""): GpuBoardSection[] {
  const modelRank = (name: string) => GPU_MODELS.indexOf(name) < 0 ? 99 : GPU_MODELS.indexOf(name);
  const ordered = rows.filter((row) => (!model || row.gpuModel === model) && row.basis !== "index").sort((a, b) =>
    modelRank(a.gpuModel) - modelRank(b.gpuModel) || a.gpuModel.localeCompare(b.gpuModel) || basisRank(a.basis) - basisRank(b.basis)
    || Number(gpuHeadline(b)) - Number(gpuHeadline(a)) || gpuSource(a).localeCompare(gpuSource(b))
    || (b.memoryGb ?? 0) - (a.memoryGb ?? 0) || (a.formFactor ?? "").localeCompare(b.formFactor ?? ""));
  const sections: GpuBoardSection[] = [];
  for (const row of ordered) {
    const id = `${row.gpuModel}:${row.basis}`;
    const last = sections.at(-1);
    if (last?.id === id) last.rows.push(row);
    else sections.push({ id, basis: row.basis, gpuModel: row.gpuModel, rows: [row],
      label: model ? gpuBasisLabel(row.basis) : `${row.gpuModel} ${gpuBasisLabel(row.basis)}` });
  }
  return sections;
}

export type GpuChangeKey = "change1d" | "change7d" | "change30d";
/** Change windows with at least one figure; none means the history is too young and the board says "new". */
export const gpuChangeWindows = (rows: readonly GpuBoardRow[]): GpuChangeKey[] =>
  (["change1d", "change7d", "change30d"] as const).filter((key) => rows.some((row) => row[key] != null));

/**
 * The series a board fetches history for: only the medians of the one model
 * shown, and only once some change figure exists. All GPUs, or a history
 * younger than a day, fetches nothing; no board row ever fetches its own.
 */
export function gpuSparklineSeries(rows: readonly GpuBoardRow[], model: string): string[] {
  if (!model) return [];
  const modelRows = rows.filter((row) => row.gpuModel === model);
  return gpuChangeWindows(modelRows).length ? modelRows.filter(gpuHeadline).map((row) => row.id) : [];
}

export interface GpuLadderRow { basis: GpuBasis; n: number; min: number; p25: number; median: number; p75: number; max: number }

function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q;
  const low = Math.floor(at), high = Math.ceil(at);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/**
 * One model's prices per basis: range, quartiles and median over the quotes
 * the board lists. Provider-class medians are left out: their constituents
 * are already rows, and counting both would weigh those providers twice.
 */
export function gpuPriceLadder(rows: readonly GpuBoardRow[], model: string): GpuLadderRow[] {
  return GPU_BASES.flatMap((basis) => {
    const prices = rows.filter((row) => row.gpuModel === model && row.basis === basis && row.providerClass !== "aggregate")
      .map((row) => row.pricePerGpuHr).sort((a, b) => a - b);
    return prices.length ? [{ basis, n: prices.length, min: prices[0]!, max: prices.at(-1)!,
      p25: quantile(prices, 0.25), median: quantile(prices, 0.5), p75: quantile(prices, 0.75) }] : [];
  });
}

/** Round dollar ticks for a price axis: one, two or five times a power of ten, four to six of them. */
export function gpuAxisTicks(low: number, high: number): number[] {
  if (!(high > low)) return [low];
  const raw = (high - low) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let tick = Math.floor(low / step) * step; tick <= high + step * 0.999; tick += step) ticks.push(Math.round(tick * 1000) / 1000);
  return ticks;
}

/** The day a change belongs to: the publisher's effective date when there is one, else when Gloom saw it. */
const gpuEventDate = (event: Pick<GpuEvent, "effectiveAt" | "observedAt">) => (event.effectiveAt ?? event.observedAt).slice(0, 10);

/** Price changes as a timeline: one section per UTC day, newest first, keeping the server's order within a day. */
export function gpuEventSections(events: readonly GpuEvent[]): { label: string; items: GpuEvent[] }[] {
  const days = new Map<string, GpuEvent[]>();
  for (const event of [...events].sort((a, b) => gpuEventDate(b).localeCompare(gpuEventDate(a)))) {
    const day = gpuEventDate(event);
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  return [...days].map(([day, items]) => ({ label: new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US",
    { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }), items }));
}

export interface GpuAvailability { label: string; tone: "positive" | "warning" | "muted" }
/** A provider's capacity note as a short word and a tone, for a status dot. */
export function gpuAvailability(text: string | null | undefined): GpuAvailability | null {
  const value = text?.trim();
  if (!value) return null;
  const pooled = value.match(/^pooled:\s*(\w+)/i)?.[1]?.toLowerCase();
  if (pooled) return { label: pooled, tone: pooled === "low" ? "warning" : pooled === "none" ? "muted" : "positive" };
  if (/^unavailable$/i.test(value) || /^0\s/.test(value)) return { label: value.toLowerCase(), tone: "muted" };
  const offers = value.match(/^(\d+)\s+rentable offers?$/i);
  if (offers) return { label: `${offers[1]} offers`, tone: "positive" };
  return { label: value.toLowerCase().startsWith("available") ? "available" : value, tone: "positive" };
}

const gpuSeriesLabel = (row: GpuObservation) => `${gpuLabel(row)} / ${gpuSource(row)} / ${gpuBasisLabel(row.basis)}`;
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

/**
 * The History chart: the selected series and the medians beside it, each a
 * step line of its own observations, plus one marker series for list-price
 * changes on any of them. A series with fewer than three observations is left
 * out rather than drawn as a trend.
 */
export function gpuHistoryChart(rows: readonly GpuBoardRow[], points: readonly GpuObservation[], events: readonly GpuEvent[],
  colors: { selected: string; marker: string }): ResolvedSeries[] {
  const lines: ResolvedSeries[] = [];
  const markers: ResolvedSeries["points"] = [];
  const others = [0, 1, 3, 4, 5] as const;
  rows.forEach((row, index) => {
    const color = index === 0 ? colors.selected : SERIES_COLORS[others[(index - 1) % others.length]!];
    const [line, marker] = gpuHistorySeries(row, points, events, color, colors.marker);
    if (!line) return;
    const ambiguous = rows.some((other) => other.id !== row.id && gpuShortSource(other) === gpuShortSource(row));
    lines.push({ ...line, id: `rental-price:${row.id}`, label: ambiguous ? `${gpuShortSource(row)} ${gpuVariant(row).join(" ")}` : gpuShortSource(row) });
    if (marker) markers.push(...marker.points);
  });
  if (!lines.length || !markers.length) return lines;
  return [...lines, { ...staticSeries([...markers].sort((a, b) => a.date.getTime() - b.date.getTime()),
    { id: "price-changes", label: "List-price changes", color: colors.marker, style: "points", calendarSpaced: true }), unit: "$/GPU-hr", unitGroup: "gpu-rental-usd" }];
}

export interface GpuPricePeriod { from: string; to: string | null; price: number; change: number | null }

/** Observations folded into the spans a price held, newest first: hourly snapshots of an unchanged rate are one row. */
export function gpuPricePeriods(points: readonly Pick<GpuObservation, "observedAt" | "pricePerGpuHr">[]): GpuPricePeriod[] {
  const periods: GpuPricePeriod[] = [];
  for (const point of [...points].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    const last = periods.at(-1);
    if (last && Math.abs(last.price - point.pricePerGpuHr) < 1e-9) continue;
    if (last) last.to = point.observedAt;
    periods.push({ from: point.observedAt, to: null, price: point.pricePerGpuHr, change: last ? (point.pricePerGpuHr / last.price - 1) * 100 : null });
  }
  return periods.reverse();
}

export const GPU_EQUITIES = [
  { symbol: "NVDA", exchange: "NASDAQ", role: "Chips" }, { symbol: "AMD", exchange: "NASDAQ", role: "Chips" },
  { symbol: "AVGO", exchange: "NASDAQ", role: "Chips" },
  { symbol: "AMZN", exchange: "NASDAQ", role: "Hyperscaler", provider: "AWS" }, { symbol: "MSFT", exchange: "NASDAQ", role: "Hyperscaler", provider: "Azure" },
  { symbol: "GOOGL", exchange: "NASDAQ", role: "Hyperscaler", provider: "GCP" }, { symbol: "ORCL", exchange: "NYSE", role: "Hyperscaler", provider: "OCI" },
  { symbol: "CRWV", exchange: "NASDAQ", role: "Neocloud", provider: "CoreWeave" }, { symbol: "NBIS", exchange: "NASDAQ", role: "Neocloud", provider: "Nebius" },
  { symbol: "DOCN", exchange: "NYSE", role: "Neocloud", provider: "DigitalOcean" }, { symbol: "IREN", exchange: "NASDAQ", role: "Host" },
  { symbol: "APLD", exchange: "NASDAQ", role: "Host" }, { symbol: "CIFR", exchange: "NASDAQ", role: "Host" },
  { symbol: "WULF", exchange: "NASDAQ", role: "Host" }, { symbol: "SMCI", exchange: "NASDAQ", role: "Server builder" },
  { symbol: "DELL", exchange: "NYSE", role: "Server builder" },
] as const;

/** How the Equities tab groups the shares: who makes the chips, who rents them out, who hosts and builds the machines. */
export const GPU_EQUITY_GROUPS = [
  { label: "Chip makers", roles: ["Chips"] }, { label: "Hyperscalers", roles: ["Hyperscaler"] },
  { label: "Neoclouds", roles: ["Neocloud"] }, { label: "Hosts and builders", roles: ["Host", "Server builder"] },
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
