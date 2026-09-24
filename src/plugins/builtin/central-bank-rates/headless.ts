import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCentralBankRates } from "./client";
import { hasNoPolicyRate, policyBoardRow, policyNotices } from "./model";

export const centralBankRatesHeadless: HeadlessPaneDefinition<"bundle"> = {
  discovery: { aliases: ["CBR", "ECFC", "CBRT"], dataRequirements: ["Gloom Cloud central-bank-rates endpoint"],
    limitations: ["Published policy observations with individual dates", "Policy instruments differ", "Only US meeting dates are maintained"] },
  shape: "bundle", options: [], argument: { kind: "none" }, describe: "G20 central bank policy rates",
  async load(_args, ctx) {
    const data = await fetchCentralBankRates(ctx.apiClient);
    const errors = policyNotices(data);
    const complete = data.status === "available" && errors.length === 0;
    return { complete, sections: [{ title: "Policy rates", columns: [
      { key: "label", header: "Jurisdiction" }, { key: "valueText", header: "Rate", align: "right" },
      { key: "changeText", header: "Last move", align: "right" }, { key: "lastChangeDate", header: "Change observed" },
      { key: "percentileValue", header: "Pctl 1Y", align: "right", format: (value) => value == null ? "--" : Number(value).toFixed(0) },
      { key: "asOf", header: "As of" }, { key: "status", header: "Status" }, { key: "instrument", header: "Instrument" },
    ], rows: data.rows.map(({ history: _history, ...row }) => {
      const board = policyBoardRow({ ...row, history: [] });
      return { ...row, valueText: board.valueText, changeText: board.changeText, percentileValue: row.percentile.value };
    }) }], errors, unavailableSymbols: data.rows.filter((row) => row.status === "unavailable" && !hasNoPolicyRate(row)).map((row) => row.id),
      metadata: { ...data, complete } };
  },
};
