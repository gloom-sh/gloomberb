import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchSupplyChain } from "./client";

export const supplyChainHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "Company ticker.", placeholder: "ticker" },
  discovery: { aliases: ["SPLC", "SUPPLY"], dataRequirements: ["Gloom Cloud filing disclosures"],
    limitations: ["US filings in phase 1; counterparties can be global", "Absence is not proof of no relationship", "Free accounts see three rows per role in each direction", "Reverse percentages are of the reporting company, not the focus company"] },
  options: [
    { key: "view", type: "enum", settingKey: "view", defaultValue: "says", values: [{ value: "says" }, { value: "names" }], description: "The company's filings, or other filings naming it." },
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: [{ value: "table" }, { value: "flow" }], description: "Table or supply chain flow." },
  ],
  describe: (args) => `Supply chain | ${args.symbols[0]}`,
  async load(args, ctx) {
    const data = await fetchSupplyChain(args.symbols[0]!, ctx.apiClient);
    return { complete: !data.truncated, errors: data.truncated ? ["Additional relationships need Gloom Pro"] : [],
      sections: (["says", "names"] as const).map((view) => ({ title: view === "says" ? `${data.symbol} says` : `Names ${data.symbol}`,
        rows: data[view].map((row) => ({ counterparty: row.counterparty.name, ticker: row.counterparty.ticker, aggregate: row.counterparty.aggregate, role: row.role, direction: row.direction,
          pct: row.pctOfRevenue, pctBasis: row.pctBasis, pctScope: row.pctScope, usd: row.usd, usdBasis: row.usdBasis, period: row.period, fiscalYear: row.fiscalYear,
          source: row.sourceKind, filed: row.filedDate, confidence: row.confidence, reportingCompany: row.reportingEntity.name, quote: row.quote, quoteMatchMode: row.quoteMatchMode, filingUrl: row.filingUrl })) })),
      metadata: { symbol: data.symbol, asOf: data.asOf, counts: data.counts, disclaimer: data.disclaimer } };
  },
};
