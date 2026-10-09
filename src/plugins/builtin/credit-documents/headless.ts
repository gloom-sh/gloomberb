import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchCreditDocuments, fetchCreditInstrument, fetchCreditScreen } from "./client";
import { CREDIT_TABS } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";

export const creditHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: SEC_FILINGS,
  argument: { kind: "ticker", description: "Issuer ticker, including exchange-qualified global symbols.", placeholder: "ticker" },
  discovery: { aliases: ["CRDOC"], dataRequirements: ["Gloom Cloud credit-document evidence"], limitations: [
    "Pro dataset; free accounts see a limited preview", "SEC credit documents with global issuer identifiers; other jurisdictions depend on connected sources",
    "Undisclosed terms remain unavailable", "Headroom requires exact covenant definitions and supported reported financials", "Amounts retain their native currency",
  ] },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "capital", values: CREDIT_TABS.map(({ value }) => ({ value })), description: "Capital structure, covenants, maturity wall or global risk screen." },
    { key: "instrument", type: "string", settingKey: "instrument", description: "Instrument id whose complete evidence and amendment history to open." },
    { key: "fact", type: "string", settingKey: "fact", description: "Fact id to open within an instrument evidence view." },
    { key: "view", type: "enum", settingKey: "view", defaultValue: "terms", values: [{ value: "terms" }, { value: "history" }], description: "Current instrument terms or immutable revisions." },
    { key: "headroom", type: "integer", settingKey: "headroom", defaultValue: 20, minimum: 0, maximum: 100, description: "Screen headroom below this percentage." },
    { key: "months", type: "integer", settingKey: "months", defaultValue: 12, minimum: 1, maximum: 120, description: "Screen springing maturities within this many months." },
  ],
  describe: (args) => `Credit documents | ${args.symbols[0]}`,
  async load(args, ctx) {
    if (args.options.tab === "screen") {
      const data = await fetchCreditScreen({ headroomBelow: Number(args.options.headroom ?? 20), springingWithinMonths: Number(args.options.months ?? 12), limit: 100 }, ctx.apiClient);
      return { complete: data.lockedRows === 0 && !data.truncated, errors: [...(data.lockedRows ? ["More results require Gloom Pro"] : []), ...(data.truncated ? ["Screen reached the result limit"] : [])],
        sections: [{ title: "Credit risk screen", rows: data.rows.map((row) => ({ ...row })) }], metadata: { asOf: data.asOf, access: data.access, lockedRows: data.lockedRows } };
    }
    const data = await fetchCreditDocuments(args.symbols[0]!, ctx.apiClient);
    const instrument = args.options.instrument ? await fetchCreditInstrument(data.symbol, String(args.options.instrument), ctx.apiClient) : null;
    return { complete: data.status === "available" && data.lockedRows === 0, errors: [...data.warnings, ...(data.lockedRows ? ["Full credit documents and history require Gloom Pro"] : [])],
      sections: instrument ? [{ title: instrument.name, rows: [{ ...instrument }] }, { title: "Current terms", rows: instrument.facts.map((row) => ({ ...row })) }, { title: "Amendment history", rows: (instrument.history ?? []).map((row) => ({ ...row })) }]
        : [{ title: "Capital structure", rows: data.instruments.map((row) => ({ ...row })) }, { title: "Covenants", rows: data.covenants.map((row) => ({ ...row })) }, { title: "Maturity wall", rows: data.maturities.map((row) => ({ ...row })) }, { title: "Change of control", rows: data.changeOfControl.map((row) => ({ ...row })) }],
      metadata: { symbol: data.symbol, issuer: data.issuer, asOf: data.asOf, access: data.access, lockedRows: data.lockedRows, status: data.status } };
  },
};

export const covenantsHeadless: HeadlessPaneDefinition<"bundle"> = {
  ...creditHeadless,
  discovery: { ...creditHeadless.discovery, aliases: ["COVN"] },
  options: creditHeadless.options.map((option) => option.key === "tab" ? { ...option, defaultValue: "covenants" } : option),
};
