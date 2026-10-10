import type { GpuBasis, GpuBoardRow, GpuEvent, GpuObservation } from "../../../api-client/gpu";
import { staticSeries } from "../../../components/chart/static/series";
import { SERIES_COLORS } from "../../../theme/series-colors";
import type { ResolvedSeries } from "../../../time-series/types";
import type { PricePoint } from "../../../types/financials";

export const GPU_TABS = [{ value: "board", label: "Board" }, { value: "history", label: "History" },
  { value: "changes", label: "Changes" }, { value: "equities", label: "Equities" }] as const;
export type GpuTab = typeof GPU_TABS[number]["value"];
export const gpuTab = (value: unknown): GpuTab => GPU_TABS.find((tab) => tab.value === value)?.value ?? "board";
export const GPU_MODELS = ["H100", "H200", "B200", "B300", "GB200", "GB300", "A100", "MI300X", "MI355X", "L40S", "RTX PRO 6000"];
export const gpuArgument = (value: string | null | undefined) => (value ?? "").trim().toUpperCase().replace(/\s+/g, " ");
export const gpuBasisLabel = (basis: GpuBasis, compact = false): string => compact
  ? ({ list: "List", spot: "Spot", ask: "Ask", reserved: "Rsvd", index: "Locked", reference: "Reference" })[basis]
  : ({ list: "List price", spot: "Provider-declared spot", ask: "Ask", reserved: "Reserved", index: "Index (licensed)", reference: "Reference" })[basis];
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
  !row.source.startsWith("ref-") && (row.providerClass === "aggregate" || row.source === "vast" || row.source === "vast-ai" || row.source === "akash");

/** Reference list entries come only from published history, never from our price basket. */
export function gpuReferenceRows(points: readonly GpuObservation[]): GpuBoardRow[] {
  const latest = new Map<string, GpuObservation>();
  for (const point of points) {
    if (point.provenance !== "reference" || point.basis !== "reference") continue;
    const id = `${point.source}:${point.skuKey}`;
    if (!latest.has(id) || point.observedAt > latest.get(id)!.observedAt) latest.set(id, point);
  }
  return [...latest].map(([id, point]) => ({ ...point, id, label: point.provider, sourceLabel: "Reference index (third party), anonymised",
    change1d: null, change7d: null, change30d: null, stale: false, lastError: null }));
}

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
/** Change windows with at least one figure; missing windows remain unavailable. */
export const gpuChangeWindows = (rows: readonly GpuBoardRow[]): GpuChangeKey[] =>
  (["change1d", "change7d", "change30d"] as const).filter((key) => rows.some((row) => row[key] != null));

/**
 * The series a board fetches history for: only the medians of the one model
 * shown, and only once some change figure exists. All GPUs, or no comparable
 * observation, fetches nothing; no board row ever fetches its own.
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
function gpuAxisTicks(low: number, high: number): number[] {
  if (!(high > low)) return [low];
  const raw = (high - low) / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= raw) ?? raw;
  const ticks: number[] = [];
  for (let tick = Math.floor(low / step) * step; tick <= high + step * 0.999; tick += step) ticks.push(Math.round(tick * 1000) / 1000);
  return ticks;
}

export interface GpuAxisLabel { value: number; text: string; ratio: number; start: number }

/**
 * Labels for a price axis `cells` wide over `low`..`high`: each centred on its
 * tick's own value, on the linear scale the bands and markers use (`ratio`, and
 * `start`, the first cell on the terminal), with the decimals the tick step
 * needs so neighbours never read alike ($2.0 $2.1 $2.2, $2.05 $2.10). A label
 * that would touch its neighbour or run past the room beside the axis is left
 * out, never moved off its value.
 */
export function gpuAxisLabels(low: number, high: number, cells: number, room: { left: number; right: number } = { left: 0, right: 0 }): GpuAxisLabel[] {
  const ticks = gpuAxisTicks(low, high).filter((tick) => tick >= low && tick <= high);
  const digits = [0, 1, 2, 3].find((places) => ticks.every((tick) => Math.abs(Number(tick.toFixed(places)) - tick) < 1e-9)) ?? 3;
  const labels: GpuAxisLabel[] = [];
  for (const value of ticks) {
    const text = `$${value.toFixed(digits)}`;
    const ratio = high > low ? (value - low) / (high - low) : 0.5;
    // The cell a track draws this value in, so the label's middle sits on the marker's cell.
    const start = Math.round(ratio * (cells - 1)) - Math.floor(text.length / 2);
    const previous = labels.at(-1);
    if (start < -room.left || start + text.length > cells + room.right || (previous && start <= previous.start + previous.text.length)) continue;
    labels.push({ value, text, ratio, start });
  }
  return labels;
}

/** Published notices use their effective date; observed changes use the dated evidence. */
export const gpuEventDate = (event: Pick<GpuEvent, "origin" | "effectiveAt" | "observedAt">) =>
  event.origin === "published" ? event.effectiveAt ?? event.observedAt : event.observedAt;

