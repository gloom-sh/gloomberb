import { CATALYST_TYPES, type CatalystEvent } from "../../../api-client/catalysts";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { DATE_OPTION_EXAMPLES } from "../../../utils/calendar-date";
import { fetchCatalystDetail, fetchCatalysts } from "./client";
import { catalystKindCell, catalystKindDate, catalystKindFields, catalystKindFold, catalystKindNoun, catalystKindOf, catalystKindTypes, catalystSelf, catalystWith, CATALYST_KINDS, createCatalystKindLoader, isCatalystKind } from "./kinds";
import { catalystCell, catalystChangeText, catalystDate, catalystDateBasis, catalystEmptyTitle, catalystLockedText, catalystParties, catalystQuery, catalystTickers } from "./model";
import { clampLimit, dateOption, enumOption, intOption, REPORT_PAGE, REPORT_ROWS } from "../shared/headless-options";
import { formatDaysInText } from "../../../utils/day-format";

/** A change's days read day first in the text, as the pane draws them; JSON and CSV keep them in ISO. */
const changeText = (value: unknown) => formatDaysInText(String(value ?? ""));

function definition(litigation: boolean): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { source: litigation ? "Court and agency dockets" : "Regulator, court and trade records", status: "not-a-feed", basis: "published records" },
    argument: { kind: "ticker", optional: !litigation, description: litigation ? "Company ticker, including exchange-qualified international listings." : "Optional ticker; omit for market-wide events." },
    options: [
      enumOption("tab", [{ value: "calendar", label: litigation ? "Dockets" : "Calendar" }, "changes"], { defaultValue: "calendar", description: "Dated events or observed revisions." }),
      ...(!litigation ? [enumOption("kind", CATALYST_KINDS.map(({ value, label }) => ({ value, label })), { description: "One kind of event with its own columns: company dates, drug decision days, approvals, trials, rules or legal actions." })] : []),
      enumOption("type", CATALYST_TYPES, { description: "Event type." }),
      ...["agency", "country", "sector", "status"].map((key) => ({ key, type: "string" as const, description: `Filter by ${key}.` })),
      { key: "search", type: "string", description: "Filter by text." },
      dateOption("from", { description: `Start of the calendar window, as ${DATE_OPTION_EXAMPLES}.` }),
      dateOption("to", { description: `End of the calendar window, as ${DATE_OPTION_EXAMPLES}.` }),
      enumOption("dateField", ["any", "announced", "effective", "deadline", "observed"], { defaultValue: "any", description: "Date field for the calendar window." }),
      { key: "upcoming", type: "boolean", defaultValue: false, description: "Only future effective dates and deadlines." },
      intOption("offset", { shot: REPORT_PAGE, defaultValue: 0, description: "Zero-based event offset." }),
      intOption("limit", { shot: REPORT_ROWS, defaultValue: 100, description: "Rows to return, up to 200." }),
      enumOption("detailTab", ["evidence", "history"], { defaultValue: "evidence", description: "Detail section for screenshots." }),
      { key: "event", type: "string", settingKey: "open", description: "Event ID for evidence and revision history." },
    ],
    discovery: { aliases: [litigation ? "LITI" : "CATL"],
      // `fn PDUFA` is the PDUFA calendar, not every catalyst.
      ...(!litigation ? { opens: [{ words: ["PDUFA", "PDUFA dates", "PDUFA calendar"], argument: "", options: { type: "pdufa" } }] } : {}),
      dataRequirements: ["Gloom Cloud catalyst records"], limitations: ["Pro; free preview includes three events.", "Only published dates and confidently resolved corporate parties are linked.", "Coverage varies by jurisdiction and source; absence is not proof of no event."] },
    describe: litigation ? "Company litigation, enforcement and antitrust dockets with evidence" : "Regulatory, clinical, legal and trade-policy catalyst calendar with provenance",
    async load(args, ctx) {
      const limit = clampLimit(Number(args.options.limit) || 100, 100, 200);
      const offset = Math.max(0, Number(args.options.offset) || 0);
      if (typeof args.options.event === "string" && args.options.event) {
        const data = await fetchCatalystDetail(args.options.event, ctx.apiClient, undefined, { offset, limit });
        const lockedHistory = data.access?.pro === false && data.historyTruncated === true;
        return { ...(lockedHistory ? { complete: false, errors: ["Older revisions need Gloom Pro"] } : {}), sections: [{ title: "Event evidence", entries: Object.entries(data.event).map(([label, value]) => ({ label, value: typeof value === "object" ? JSON.stringify(value) : String(value ?? "") })) },
          { title: "Revision history", columns: [{ key: "revision", header: "Revision" }, { key: "observedAt", header: "Observed (UTC)" }, { key: "status", header: "Status" }, { key: "changeSummary", header: "Changes", textFormat: changeText }], rows: data.history.map((event) => ({ ...event, changeSummary: event.changes.map(catalystChangeText).join("; ") || "First observed" })) }],
          metadata: { asOf: data.asOf, access: data.access, historyTotal: data.historyTotal, historyOffset: data.historyOffset, historyHasMore: data.historyHasMore, historyTruncated: data.historyTruncated, complete: data.access?.pro !== false && !data.historyTruncated } };
      }
      const symbol = Array.isArray(args.argument) ? args.argument[0] : args.argument;
      const query = catalystQuery(args.options, symbol ?? undefined, litigation);
      if (!litigation && args.options.tab !== "changes" && isCatalystKind(args.options.kind)) {
        // One kind, read across its types in calendar order, under the pane's columns for it.
        const kind = query.type ? catalystKindOf(query.type) : args.options.kind;
        const types = query.type ? [query.type] : catalystKindTypes(kind);
        const read = createCatalystKindLoader(types, async (type, from) => ({ payload: await fetchCatalysts({ ...query, type, limit: 100, offset: from }, ctx.apiClient), stale: false, refreshError: null }), query);
        const signal = new AbortController().signal;
        let page = await read({ offset: 0, force: false, signal });
        const listed = [...page.rows];
        while (page.hasMore && listed.length < offset + limit) {
          page = await read({ offset: listed.length, force: false, signal });
          listed.push(...page.rows);
        }
        const data = { ...page.payload, events: listed.slice(offset, offset + limit), offset };
        const self = symbol ? catalystSelf(data.events, symbol) : null;
        // The pane's columns for the rows listed: what they say alike is left out, as there.
        const fields = catalystKindFields({ kind, self: self ? { hasOthers: data.events.some((event) => catalystWith(event, self) !== "") } : null,
          fold: catalystKindFold(data.events, query, kind) });
        const cell = (column: string) => (_value: unknown, row: Record<string, unknown>) => catalystKindCell(row as unknown as CatalystEvent, column, query, kind, self);
        const locked = catalystLockedText(data.access, "event");
        const noun = catalystKindNoun(kind);
        return { ...(locked ? { complete: false, errors: [`${locked} ${data.access?.lockedRows === 1 ? "needs" : "need"} Gloom Pro`] } : {}), sections: [{ title: noun.replace(/^./, (c) => c.toUpperCase()), columns: [
          ...fields.map(({ id, label }) => id === "parties" ? { key: "parties", header: label, format: (_value: unknown, row: Record<string, unknown>) => catalystParties(row as unknown as CatalystEvent) }
            : id === "ticker" ? { key: "tickers", header: label }
            // The date reads day first, as the pane draws it; the row keeps its ISO day for exports.
            : id === "date" ? { key: id, header: label, textFormat: cell(id) }
            : ["basis", "with", "phase"].includes(id) ? { key: id, header: label }
            : { key: id, header: label, textFormat: cell(id) }),
          { key: "sourceUrl", header: "Primary source" },
        ], rows: data.events.map((event) => ({ ...event, date: catalystKindDate(event, query), tickers: catalystTickers(event),
          ...Object.fromEntries(["basis", "with", "phase"].filter((id) => fields.some((field) => field.id === id)).map((id) => [id, catalystKindCell(event, id, query, kind, self)])) })),
          ...(data.events.length ? {} : { empty: catalystEmptyTitle(data, query, false, noun) }) }],
        metadata: { asOf: data.asOf, kind, total: data.total, offset, limit, access: data.access, coverage: data.coverage, complete: data.access?.pro !== false && offset + data.events.length >= data.total } };
      }
      const data = await fetchCatalysts({ ...query, limit, offset }, ctx.apiClient);
      // The free preview's held-back rows are a Pro line, so a report never reads as everything there is.
      const locked = catalystLockedText(data.access, litigation ? "case" : "event");
      const changes = args.options.tab === "changes";
      // The text reads like the pane's cells; exports keep the service's codes (`clinical`, `ACTIVE_NOT_RECRUITING`).
      const cell = (column: string) => (_value: unknown, row: Record<string, unknown>) => catalystCell(row as unknown as CatalystEvent, column, query, changes);
      // As LITI's pane: a ticker, date basis, type, agency or country every case shares prints once, not on each row.
      const shared = litigation ? { omitWhenSame: true } : {};
      return { ...(locked ? { complete: false, errors: [`${locked} ${data.access?.lockedRows === 1 ? "needs" : "need"} Gloom Pro`] } : {}), sections: [{ title: litigation ? "Company dockets" : "Catalyst events", columns: [
        { key: "date", header: changes ? "Observed (UTC)" : "Date", textFormat: cell("date") }, ...(!changes ? [{ key: "basis", header: "Date basis", ...shared }] : []),
        { key: "tickers", header: "Tickers", ...shared }, { key: "parties", header: "Parties", format: (_value, row) => catalystParties(row as unknown as CatalystEvent) }, { key: "title", header: litigation ? "Case / docket" : "Event", textFormat: cell("title") },
        { key: "type", header: "Type", textFormat: cell("type"), ...shared },
        ...(changes ? [{ key: "changeSummary", header: "Changes", textFormat: changeText }] : [{ key: "status", header: "Status", textFormat: cell("status") }]),
        { key: "agency", header: "Agency", textFormat: cell("agency"), ...shared }, { key: "country", header: "Country", textFormat: cell("country"), ...shared }, { key: "sourceUrl", header: "Primary source" },
      ], rows: data.events.map((event) => ({ ...event, date: catalystDate(event, query), ...(!changes ? { basis: catalystDateBasis(event, query) } : {}),
        tickers: catalystTickers(event), ...(changes ? { changeSummary: catalystCell(event, "status", query.dateField, true) } : {}) })),
        ...(data.events.length ? {} : { empty: catalystEmptyTitle(data, query, changes) }) }],
      metadata: { asOf: data.asOf, total: data.total, offset: data.offset, limit: data.limit, access: data.access, coverage: data.coverage, complete: data.access?.pro !== false && data.offset + data.events.length >= data.total } };
    },
  };
}
export const catalystsHeadless = definition(false);
export const litigationHeadless = definition(true);
