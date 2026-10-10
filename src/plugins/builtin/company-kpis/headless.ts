import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { resolveHeadlessIssuerListing } from "../shared/headless-market-data";
import { companyQuery, fetchCompanyData, type CompanyMode } from "./client";

export function companyHeadless(mode: CompanyMode): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    freshness: { source: "Company filings and calls", status: "not-a-feed", basis: "reported data" },
    argument: { kind: "ticker", description: "Listed company ticker, including exchange-qualified global symbols.", placeholder: "ticker" },
    discovery: { aliases: [mode === "kpis" ? "KPIS" : "GUIDE"], dataRequirements: ["Gloom Cloud company disclosures"],
      limitations: ["Pro dataset with a fixed latest preview on Free", "Coverage follows available company disclosures; missing data is not zero", "Compare matching definition, period, currency, basis and scope", "Fiscal labels without explicit calendar dates are retained without inferred dates"] },
    options: [
      { key: "tab", type: "enum", settingKey: "tab", defaultValue: "table", values: [{ value: "table" }, { value: "chart" }, ...(mode === "guidance" ? [{ value: "history" }] : []), { value: "evidence" }], description: "The pane section to render." },
      { key: "metric", type: "string", settingKey: "metric", description: "Canonical metric ID, such as arr or subscribers." },
      { key: "basis", type: "enum", values: [{ value: "reported" }, { value: "adjusted" }, { value: "constant_currency" }, { value: "organic" }], description: "Accounting basis filter (Pro)." },
      { key: "from", type: "string", description: "First calendar period end, YYYY-MM-DD (Pro)." },
      { key: "to", type: "string", description: "Last calendar period end, YYYY-MM-DD (Pro)." },
      { key: "asOf", type: "string", description: "Point-in-time publication cutoff, YYYY-MM-DD (Pro)." },
    ],
    describe: (args) => `${mode === "kpis" ? "Company KPIs" : "Company guidance"} | ${args.symbols[0]}`,
    async load(args, ctx) {
      const options = companyQuery(args.options);
      const symbol = args.symbols[0]!;
      const data = await fetchCompanyData(mode, symbol, options, ctx.apiClient, await resolveHeadlessIssuerListing(ctx, symbol));
      return { complete: !data.truncated, errors: data.truncated ? [data.access === "preview" ? "Full disclosures and history require Gloom Pro" : "Response limit reached; narrow the metric or date range"] : [],
        sections: "series" in data ? [
          { title: "Latest KPIs", rows: data.series.map((series) => ({ ...series.latest })) },
          { title: "KPI history", rows: data.series.flatMap((series) => series.observations.map((row) => ({ ...row }))) },
          { title: "Revisions and conflicts", rows: data.revisions.map((row) => ({ ...row })) },
        ] : [{ title: "Current guidance", rows: data.guidance.map((row) => ({ ...row })) }, { title: "Guidance history", rows: data.history.map((row) => ({ ...row })) }],
        metadata: { symbol: data.symbol, asOf: data.asOf, access: data.access, coverage: data.coverage, dictionary: data.dictionary,
          lockedRows: data.lockedRows, totalRows: data.totalRows, methodology: data.methodology } };
    },
  };
}
