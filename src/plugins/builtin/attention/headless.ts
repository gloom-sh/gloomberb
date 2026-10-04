import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchAttention } from "./client";
import { ATTENTION_TABS, attentionTab, attentionWindow, attentionRows, WINDOWS } from "./model";
export const attentionHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "TICKER", description: "Optional listing-qualified ticker, such as 6758:JPX." },
  options: [{ key: "tab", type: "enum", values: ATTENTION_TABS.map(({ value }) => ({ value })), defaultValue: "ranking", description: "Rankings, abnormal attention, groups, history or evidence." },
    { key: "window", type: "enum", values: WINDOWS.map(({ value }) => ({ value })), defaultValue: "now", description: "Latest completed publication hour, UTC day or trailing week." }],
  discovery: { aliases: ["ATTN"], dataRequirements: ["Privacy-qualified published research counts"],
    limitations: ["Pro dataset with three-row preview and latest history point", "Suppressed hours are absent, never zero", "Activity is opt-in and is not representative of all investors"] },
  describe: "Gloom research attention (Pro)",
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
    const tab = attentionTab(args.options.tab);
    const data = await fetchAttention(attentionWindow(args.options.window), argument?.trim().toUpperCase() || undefined, ctx.apiClient);
    const metadata = { asOf: data.asOf, stale: data.stale, complete: data.status === "ready" && !data.truncated,
      status: data.status, periodStart: data.periodStart, periodEnd: data.periodEnd, entitlement: data.entitlement,
      privacy: data.privacy, coverage: data.coverage, methodologyUrl: data.methodologyUrl, selectedListing: data.selectedListing ?? null, historyEvidence: data.historyEvidence ?? null, unit: "rounded researcher-hours" };
    if (tab === "sectors" || tab === "countries") return { metadata, sections: [{ title: tab === "sectors" ? "Sector attention" : "Country attention",
      columns: [{ key: "name", header: "Group" }, { key: "researchUnits", header: "Research hours" }, { key: "sharePct", header: "Share %" }, { key: "tickers", header: "Tickers" }], rows: data[tab].map((row) => ({ ...row })) }] };
    if (tab === "history") return { metadata, sections: [{ title: "Published hourly history", columns: [{ key: "symbol", header: "Ticker" },
      { key: "bucketStart", header: "Hour (UTC)" }, { key: "researchUnits", header: "Research hours" }],
      rows: data.history && data.selectedListing ? data.history.map((point) => ({ symbol: data.selectedListing!.symbol, ...point })) : data.rows.flatMap((row) => row.history.map((point) => ({ symbol: row.symbol, ...point }))) }] };
    if (tab === "evidence") return { metadata, sections: [{ title: "Publication evidence", columns: [{ key: "symbol", header: "Ticker" },
      { key: "periodStart", header: "Period start" }, { key: "periodEnd", header: "Period end" }, { key: "asOf", header: "Published" },
      { key: "confidence", header: "Quality" }, { key: "marketAsOf", header: "Market as of" }],
      rows: data.rows.map((row) => ({ symbol: row.symbol, ...row.evidence, baselinePeriods: row.baselinePeriods, marketAsOf: row.marketAsOf, news: row.news })) }] };
    return { metadata, sections: [{ title: tab === "abnormal" ? "Abnormal attention" : "Research ranking", columns: [
      { key: "rank", header: "Rank" }, { key: "symbol", header: "Ticker" }, { key: "name", header: "Name" }, { key: "researchUnits", header: "Research hours" },
      { key: "sharePct", header: "Share %" }, { key: "zScore", header: "Latest-hour Z-score" }, { key: "priceChangePct", header: "Price %" },
      { key: "relativeVolume", header: "Relative volume" }, { key: "sector", header: "Sector" }, { key: "country", header: "Country" },
    ], rows: attentionRows(data.rows, tab, "", tab === "abnormal" ? "zScore" : "rank", tab === "abnormal" ? "desc" : "asc").map((row) => ({ ...row })) }] };
  },
};
