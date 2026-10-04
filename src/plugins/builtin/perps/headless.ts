import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPerpSelection, fetchPerpsHistory } from "./client";
import { PERP_TABS } from "./model";

export const perpsHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "market", description: "Underlying or canonical market identity, such as BTC or hyperliquid:xyz:TSLA." },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", values: PERP_TABS.map((value) => ({ value })), defaultValue: "history", description: "Per-market history or evidence." },
    { key: "days", type: "enum", settingKey: "days", values: ["1", "7", "30", "90", "365"].map((value) => ({ value })), defaultValue: "7", description: "History lookback in days." },
    { key: "metric", type: "enum", settingKey: "metric", values: ["funding", "oi", "premium", "price"].map((value) => ({ value })), defaultValue: "funding", description: "Displayed history chart; JSON retains every series." },
  ],
  discovery: { aliases: ["PERP"], dataRequirements: ["Perpetual market observations"], limitations: ["Pro history with latest-value free previews", "Rates, premiums and changes are fractions in JSON", "Open-interest history begins at first collection", "Funding APR is a simple annualization, not a forecast"] },
  describe: "Perpetual history and evidence (Pro)",
  async load(args, ctx) {
    const search = String(Array.isArray(args.argument) ? args.argument.join(" ") : args.argument ?? "BTC");
    const market = await fetchPerpSelection(search, ctx.apiClient);
    const selected = market.rows[0];
    if (!selected) return { sections: [{ title: "Market", rows: [] }], errors: ["No market matches the selection"], complete: false };
    const metadata = { marketId: selected.marketId, sourceUrl: selected.sourceUrl, observedAt: selected.observedAt, sourceAsOf: selected.sourceAsOf,
      rates: "fraction", quoteCurrency: selected.quoteCurrency, oiCurrency: "USD", fundingIntervalHours: selected.fundingIntervalHours };
    if (args.options.tab === "evidence") return {
      sections: [{ title: "Market evidence", rows: market.rows.map((row) => ({ ...row })) }, { title: "Observation revisions", rows: market.evidence.map((row) => ({ ...row })) }],
      complete: market.access === "pro" && market.status === "ok", errors: market.access !== "pro" ? ["Full evidence requires Gloom Pro"] : [],
      metadata: { ...metadata, asOf: market.asOf, access: market.access, locked: market.locked, status: market.status },
    };
    const history = await fetchPerpsHistory({ marketId: selected.marketId, from: new Date(Date.now() - Number(args.options.days ?? 7) * 86_400_000).toISOString(), resolution: "auto", limit: 5000 }, ctx.apiClient);
    return { sections: [{ title: "Latest market", rows: [{ ...selected }] }, { title: "Own observations", rows: history.rows.map((row) => ({ ...row })) },
      { title: "Paid funding", rows: history.funding.map((row) => ({ ...row })) }, { title: "Hourly candles", rows: history.candles.map((row) => ({ ...row })) }],
      complete: !history.locked && !history.truncated && history.status === "ok",
      errors: history.locked ? ["Full history requires Gloom Pro"] : history.truncated ? ["History reached the 5,000-observation limit; narrow the range"] : [],
      metadata: { ...metadata, asOf: history.asOf, access: history.access, locked: history.locked, status: history.status, from: history.from, to: history.to, resolution: history.resolution, truncated: history.truncated ?? false },
    };
  },
};
