import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchAttention } from "./client";
import { ATTENTION_TABS, attentionPreviewNote, attentionTab, attentionWindow, attentionRows, emptyAttention, WINDOWS } from "./model";
export const attentionHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "TICKER", description: "Optional listing-qualified ticker, such as 6758:JPX." },
  options: [{ key: "tab", type: "enum", values: ATTENTION_TABS.map(({ value }) => ({ value })), defaultValue: "ranking", description: "Rankings, abnormal attention, groups, history or evidence." },
    { key: "window", type: "enum", values: WINDOWS.map(({ value }) => ({ value })), defaultValue: "now", description: "Latest completed publication hour, UTC day or trailing week." }],
  discovery: { aliases: ["ATTN"], dataRequirements: ["Privacy-qualified published research counts"],
    limitations: ["Pro dataset with three-row preview and latest history point.", "Suppressed hours are absent, never zero.", "Counts come from signed-in Gloom users and are not representative of all investors."] },
  describe: "Gloom research attention (Pro)",
  async load(args, ctx) {
    const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
    const tab = attentionTab(args.options.tab);
    const window = attentionWindow(args.options.window);
    const asked = argument?.trim().toUpperCase() || undefined;
    let data = await fetchAttention(window, asked, ctx.apiClient);
    // The free preview picks its rows before it looks the ticker up, so one outside them comes back empty: show the preview's own rows and say they are not the ticker's.
    const outside = !!asked && data.entitlement === "preview" && !data.rows.length && data.counts.rows > 0;
    if (outside) data = await fetchAttention(window, undefined, ctx.apiClient);
    const note = attentionPreviewNote(data, asked, outside);
    const lock = note ? { errors: [note] } : {};
    // A board that has published nothing yet says so, whatever the plan.
    const empty = data.status === "ready" ? {} : { empty: emptyAttention(data) };
    const metadata = { asOf: data.asOf, stale: data.stale, complete: data.status === "ready" && !data.truncated,
      status: data.status, periodStart: data.periodStart, periodEnd: data.periodEnd, entitlement: data.entitlement,
      privacy: data.privacy, coverage: data.coverage, methodologyUrl: data.methodologyUrl, selectedListing: data.selectedListing ?? null, historyEvidence: data.historyEvidence ?? null, unit: "rounded researcher-hours" };
    // Published hour by hour, so not a feed, but the service says when publication has fallen behind.
    const freshness = { status: data.stale ? "stale" as const : "not-a-feed" as const, basis: "hourly publication" };
    if (tab === "sectors" || tab === "countries") return { metadata, freshness, ...lock, sections: [{ title: tab === "sectors" ? "Sector attention" : "Country attention",
      columns: [{ key: "name", header: "Group" }, { key: "researchUnits", header: "Research hours" }, { key: "sharePct", header: "Share %" }, { key: "tickers", header: "Tickers" }], rows: data[tab].map((row) => ({ ...row })), ...empty }] };
    if (tab === "history") return { metadata, freshness, ...lock, sections: [{ title: "Published hourly history", columns: [{ key: "symbol", header: "Ticker" },
      { key: "bucketStart", header: "Hour (UTC)" }, { key: "researchUnits", header: "Research hours" }],
      rows: data.history && data.selectedListing ? data.history.map((point) => ({ symbol: data.selectedListing!.symbol, ...point })) : data.rows.flatMap((row) => row.history.map((point) => ({ symbol: row.symbol, ...point }))), ...empty }] };
    if (tab === "evidence") return { metadata, freshness, ...lock, sections: [{ title: "Publication evidence", columns: [{ key: "symbol", header: "Ticker" },
      { key: "periodStart", header: "Period start" }, { key: "periodEnd", header: "Period end" }, { key: "asOf", header: "Published" },
      { key: "confidence", header: "Quality" }, { key: "marketAsOf", header: "Market as of" }],
      rows: data.rows.map((row) => ({ symbol: row.symbol, ...row.evidence, baselinePeriods: row.baselinePeriods, marketAsOf: row.marketAsOf, news: row.news })), ...empty }] };
    return { metadata, freshness, ...lock, sections: [{ title: tab === "abnormal" ? "Abnormal attention" : "Research ranking", columns: [
      { key: "rank", header: "Rank" }, { key: "symbol", header: "Ticker" }, { key: "name", header: "Name" }, { key: "researchUnits", header: "Research hours" },
      { key: "sharePct", header: "Share %" }, { key: "zScore", header: "Latest-hour Z-score" }, { key: "priceChangePct", header: "Price %" },
      { key: "relativeVolume", header: "Relative volume" }, { key: "sector", header: "Sector" }, { key: "country", header: "Country" },
    ], rows: attentionRows(data.rows, tab, "", tab === "abnormal" ? "zScore" : "rank", tab === "abnormal" ? "desc" : "asc").map((row) => ({ ...row })), ...empty }] };
  },
};
