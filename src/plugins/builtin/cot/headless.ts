import type { CotClass, CotClassSummary } from "../../../api-client/cot";
import type { HeadlessPaneColumn, HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCotBoard, fetchCotContract } from "./client";
import { COT_MAJOR_CODES, COT_SCOPES, cotClass, cotContractCode, cotInteger, cotMarketName, cotScope } from "./model";

const camelClass = (id: CotClass) => id.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());
const rounded = (value: number | null, digits: number) => value == null ? null : Number(value.toFixed(digits));
const count = (value: unknown) => cotInteger(typeof value === "number" ? value : null);
const signed = (value: unknown) => cotInteger(typeof value === "number" ? value : null, true);
const percent = (value: unknown) => typeof value === "number" ? `${value > 0 ? "+" : ""}${value.toFixed(1)}%` : "--";
const rank = (value: unknown) => typeof value === "number" ? value.toFixed(0) : "--";

/** The pane's columns: percentiles as their rank value, net share of open interest to one decimal. */
function cotPositionRow(row: CotClassSummary) {
  return { long: row.long, short: row.short, spreading: row.spreading, net: row.net,
    netPercentOfOpenInterest: rounded(row.netPercentOfOpenInterest, 1), weeklyChange: row.weeklyChange, previousReportDate: row.previousReportDate,
    oneYearPercentile: rounded(row.percentile1Y.value, 0), threeYearPercentile: rounded(row.percentile3Y.value, 0) };
}
const POSITION_COLUMNS: HeadlessPaneColumn[] = [
  { key: "net", header: "Net", align: "right", format: signed },
  { key: "weeklyChange", header: "1W Δ", align: "right", format: signed },
  { key: "netPercentOfOpenInterest", header: "Net % OI", align: "right", format: percent },
  { key: "oneYearPercentile", header: "Pctl 1Y", align: "right", format: rank },
  { key: "threeYearPercentile", header: "Pctl 3Y", align: "right", format: rank },
];

export const cotHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "code or root", description: "CFTC market code or verified futures root; omit for the extremes board." },
  options: [{ key: "report", type: "enum", values: [{ value: "legacy" }, { value: "disaggregated" }], defaultValue: "legacy", description: "CFTC report family." },
    { key: "traderClass", type: "enum", values: ["noncommercial", "commercial", "producer", "swap", "managed-money", "other-reportable", "nonreportable"].map((value) => ({ value })), description: "Trader class for the extremes board; defaults by report family." },
    { key: "scope", type: "enum", values: COT_SCOPES.map(({ value }) => ({ value })), defaultValue: "major", description: "Markets on the extremes board, as in the pane." }],
  discovery: { aliases: ["COT", "CFTC"], dataRequirements: ["Gloom Cloud CFTC history"], limitations: ["Futures-only positions aggregate all maturities", "Legacy and disaggregated classes differ", "Observation date is not publication date", "Some markets have short or suppressed histories"] },
  describe: "CFTC positioning",
  async load(args, ctx) {
    const family = args.options.report === "disaggregated" ? "disaggregated" : "legacy";
    if (args.argument) {
      const code = cotContractCode(args.argument);
      if (!code) throw new Error("Use a CFTC market code or supported futures root");
      const data = await fetchCotContract(code, family, ctx.apiClient);
      const classes = data.positions.map((row) => row.id);
      return { sections: [{ title: data.contract ? cotMarketName(data.contract.marketName) : code,
        columns: [{ key: "class", header: "Class" }, { key: "long", header: "Long", align: "right", format: count },
          { key: "short", header: "Short", align: "right", format: count }, ...POSITION_COLUMNS],
        rows: data.positions.map((row) => ({ class: row.label, ...cotPositionRow(row) })) },
      { title: "Weekly positions",
        columns: [{ key: "reportDate", header: "Report date" }, { key: "openInterest", header: "Open interest", align: "right", format: count },
          ...classes.map((id) => ({ key: `${camelClass(id)}Net`, header: `${data.positions.find((row) => row.id === id)?.label ?? id} net`, align: "right" as const, format: signed }))],
        rows: data.history.map((row) => ({ reportDate: row.reportDate, openInterest: row.openInterest,
          ...Object.fromEntries(row.positions.map((position) => [`${camelClass(position.id)}Net`, position.net])) })) }],
      errors: data.gaps, metadata: { ...data, complete: data.status === "available" } };
    }
    const traderClass = cotClass(family, args.options.traderClass);
    if (args.options.traderClass && traderClass !== args.options.traderClass) throw new Error("Trader class does not belong to this report family");
    const scope = cotScope(args.options.scope);
    const data = await fetchCotBoard(family, traderClass, ctx.apiClient);
    const rows = data.rows.filter((row) => scope === "all" || COT_MAJOR_CODES.has(row.contractCode));
    return { sections: [{ title: "Positioning extremes",
      columns: [{ key: "marketName", header: "Market" }, { key: "contractCode", header: "Code" }, ...POSITION_COLUMNS,
        { key: "openInterest", header: "Open interest", align: "right", format: count }, { key: "reportDate", header: "As of" }],
      rows: rows.map((row) => ({ contractCode: row.contractCode, marketName: cotMarketName(row.marketName), reportDate: row.reportDate, openInterest: row.openInterest, ...cotPositionRow(row.position) })) }],
    errors: data.gaps, metadata: { ...data, scope, complete: data.status === "available" } };
  },
};
