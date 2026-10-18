import type { HeadlessPaneColumn, HeadlessPaneDefinition, HeadlessPaneRow } from "../../../types/plugin";
import type { DataTableColumn } from "../../../components";
import type { AppAttentionPayload, AppChart } from "../../../api-client/app-attention";
import type { HiringBoard, HiringPayload } from "../../../api-client/hiring";
import { fetchAppRank, fetchAttention } from "./client";
import { appsModel, appsPreviewNote, attentionNumber, attentionSectionTitle, attentionTabs, hiringModel, hiringPreviewNote, remoteText, type AttentionKind } from "./model";

/**
 * Numbers print as the pane draws them: shares to a tenth, ratings and
 * z-scores to a hundredth, counts whole, and a remote share with the roles it
 * is measured on. Exports keep the full value.
 */
function reportColumn(column: DataTableColumn): HeadlessPaneColumn {
  if (column.align !== "right") return { key: column.id, header: column.label, align: column.align };
  const format = (value: unknown) => typeof value === "number" ? attentionNumber(column.id, value) : value == null ? "-" : String(value);
  return { key: column.id, header: column.label, align: column.align, format,
    ...(column.id === "remote" ? { textFormat: (value: unknown, row: HeadlessPaneRow) => typeof value === "number"
      ? remoteText(value, typeof row.remoteKnown === "number" ? row.remoteKnown : null) ?? "-" : "-" } : {}) };
}

export function attentionHeadless(kind: AttentionKind): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: kind === "hiring"
      ? { source: "Company careers sites", status: "not-a-feed", basis: "observed job postings", dataset: true }
      : { source: "App Store and Google Play charts", status: "not-a-feed", basis: "observed chart ranks", dataset: true },
    argument: { kind: "ticker", optional: true, placeholder: "ticker", description: "Company ticker, including exchange for non-US listings. Omit for the global board." },
    options: [
      { key: "limit", type: "string", defaultValue: "100", description: "Rows per REST page, up to 200 for hiring and 500 for apps." },
      { key: "offset", type: "string", defaultValue: "0", description: "Continuation offset from the prior report metadata." },
      { key: "tab", type: "enum", settingKey: "tab", values: ["table", "chart", "mix", "peers", "evidence"].map((value) => ({ value })), defaultValue: "table", description: "Table, dated history, geographic or role mix, peers, or source evidence." },
      ...(kind === "apps" ? [
        { key: "appId", aliases: ["app-id"], type: "string" as const, settingKey: "appId", description: "Open one app's exact country/chart rank history instead of a company." },
        { key: "store", type: "enum" as const, settingKey: "store", values: [{ value: "app-store" }, { value: "google-play" }], defaultValue: "app-store", description: "Store for an individual app history." },
        { key: "country", type: "string" as const, settingKey: "country", description: "Country ISO code; omit for every covered country." },
        { key: "chart", type: "enum" as const, settingKey: "chart", values: ["free", "paid", "unranked"].map((value) => ({ value })), description: "Chart basis. Unranked observations have no chart rank." },
        { key: "days", type: "string" as const, settingKey: "days", defaultValue: "90", description: "Calendar history window, 7 to 730 days." },
      ] : []),
    ],
    discovery: { aliases: [kind === "hiring" ? "HIRE" : "APPS"], dataRequirements: ["Gloom Cloud account"], limitations: kind === "hiring"
      ? ["Pro: full weekly history and evidence; free preview.", "Observed requisitions, not headcount or confirmed office openings.", "History begins with retained captures; incomplete snapshots cannot imply hiring freezes."]
      : ["Pro: full chart history and evidence; free preview.", "Public top charts are an observed subset, not downloads or revenue.", "Grossing feeds are unavailable; written reviews are distinct from ratings.", "Mappings use evidenced ownership; unmapped apps stay visible."] },
    describe: (args) => `${kind === "hiring" ? "Hiring momentum" : "App attention"}${args.symbols[0] ? ` | ${args.symbols[0]}` : ""}`,
    async load(args, ctx) {
      if (kind === "apps" && typeof args.options.appId === "string" && args.options.appId) {
        const store = args.options.store === "google-play" ? "google-play" : "app-store";
        const rank = await fetchAppRank({ store, appId: args.options.appId, name: args.options.appId, country: String(args.options.country || (store === "google-play" ? "GLOBAL" : "US")).toUpperCase(), chart: (args.options.chart || (store === "google-play" ? "unranked" : "free")) as AppChart }, Number(args.options.days) || 90, Number(args.options.offset) || 0, ctx.signal, ctx.apiClient, Number(args.options.limit) || 100);
        return { complete: rank.access === "pro" && rank.page.nextOffset === null, sections: [{ title: "App rank history", rows: rank.rankHistory }], metadata: { nextOffset: rank.page.nextOffset, preview: rank.access === "preview", lockedRows: rank.locked, provenance: rank } };
      }
      const data = await fetchAttention(kind, args.symbols[0], { limit: Number(args.options.limit) || 100, offset: Number(args.options.offset) || 0, ...(typeof args.options.country === "string" ? { country: args.options.country } : {}), ...(typeof args.options.chart === "string" ? { chart: args.options.chart as AppChart } : {}), days: Number(args.options.days) || 90 }, ctx.apiClient);
      const model = kind === "hiring" ? hiringModel(data as HiringPayload | HiringBoard) : appsModel(data as AppAttentionPayload);
      const offset = Number(args.options.offset) || 0;
      // The free preview ignores the offset, so it has no next page to point at.
      const nextOffset = kind === "hiring" && "total" in data ? !data.preview && offset + data.companies.length < data.total ? offset + data.companies.length : null : (data as AppAttentionPayload).page?.nextOffset ?? null;
      const lock = kind === "hiring" ? hiringPreviewNote(data as HiringPayload | HiringBoard) : appsPreviewNote(data as AppAttentionPayload);
      const notes = [...model.notices, ...(nextOffset !== null ? [`Additional observations available with --offset ${nextOffset}.`] : [])];
      return {
        complete: !model.preview && !model.partial && nextOffset === null,
        ...(lock ? { errors: [lock] } : {}),
        ...(notes.length ? { notes } : {}),
        // The views the pane has tabs for, each headed by what its rows are.
        sections: attentionTabs(kind, args.symbols[0]).map((tab) => {
          const section = model.sections[tab];
          return { title: attentionSectionTitle(kind, tab, args.symbols[0]),
            columns: section.columns.map(reportColumn), empty: section.empty,
            rows: section.rows.map((row) => ({ ...row.values, ...(row.url ? { sourceUrl: row.url } : {}), ...(row.details ? { evidence: row.details } : {}) })) };
        }),
        metadata: { nextOffset, asOf: model.asOf, preview: model.preview, lockedRows: model.locked, unit: model.chart.unit, provenance: data },
      };
    },
  };
}
