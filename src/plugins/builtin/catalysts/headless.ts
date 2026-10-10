import { CATALYST_TYPES } from "../../../api-client/catalysts";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCatalystDetail, fetchCatalysts } from "./client";
import { catalystCell, catalystChangeText, catalystDate, catalystQuery, catalystTickers } from "./model";

function definition(litigation: boolean): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { source: litigation ? "Court and agency dockets" : "Regulator, court and trade records", status: "not-a-feed", basis: "published records" },
    argument: { kind: "ticker", optional: !litigation, description: litigation ? "Company ticker, including exchange-qualified international listings." : "Optional ticker; omit for market-wide events." },
    options: [
      { key: "tab", type: "enum", values: [{ value: "calendar" }, { value: "changes" }], defaultValue: "calendar", description: "Dated events or observed revisions." },
      { key: "type", type: "enum", values: CATALYST_TYPES.map((value) => ({ value })), description: "Event type." },
      ...["agency", "country", "sector", "status", "search", "from", "to"].map((key) => ({ key, type: "string" as const, description: `Filter by ${key}. Dates use YYYY-MM-DD.` })),
      { key: "dateField", type: "enum", values: ["any", "announced", "effective", "deadline", "observed"].map((value) => ({ value })), defaultValue: "any", description: "Date field for the calendar window." },
      { key: "upcoming", type: "boolean", defaultValue: false, description: "Only future effective dates and deadlines." },
      { key: "offset", type: "integer", defaultValue: 0, description: "Zero-based event offset." },
      { key: "limit", type: "integer", defaultValue: 100, description: "Rows to return, up to 500." },
      { key: "detailTab", type: "enum", values: [{ value: "evidence" }, { value: "history" }], defaultValue: "evidence", description: "Detail section for screenshots." },
      { key: "event", type: "string", settingKey: "open", description: "Event ID for evidence and revision history." },
    ],
    discovery: { aliases: [litigation ? "LITI" : "CATL"], dataRequirements: ["Gloom Cloud catalyst records"], limitations: ["Pro; free preview includes three events", "Only published dates and confidently resolved corporate parties are linked", "Coverage varies by jurisdiction and source; absence is not proof of no event"] },
    describe: litigation ? "Company litigation, enforcement and antitrust dockets with evidence" : "Regulatory, clinical, legal and trade-policy catalyst calendar with provenance",
    async load(args, ctx) {
      if (typeof args.options.event === "string" && args.options.event) {
        const data = await fetchCatalystDetail(args.options.event, ctx.apiClient, undefined, { offset: Math.max(0, Number(args.options.offset) || 0), limit: Math.min(200, Math.max(1, Number(args.options.limit) || 100)) });
        return { sections: [{ title: "Event evidence", entries: Object.entries(data.event).map(([label, value]) => ({ label, value: typeof value === "object" ? JSON.stringify(value) : String(value ?? "") })) },
          { title: "Revision history", columns: [{ key: "revision", header: "Revision" }, { key: "observedAt", header: "Observed (UTC)" }, { key: "status", header: "Status" }, { key: "changeSummary", header: "Changes" }], rows: data.history.map((event) => ({ ...event, changeSummary: event.changes.map(catalystChangeText).join("; ") || "First observed" })) }],
          metadata: { asOf: data.asOf, access: data.access, historyTotal: data.historyTotal, historyOffset: data.historyOffset, historyHasMore: data.historyHasMore, historyTruncated: data.historyTruncated, complete: data.access?.pro !== false && !data.historyTruncated } };
      }
      const symbol = Array.isArray(args.argument) ? args.argument[0] : args.argument;
      const query = catalystQuery(args.options, symbol ?? undefined, litigation);
      const data = await fetchCatalysts({ ...query, limit: Math.max(1, Math.min(500, Number(args.options.limit) || 100)), offset: Math.max(0, Number(args.options.offset) || 0) }, ctx.apiClient);
      return { sections: [{ title: litigation ? "Company dockets" : "Catalyst events", columns: [
        { key: "date", header: "Date" }, { key: "tickers", header: "Tickers" }, { key: "title", header: "Event" }, { key: "type", header: "Type" },
        ...(args.options.tab === "changes" ? [{ key: "changeSummary", header: "Changes" }] : [{ key: "status", header: "Status" }]),
        { key: "agency", header: "Agency" }, { key: "country", header: "Country" }, { key: "sourceUrl", header: "Primary source" },
      ], rows: data.events.map((event) => ({ ...event, date: catalystDate(event, query.dateField), tickers: catalystTickers(event), ...(args.options.tab === "changes" ? { changeSummary: catalystCell(event, "status", query.dateField, true) } : {}) })) }],
      metadata: { asOf: data.asOf, total: data.total, offset: data.offset, limit: data.limit, access: data.access, coverage: data.coverage, complete: data.access?.pro !== false && data.offset + data.events.length >= data.total } };
    },
  };
}
export const catalystsHeadless = definition(false);
export const litigationHeadless = definition(true);
