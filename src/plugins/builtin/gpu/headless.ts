import type { GpuObservation } from "../../../api-client/gpu";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchGpuBoard, fetchGpuEvents, fetchGpuHistory, loadGpuEquityHistory } from "./client";
import { GPU_TABS, gpuArgument, gpuBasisLabel, gpuChange, gpuEquityRows, gpuEventDate, gpuProvenanceLabel, gpuLabel, gpuRows, gpuSource, gpuTab } from "./model";
import { quoteFreshnessFields } from "../shared/report-freshness";
import { getRegularSessionDisplay } from "../../../market-data/market/status";

const observationRow = (row: GpuObservation) => ({ gpu: gpuLabel(row), source: gpuSource(row), basis: gpuBasisLabel(row.basis),
  price: row.pricePerGpuHr, availability: row.availability, observedAt: row.observedAt, effectiveAt: row.effectiveAt, provenance: row.provenance ?? "live", provenanceLabel: gpuProvenanceLabel(row, true),
  sourceUrl: row.sourceUrl ?? null, evidenceUrl: row.evidenceUrl ?? null });
const percent = (value: unknown) => gpuChange(typeof value === "number" ? value : null);
const columns = [
  { key: "gpu", header: "GPU" }, { key: "source", header: "Source" }, { key: "basis", header: "Basis" },
  { key: "price", header: "$/GPU-hr", align: "right" as const },
  { key: "change1d", header: "1D", align: "right" as const, format: percent }, { key: "change7d", header: "7D", align: "right" as const, format: percent },
  { key: "change30d", header: "30D", align: "right" as const, format: percent }, { key: "availability", header: "Avail" }, { key: "observedAt", header: "As of" },
];

export const gpuHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "GPU", description: "GPU model, such as H100 or B200." },
  options: [{ key: "tab", type: "enum", values: GPU_TABS.map(({ value }) => ({ value })), defaultValue: "board", description: "Board, sourced history, dated changes or related equities." }],
  discovery: { aliases: ["GPU"], dataRequirements: ["GPU rental price observations"],
    limitations: ["List prices, provider-declared spot and asks are distinct bases",
      "Hyperscaler and Neocloud rows are list indexes: the median of the providers' list prices linked over time, so a provider joining or leaving causes no jump; sample.rawMedian is the raw median of today's providers and can differ slightly",
      "1D/7D/30D need sufficient observation history; unavailable changes remain null"] },
  describe: "GPU rental prices in USD per GPU-hour",
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
    const model = gpuArgument(argument);
    const tab = gpuTab(args.options.tab);
    const board = await fetchGpuBoard(ctx.apiClient);
    const metadata = { asOf: board.asOf, stale: board.stale, complete: board.status === "available" && !board.access?.locked, unit: "USD/GPU-hour", access: board.access,
      methodology: "docs/gpu-rental-prices.md#list-indexes" };
    // Prices observed on providers' pages, not a feed; each board row says whether its source has gone quiet.
    const freshness = { source: "GPU cloud providers", status: "not-a-feed" as const, basis: "observed prices" };
    if (tab === "history") {
      const history = await fetchGpuHistory({ ...(model ? { gpuModel: model } : {}), limit: 10_000 }, ctx.apiClient);
      return { sections: [{ title: "Dated observations", columns: [...columns.filter((column) => !column.key.startsWith("change")), { key: "provenanceLabel", header: "Record" }], rows: history.points.map(observationRow) }], freshness: { ...freshness, oldest: null }, complete: !history.access?.locked, metadata: { ...metadata, access: history.access ?? board.access }, errors: board.gaps };
    }
    if (tab === "changes") {
      const payload = await fetchGpuEvents(model || undefined, ctx.apiClient);
      return { sections: [{ title: "Price, availability and membership changes", columns: [
        { key: "date", header: "Date" }, { key: "gpu", header: "GPU" }, { key: "source", header: "Source" }, { key: "basis", header: "Basis" },
        { key: "oldPrice", header: "Old $/GPU-hr" }, { key: "newPrice", header: "New $/GPU-hr" }, { key: "changePct", header: "Change", format: percent }, { key: "kind", header: "Event" }, { key: "provenanceLabel", header: "Record" },
        { key: "oldAvailability", header: "Old availability" }, { key: "newAvailability", header: "New availability" },
      ], rows: payload.events.map((event) => ({ date: gpuEventDate(event), observedAt: event.observedAt,
        effectiveAt: event.effectiveAt, origin: event.origin ?? "observed", gpu: gpuLabel(event), source: gpuSource(event), basis: gpuBasisLabel(event.basis),
        oldPrice: event.oldPrice, newPrice: event.newPrice, changePct: event.changePct, kind: event.kind,
        oldMembers: event.oldMembers, newMembers: event.newMembers, provenance: event.provenance ?? "live",
        provenanceLabel: gpuProvenanceLabel(event, true), evidenceUrl: event.evidenceUrl ?? null, sourceUrl: event.sourceUrl ?? null,
        oldAvailability: event.oldAvailability ?? null, newAvailability: event.newAvailability ?? null })) }], freshness: { ...freshness, oldest: null }, complete: !payload.access?.locked, metadata: { ...metadata, access: payload.access ?? board.access }, errors: board.gaps };
    }
    if (tab === "equities") {
      const related = gpuEquityRows(board.rows, model || "H100");
      const histories = await loadGpuEquityHistory(ctx.marketData);
      const rows = await Promise.all(related.map(async (row) => {
        const quote = await ctx.marketData.getQuote(row.symbol, row.exchange).catch(() => null);
        const history = histories.find((entry) => entry.symbol === row.symbol);
        // The regular session's last and move, as the pane's board shows them.
        const headline = getRegularSessionDisplay(quote);
        return { symbol: row.symbol, role: row.role, price: headline?.price ?? null, change1d: headline?.changePercent ?? null,
          change5d: history?.value ?? null, fiveDayAsOf: history?.asOf ?? null, quoteAsOf: quote?.lastUpdated ? new Date(quote.lastUpdated).toISOString() : null,
          ...quoteFreshnessFields(quote),
          gpu: row.reference ? gpuLabel(row.reference) : row.gpuModel, gpuSource: row.reference ? gpuSource(row.reference) : null, gpuChange7d: row.reference?.change7d ?? null };
      }));
      return { sections: [{ title: "Related equities", columns: [
        { key: "symbol", header: "Ticker" }, { key: "role", header: "Related through" }, { key: "price", header: "Last $" },
        { key: "change1d", header: "1D", format: percent }, { key: "change5d", header: "5D", format: percent },
        { key: "gpu", header: "GPU" }, { key: "gpuSource", header: "GPU list series" }, { key: "gpuChange7d", header: "GPU 7D", format: percent },
      ], rows }], complete: !board.access?.locked, metadata, errors: [...board.gaps, ...histories.flatMap((entry) => entry.error ? [entry.error] : [])],
      unavailableSymbols: rows.filter((row) => row.price == null || row.change5d == null).map((row) => row.symbol) };
    }
    const rows = gpuRows(board.rows, model).map((row) => ({ ...observationRow(row), change1d: row.change1d, change7d: row.change7d,
      change30d: row.change30d, stale: row.stale, sample: row.stats ?? null }));
    return { sections: [{ title: "GPU rental prices", columns, rows }], freshness, complete: !board.access?.locked, metadata, errors: board.gaps };
  },
};
