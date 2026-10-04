import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { AppAttentionPayload, AppChart } from "../../../api-client/app-attention";
import type { HiringBoard, HiringPayload } from "../../../api-client/hiring";
import { fetchAppRank, fetchAttention } from "./client";
import { appsModel, hiringModel, type AttentionKind } from "./model";

export function attentionHeadless(kind: AttentionKind): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
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
      ? ["Pro: full weekly history and evidence; free preview", "Observed requisitions, not headcount or confirmed office openings", "History begins with retained captures; incomplete snapshots cannot imply hiring freezes"]
      : ["Pro: full chart history and evidence; free preview", "Public top charts are an observed subset, not downloads or revenue", "Grossing feeds are unavailable; written reviews are distinct from ratings", "Mappings use evidenced ownership; unmapped apps stay visible"] },
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
      const nextOffset = kind === "hiring" && "total" in data ? offset + data.companies.length < data.total ? offset + data.companies.length : null : (data as AppAttentionPayload).page?.nextOffset ?? null;
      return {
        complete: !model.preview && nextOffset === null,
        errors: [...model.notices, ...(nextOffset !== null ? [`Additional observations available with --offset ${nextOffset}.`] : []), ...(model.preview ? ["Additional rows and history require Gloom Pro."] : [])],
        sections: Object.entries(model.sections).map(([key, section]) => ({ title: key === "mix" ? kind === "hiring" ? "Role family" : "Countries" : key,
          columns: section.columns.map((column) => ({ key: column.id, header: column.label, align: column.align })),
          rows: section.rows.map((row) => ({ ...row.values, ...(row.url ? { sourceUrl: row.url } : {}), ...(row.details ? { evidence: row.details } : {}) })) })),
        metadata: { nextOffset, asOf: model.asOf, preview: model.preview, lockedRows: model.locked, unit: model.chart.unit, provenance: data },
      };
    },
  };
}
