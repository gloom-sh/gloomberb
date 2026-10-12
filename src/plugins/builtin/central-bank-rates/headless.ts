import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCentralBankRates } from "./client";
import { hasNoPolicyRate, policyBoardRow, policyNotices } from "./model";

export const centralBankRatesHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CBR", "CBRT"], dataRequirements: ["Gloom Cloud central-bank-rates endpoint"],
    limitations: ["Published policy observations with individual dates.", "Policy instruments differ.", "Only US meeting dates are maintained."] },
  shape: "bundle", options: [], argument: { kind: "none" }, describe: "G20 central bank policy rates",
  freshness: { source: "Central banks and BIS", status: "not-a-feed", basis: "published policy rates" },
  async load(_args, ctx) {
    const data = await fetchCentralBankRates(ctx.apiClient);
    const errors = policyNotices(data);
    const complete = data.status === "available" && errors.length === 0;
    // A row says "stale" in its status, not in a `stale` flag: hand the report its rows' staleness so its status line and a capture count them.
    const observations = data.rows.filter((row) => row.status !== "unavailable")
      .map((row) => ({ asOf: row.asOf, stale: row.status === "stale" }));
    return { complete, freshness: { observations }, sections: [{ title: "Policy rates", columns: [
      { key: "label", header: "Jurisdiction", shrink: false }, { key: "valueText", header: "Rate", align: "right" },
      { key: "changeText", header: "Last move", align: "right" }, { key: "lastChangeDate", header: "Change observed", shrink: false },
      { key: "percentileValue", header: "Pctl 1Y", align: "right", stackPriority: 1, format: (value) => value == null ? "--" : Number(value).toFixed(0) },
      // A narrow terminal moves the instrument, status and percentile under each row first.
      { key: "asOf", header: "As of", shrink: false }, { key: "status", header: "Status", stackPriority: 2 }, { key: "instrument", header: "Instrument", stackPriority: 3 },
    ], rows: data.rows.map(({ history: _history, ...row }) => {
      const board = policyBoardRow({ ...row, history: [] });
      return { ...row, valueText: board.valueText, changeText: board.changeText, percentileValue: row.percentile.value };
    }) }], errors, unavailableSymbols: data.rows.filter((row) => row.status === "unavailable" && !hasNoPolicyRate(row)).map((row) => row.id),
      metadata: { ...data, complete } };
  },
};
