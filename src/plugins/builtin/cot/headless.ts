import type { CotClass, CotClassSummary } from "../../../api-client/cot";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCotBoard, fetchCotContract } from "./client";
import { cotClass, cotContractCode } from "./model";

const camelClass = (id: CotClass) => id.replace(/-(\w)/g, (_match, letter: string) => letter.toUpperCase());
const rounded = (value: number | null, digits: number) => value == null ? null : Number(value.toFixed(digits));

/** The pane's columns: percentiles as their rank value, net share of open interest to one decimal. */
function cotPositionRow(row: CotClassSummary) {
  return { long: row.long, short: row.short, spreading: row.spreading, net: row.net,
    netPercentOfOpenInterest: rounded(row.netPercentOfOpenInterest, 1), weeklyChange: row.weeklyChange, previousReportDate: row.previousReportDate,
    oneYearPercentile: rounded(row.percentile1Y.value, 0), threeYearPercentile: rounded(row.percentile3Y.value, 0) };
}

export const cotHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "code or root", description: "CFTC market code or verified futures root; omit for the extremes board." },
  options: [{ key: "report", type: "enum", values: [{ value: "legacy" }, { value: "disaggregated" }], defaultValue: "legacy", description: "CFTC report family." },
    { key: "traderClass", type: "enum", values: ["noncommercial", "commercial", "producer", "swap", "managed-money", "other-reportable", "nonreportable"].map((value) => ({ value })), description: "Trader class for the extremes board; defaults by report family." }],
  discovery: { aliases: ["COT", "CFTC"], dataRequirements: ["Gloom Cloud CFTC history"], limitations: ["Futures-only positions aggregate all maturities", "Legacy and disaggregated classes differ", "Observation date is not publication date", "Some markets have short or suppressed histories"] },
  describe: "CFTC positioning",
  async load(args, ctx) {
    const family = args.options.report === "disaggregated" ? "disaggregated" : "legacy";
    if (args.argument) {
      const code = cotContractCode(args.argument);
      if (!code) throw new Error("Use a CFTC market code or supported futures root");
      const data = await fetchCotContract(code, family, ctx.apiClient);
      return { sections: [{ title: data.contract?.marketName ?? code, rows: data.positions.map((row) => ({ class: row.label, ...cotPositionRow(row) })) },
        { title: "Weekly positions", rows: data.history.map((row) => ({ reportDate: row.reportDate, openInterest: row.openInterest,
          ...Object.fromEntries(row.positions.map((position) => [`${camelClass(position.id)}Net`, position.net])) })) }],
      errors: data.gaps, metadata: { ...data, complete: data.status === "available" } };
    }
    const traderClass = cotClass(family, args.options.traderClass);
    if (args.options.traderClass && traderClass !== args.options.traderClass) throw new Error("Trader class does not belong to this report family");
    const data = await fetchCotBoard(family, traderClass, ctx.apiClient);
    return { sections: [{ title: "Positioning extremes", rows: data.rows.map((row) => ({ contractCode: row.contractCode, marketName: row.marketName, reportDate: row.reportDate, openInterest: row.openInterest, ...cotPositionRow(row.position) })) }], errors: data.gaps, metadata: { ...data, complete: data.status === "available" } };
  },
};
