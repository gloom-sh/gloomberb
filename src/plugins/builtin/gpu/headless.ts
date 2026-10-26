import type { GpuObservation } from "../../../api-client/gpu";
import type { HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import { formatUtcTime, parseReportTime } from "../../../utils/utc-time";
import { fetchGpuBoard, fetchGpuEvents, fetchGpuHistory, fetchGpuModelPreviews, gpuPreviewModels, loadGpuEquityHistory } from "./client";
import {
  GPU_TABS, gpuBasisLabel, gpuChange, gpuChangesLocked, gpuEquityGap, gpuEquityModels, gpuEquityRows, gpuEventDate, gpuFamilies, gpuFamily,
  gpuLabel, gpuNoMatch, gpuPrice, gpuProvenanceLabel, gpuRows, gpuSource, gpuTab,
} from "./model";
import { quoteFreshnessFields } from "../shared/report-freshness";
import { countOf, freePreviewNote } from "../shared/free-preview";
import { getRegularSessionDisplay } from "../../../market-data/market/status";

const observationRow = (row: GpuObservation) => ({ gpu: gpuLabel(row), source: gpuSource(row), basis: gpuBasisLabel(row.basis),
  price: row.pricePerGpuHr, availability: row.availability, observedAt: row.observedAt, effectiveAt: row.effectiveAt, provenance: row.provenance ?? "live", provenanceLabel: gpuProvenanceLabel(row, true),
  sourceUrl: row.sourceUrl ?? null, evidenceUrl: row.evidenceUrl ?? null });
const percent = (value: unknown) => gpuChange(typeof value === "number" ? value : null);
/** Prices to the cent and times to the minute, as the pane draws them; exports keep the full value. */
const price = (value: unknown) => typeof value === "number" ? gpuPrice(value) : "-";
const DAY_MS = 86_400_000;
/** A reference index's daily figure is stamped at 00:00 UTC: that is a day, not a time to the minute. */
const minute = (value: unknown) => {
  if (typeof value !== "string") return "-";
  const time = parseReportTime(value);
  return time && !time.dateOnly && time.time % DAY_MS === 0 ? formatUtcTime({ ...time, dateOnly: true }) : formatUtcTime(value);
};
/** A move the free preview leaves to Pro says so, instead of reading as missing. */
const change = (value: unknown, row: HeadlessPaneRow) => row.changesLocked === true ? "Pro" : percent(value);
const columns = [
  { key: "gpu", header: "GPU" }, { key: "source", header: "Source" }, { key: "basis", header: "Basis" },
  { key: "price", header: "$/GPU-hr", align: "right" as const, format: price },
  { key: "change1d", header: "1D", align: "right" as const, format: change }, { key: "change7d", header: "7D", align: "right" as const, format: change },
  { key: "change30d", header: "30D", align: "right" as const, format: change }, { key: "availability", header: "Avail" },
  { key: "observedAt", header: "As of", format: minute },
];

export const gpuHeadless: HeadlessPaneDefinition<"bundle"> = {
  // Observed rental prices; the Equities tab's quotes keep their market line.
  shape: "bundle", freshness: { dataset: true }, argument: { kind: "free-text", optional: true, placeholder: "GPU", description: "GPU model, such as H100, h-100 or B200." },
  options: [{ key: "tab", type: "enum", values: GPU_TABS.map(({ value }) => ({ value })), defaultValue: "board", description: "Board, sourced history, dated changes or related equities." }],
  discovery: { aliases: ["GPU"], dataRequirements: ["GPU rental price observations"],
    limitations: ["List prices, provider-declared spot and asks are distinct bases.",
      "Hyperscaler and Neocloud rows are list indexes: the median of the providers' list prices linked over time, so a provider joining or leaving causes no jump; sample.rawMedian is the raw median of today's providers and can differ slightly.",
      "1D/7D/30D need sufficient observation history; unavailable changes remain null.",
      "Free preview: three board rows, or the latest rows of the GPU asked for; Pro unlocks every provider, the moves and the history."] },
  describe: "GPU rental prices in USD per GPU-hour",
  async load(args, ctx) {
    const argument = (Array.isArray(args.argument) ? args.argument.join(" ") : args.argument) ?? "";
    const tab = gpuTab(args.options.tab);
    const board = await fetchGpuBoard(ctx.apiClient);
    const families = gpuFamilies(board.rows);
    const model = argument.trim() ? gpuFamily(argument, families) : "";
    if (model === null) throw new Error(gpuNoMatch(argument, families));
    const metadata = { asOf: board.asOf, stale: board.stale, complete: board.status === "available" && !board.access?.locked, unit: "USD/GPU-hour", access: board.access,
      methodology: "docs/gpu-rental-prices.md#list-indexes" };
    // Prices observed on providers' pages, not a feed; each board row says whether its source has gone quiet.
    const freshness = { source: "GPU cloud providers", status: "not-a-feed" as const, basis: "observed prices" };
    if (tab === "history") {
      const history = await fetchGpuHistory({ ...(model ? { gpuModel: model } : {}), limit: 10_000 }, ctx.apiClient);
      return { sections: [{ title: "Dated observations", columns: [...columns.filter((column) => !column.key.startsWith("change")), { key: "provenanceLabel", header: "Record" }], rows: history.points.map(observationRow),
        empty: history.access?.locked ? "Full history is available with Pro." : `No ${model || "GPU"} observations yet.` }],
      freshness: { ...freshness, oldest: null }, complete: !history.access?.locked, metadata: { ...metadata, access: history.access ?? board.access }, errors: board.gaps };
    }
    if (tab === "changes") {
      const payload = await fetchGpuEvents(model || undefined, ctx.apiClient);
      return { sections: [{ title: "Price, availability and membership changes", columns: [
        { key: "date", header: "Date", format: minute }, { key: "gpu", header: "GPU" }, { key: "source", header: "Source" }, { key: "basis", header: "Basis" },
        { key: "oldPrice", header: "Old $/GPU-hr", align: "right" as const, format: price }, { key: "newPrice", header: "New $/GPU-hr", align: "right" as const, format: price },
        { key: "changePct", header: "Change", align: "right" as const, format: percent }, { key: "kind", header: "Event" }, { key: "provenanceLabel", header: "Record" },
        { key: "oldAvailability", header: "Old availability" }, { key: "newAvailability", header: "New availability" },
      ], rows: payload.events.map((event) => ({ date: gpuEventDate(event), observedAt: event.observedAt,
        effectiveAt: event.effectiveAt, origin: event.origin ?? "observed", gpu: gpuLabel(event), source: gpuSource(event), basis: gpuBasisLabel(event.basis),
        oldPrice: event.oldPrice, newPrice: event.newPrice, changePct: event.changePct, kind: event.kind,
        oldMembers: event.oldMembers, newMembers: event.newMembers, provenance: event.provenance ?? "live",
        provenanceLabel: gpuProvenanceLabel(event, true), evidenceUrl: event.evidenceUrl ?? null, sourceUrl: event.sourceUrl ?? null,
        oldAvailability: event.oldAvailability ?? null, newAvailability: event.newAvailability ?? null })),
      empty: payload.access?.locked ? "Full change history is available with Pro." : "No price or availability changes recorded yet." }],
      freshness: { ...freshness, oldest: null }, complete: !payload.access?.locked, metadata: { ...metadata, access: payload.access ?? board.access }, errors: board.gaps };
    }
    const selected = tab === "equities" ? model || "H100" : model;
    const previews = await fetchGpuModelPreviews(gpuPreviewModels(board, tab === "equities" ? gpuEquityModels(selected) : [selected]), ctx.apiClient);
    const rows = [...board.rows, ...previews];
    const previewed = [...new Set(previews.map((row) => row.gpuModel))];
    // What the free view leaves to Pro is the report's Pro line, never a note or an error.
    const locks = previewed.length
      ? [freePreviewNote({ shows: `the latest rows of ${previewed.join(" and ")}, which the free board leaves out`, adds: "every provider and the 1D, 7D and 30D moves" })]
      : board.access?.locked && !model && tab === "board"
        ? [freePreviewNote({ shows: `${countOf(board.rows.length, "board row")}, or the latest rows of a GPU you name (GPU H100)`, adds: "every GPU and provider, with the 1D, 7D and 30D moves" })]
        : [];
    if (tab === "equities") {
      const related = gpuEquityRows(rows, selected, !!board.access?.locked);
      const histories = await loadGpuEquityHistory(ctx.marketData);
      const equities = await Promise.all(related.map(async (row) => {
        const quote = await ctx.marketData.getQuote(row.symbol, row.exchange).catch(() => null);
        const history = histories.find((entry) => entry.symbol === row.symbol);
        // The regular session's last and move, as the pane's board shows them.
        const headline = getRegularSessionDisplay(quote);
        const reference = row.reference;
        return { symbol: row.symbol, role: row.role, price: headline?.price ?? null, change1d: headline?.changePercent ?? null,
          change5d: history?.value ?? null, fiveDayAsOf: history?.asOf ?? null, quoteAsOf: quote?.lastUpdated ? new Date(quote.lastUpdated).toISOString() : null,
          ...quoteFreshnessFields(quote),
          gpu: reference ? gpuLabel(reference) : row.gpuModel, gpuSource: reference ? gpuSource(reference) : null, gpuPrice: reference?.pricePerGpuHr ?? null,
          gpuChange7d: reference?.change7d ?? null, gpuLocked: row.gap === "pro" || (!!reference && gpuChangesLocked(reference)), gpuGap: gpuEquityGap(row) };
      }));
      const locked = (value: unknown, row: HeadlessPaneRow, show: (value: unknown) => string) => value == null && row.gpuLocked === true ? "Pro" : show(value);
      return { sections: [{ title: "Related equities", columns: [
        { key: "symbol", header: "Ticker" }, { key: "role", header: "Related through" }, { key: "price", header: "Last $", align: "right" as const, format: price },
        { key: "change1d", header: "1D", align: "right" as const, format: percent }, { key: "change5d", header: "5D", align: "right" as const, format: percent },
        { key: "gpu", header: "GPU" }, { key: "gpuSource", header: "GPU list series", format: (value: unknown, row: HeadlessPaneRow) => typeof value === "string" ? value : String(row.gpuGap ?? "-") },
        { key: "gpuPrice", header: "$/GPU-hr", align: "right" as const, format: (value: unknown, row: HeadlessPaneRow) => locked(value, row, price) },
        { key: "gpuChange7d", header: "GPU 7D", align: "right" as const, format: (value: unknown, row: HeadlessPaneRow) => locked(value, row, percent) },
      ], rows: equities }], complete: !board.access?.locked, metadata, errors: [...locks, ...board.gaps, ...histories.flatMap((entry) => entry.error ? [entry.error] : [])],
      unavailableSymbols: equities.filter((row) => row.price == null || row.change5d == null).map((row) => row.symbol) };
    }
    const boardRows = gpuRows(rows, model).map((row) => ({ ...observationRow(row), change1d: row.change1d, change7d: row.change7d,
      change30d: row.change30d, stale: row.stale, sample: row.stats ?? null, ...(gpuChangesLocked(row) ? { changesLocked: true } : {}) }));
    return { sections: [{ title: "GPU rental prices", columns, rows: boardRows, empty: `No ${model ? `${model} ` : ""}rental prices have been observed yet.` }],
      freshness, complete: !board.access?.locked, metadata, errors: [...locks, ...board.gaps] };
  },
};
