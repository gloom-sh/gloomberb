import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchTape } from "./client";
import { newestFirst, quoteSpread, tapeStatistics } from "./model";

export const timeSalesHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "ticker", placeholder: "ticker", description: "US equity ticker." },
  options: [{ key: "limit", type: "integer", minimum: 1, maximum: 1000, defaultValue: 100, description: "Maximum recent prints in the report." }],
  discovery: { aliases: ["TAS", "QR"], dataRequirements: ["Gloom Cloud SIP trade and quote feed"],
    limitations: ["Bounded observed window, not a complete session", "SIP is delayed fifteen minutes without realtime entitlement", "Quote sizes are round lots", "No Level 2 or inferred aggressor side"] },
  describe: (args) => `Time and sales ${args.argument ?? ""}`,
  async load(args, ctx) {
    const symbol = args.symbols[0] ?? (typeof args.argument === "string" ? args.argument : "");
    const instrument = await ctx.resolveInstrument?.(symbol);
    const data = await fetchTape(symbol, instrument?.exchange ?? "", ctx.signal, ctx.apiClient);
    const statistics = tapeStatistics(data);
    return { sections: [
      { title: "Observed window", rows: [{ from: statistics.from, asOf: statistics.asOf, prints: statistics.count, shares: statistics.volume,
        vwap: statistics.vwap, low: statistics.low, high: statistics.high, pricePercentile: statistics.pricePercentile }] },
      { title: "Regular session", rows: [data.session] },
      { title: "Trades", rows: newestFirst(data.trades).slice(0, Number(args.options.limit ?? 100)).map((row) => ({ ...row, conditions: row.conditions.join(" ") })) },
      { title: "NBBO", rows: newestFirst(data.quotes).slice(0, Number(args.options.limit ?? 100)).map((row) => ({ ...row, ...quoteSpread(row), conditions: row.conditions.join(" ") })) },
    ], errors: data.gaps, metadata: { source: data.source, feed: data.feed, delaySeconds: data.delaySeconds,
      asOf: data.asOf, observedFrom: data.observedFrom, generatedAt: data.generatedAt, status: data.status,
      complete: data.status === "available", capacity: data.capacity, dropped: data.dropped, corrections: data.corrections, cancels: data.cancels, connected: data.connected } };
  },
};