/** Price changes as a timeline: one section per UTC day, newest first, keeping the server's order within a day. */
export function gpuEventSections(events: readonly GpuEvent[]): { label: string; items: GpuEvent[] }[] {
  const days = new Map<string, GpuEvent[]>();
  for (const event of [...events].sort((a, b) => gpuEventDate(b).localeCompare(gpuEventDate(a)))) {
    const day = gpuEventDate(event).slice(0, 10);
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

/** Observations are dated by their evidence, never by a backdated effective-date label. */
export function gpuHistorySeries(row: GpuBoardRow, points: readonly GpuObservation[], color: string, archiveColor: string): ResolvedSeries[] {
  const own = points.filter((point) => `${point.source}:${point.skuKey}` === row.id).sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  if (own.length < 3) return [];
  const plotted = (observations: readonly GpuObservation[]) => observations.map((point) => ({
    date: new Date(point.observedAt), observedAt: new Date(point.observedAt), value: point.pricePerGpuHr,
  }));
  const unit = { unit: "$/GPU-hr", unitGroup: "gpu-rental-usd" };
  return [{ ...staticSeries(plotted(own), { id: "rental-price", label: `${gpuSource(row)} ${gpuBasisLabel(row.basis).toLowerCase()}`,
    color, style: "step", calendarSpaced: true }), ...unit, interpolation: "step-after" },
    ...([false, true] as const).flatMap((archived) => {
      const observations = own.filter((point) => (point.provenance === "archive") === archived);
      return observations.length ? [{ ...staticSeries(plotted(observations), { id: archived ? "archived-observations" : "observations",
        label: archived ? "Archived" : "Observations", color: archived ? archiveColor : color, style: "points", calendarSpaced: true }), ...unit }] : [];
    })];
}

/** The selected series has real-observation markers; peer medians retain their own step lines. */
export function gpuHistoryChart(rows: readonly GpuBoardRow[], points: readonly GpuObservation[],
  colors: { selected: string; marker: string }): ResolvedSeries[] {
  const lines: ResolvedSeries[] = [];
  const markers: ResolvedSeries[] = [];
  const others = [0, 1, 3, 4, 5] as const;
  rows.forEach((row, index) => {
    const reference = row.provenance === "reference";
    const color = reference ? row.source === "ref-a" ? "#879da5" : row.skuKey.endsWith("-hs") ? "#9daa8d" : "#a39ab0" : index === 0 ? colors.selected : SERIES_COLORS[others[(index - 1) % others.length]!];
    const [line, ...observations] = gpuHistorySeries(row, points, color, colors.marker);
    if (!line) return;
    const ambiguous = rows.some((other) => other.id !== row.id && gpuShortSource(other) === gpuShortSource(row));
    const name = ambiguous ? `${gpuShortSource(row)} ${gpuVariant(row).join(" ")}` : gpuShortSource(row);
    lines.push({ ...line, id: `rental-price:${row.id}`, label: reference ? `${name.replace("Reference index ", "")} (reference index, third party, anonymised)` : name });
    if (index === 0) markers.push(...observations.map((entry) => reference
      ? { ...entry, label: "Published readings", color } : entry));
  });
  return [...lines, ...markers];
}

/** Override the daily-chart minimum: no blank fortnight before the first evidence point. */
export function gpuHistoryViewport(series: readonly ResolvedSeries[]): { start: Date; end: Date } | undefined {
  let first = Infinity, last = -Infinity;
  for (const entry of series) for (const point of entry.points) {
    const time = point.date.getTime();
    if (point.value == null || !Number.isFinite(time)) continue;
    first = Math.min(first, time);
    last = Math.max(last, time);
  }
  if (!Number.isFinite(first)) return undefined;
  // Five percent on the right lets the latest marker breathe; never more than a day.
  const padding = Math.min(86_400_000, Math.max(60_000, (last - first) * 0.05));
  return { start: new Date(first), end: new Date(last + padding) };
}

export const gpuProvenanceLabel = (point: Pick<GpuObservation, "provenance">, full = false) =>
  point.provenance === "reference" ? full ? "Reference index (third party), anonymised" : "Reference"
    : point.provenance === "archive" ? full ? "archived page, reconstructed" : "Archived"
    : point.provenance === "official-history" ? full ? "official published history" : "Published" : full ? "live observation" : "Observed";

export interface GpuPricePeriod { from: string; to: string; price: number; change: number | null; provenance: GpuObservation["provenance"] }

/** Fold equal-price observations only within the same provenance. End at the last real observation. */
export function gpuPricePeriods(points: readonly Pick<GpuObservation, "observedAt" | "pricePerGpuHr" | "provenance">[]): GpuPricePeriod[] {
  const periods: GpuPricePeriod[] = [];
  for (const point of [...points].sort((a, b) => a.observedAt.localeCompare(b.observedAt))) {
    const last = periods.at(-1);
    const provenance = point.provenance ?? "live";
    if (last && Math.abs(last.price - point.pricePerGpuHr) < 1e-9 && last.provenance === provenance) {
      last.to = point.observedAt;
      continue;
    }
    if (last) last.to = point.observedAt;
    periods.push({ from: point.observedAt, to: point.observedAt, price: point.pricePerGpuHr, provenance,
      change: last ? (point.pricePerGpuHr / last.price - 1) * 100 : null });
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
