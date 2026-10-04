import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchSupplyChain } from "./client";
import { evidenceLabel, isUnconfirmed, matchesSupplyOptions, supplyOptions, trustTier } from "./trust";

export const supplyChainHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  argument: { kind: "ticker", description: "Company ticker.", placeholder: "ticker" },
  discovery: { aliases: ["SPLC", "SUPPLY"], dataRequirements: ["Gloom Cloud relationship evidence (Pro with free preview)"],
    limitations: ["Filings, company announcements, earnings calls and news where evidence is available globally", "Absence is not proof of no relationship", "Free accounts see three rows per role in each direction", "Unconfirmed leads are opt-in and excluded from flow and disclosed values", "Restricted publisher articles expose links only", "Reverse percentages are of the reporting company, not the focus company"] },
  options: [
    { key: "view", type: "enum", settingKey: "view", defaultValue: "says", values: [{ value: "says" }, { value: "names" }], description: "Statements by the company, or other sources naming it." },
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: [{ value: "table" }, { value: "flow" }], description: "Table or supply chain flow." },
    { key: "tiers", type: "string", settingKey: "tiers", defaultValue: "sec,company,call", description: "Comma-separated evidence tiers: sec,company,call,reported,unconfirmed. Unconfirmed explicitly includes leads." },
    { key: "evidence", type: "boolean", settingKey: "evidence", defaultValue: false, description: "Open the first relationship's source evidence in a screenshot." },
  ],
  describe: (args) => `Supply chain | ${args.symbols[0]}`,
  async load(args, ctx) {
    const options = supplyOptions(args.options.tiers);
    const data = await fetchSupplyChain(args.symbols[0]!, ctx.apiClient, options);
    return { complete: !data.truncated, errors: data.truncated ? ["Additional relationships need Gloom Pro"] : [],
      sections: (["says", "names"] as const).flatMap((view) => [false, true].map((leads) => ({ title: `${view === "says" ? `${data.symbol} says` : `Names ${data.symbol}`}${leads ? " | Unconfirmed" : ""}`,
        rows: data[view].filter((row) => matchesSupplyOptions(row, options) && isUnconfirmed(row) === leads).map((row) => ({ counterparty: row.counterparty.name, ticker: row.counterparty.ticker, aggregate: row.counterparty.aggregate, role: row.role, direction: row.direction,
          pct: row.pctOfRevenue, pctBasis: row.pctBasis, pctScope: row.pctScope, usd: row.usd, usdBasis: row.usdBasis, period: row.period, fiscalYear: row.fiscalYear,
          evidenceTier: evidenceLabel(row), tier: trustTier(row), claimType: row.claimType, corroboration: row.corroboration ?? 1,
          leadStatus: row.leadStatus ?? "none", whyUnconfirmed: row.whyUnconfirmed ?? null,
          firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, lastConfirmedAt: row.lastConfirmedAt,
          filed: row.filedDate, confidence: row.confidence, reportingCompany: row.reportingEntity.name, quote: row.quote, quoteMatchMode: row.quoteMatchMode, sourceUrl: row.filingUrl,
          evidence: row.evidence ?? [] })) })).filter((section) => section.rows.length > 0)),
      metadata: { symbol: data.symbol, asOf: data.asOf, counts: data.counts, tierCounts: data.tierCounts, tiers: options.tiers, disclaimer: data.disclaimer } };
  },
};
