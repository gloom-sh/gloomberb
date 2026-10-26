import type { HeadlessPaneDefinition } from "../../../types/plugin";
import type { CreditDocumentsPayload } from "../../../api-client/credit-documents";
import { creditIssuerSymbol, fetchCreditDocuments, fetchCreditInstrument, fetchCreditScreen } from "./client";
import { capitalSection, controlSection, covenantSection, instrumentSections, maturitySection, screenSection } from "./export";
import { CREDIT_TABS } from "./model";
import { SEC_FILINGS } from "../shared/report-freshness";

export const creditHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle",
  freshness: SEC_FILINGS,
  argument: { kind: "ticker", description: "Issuer ticker, including exchange-qualified global symbols.", placeholder: "ticker" },
  discovery: { aliases: ["CRDOC"], dataRequirements: ["Gloom Cloud credit-document evidence"], limitations: [
    "Pro dataset; free accounts see a limited preview.", "SEC credit documents with global issuer identifiers; other jurisdictions depend on connected sources.",
    "Undisclosed terms remain unavailable.", "Headroom requires exact covenant definitions and supported reported financials.", "Amounts retain their native currency.",
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
        sections: [screenSection(data)], metadata: { asOf: data.asOf, access: data.access, lockedRows: data.lockedRows } };
    }
    const data = await fetchCreditDocuments(args.symbols[0]!, ctx.apiClient);
    const instrument = args.options.instrument ? await fetchCreditInstrument(data.symbol, String(args.options.instrument), ctx.apiClient) : null;
    const reason = instrument ? null : creditEmptyReason(data, args.symbols[0]!);
    // Nothing on file says why once, instead of four empty sections.
    if (reason) {
      return { complete: false, errors: data.warnings, sections: [],
        metadata: { symbol: data.symbol, issuer: data.issuer, asOf: data.asOf, access: data.access, lockedRows: data.lockedRows, status: data.status, reason, notices: [reason] } };
    }
    return { complete: data.status === "available" && data.lockedRows === 0, errors: [...data.warnings, ...(data.lockedRows ? ["Full credit documents and history require Gloom Pro"] : [])],
      sections: instrument ? instrumentSections(data, instrument) : [capitalSection(data), covenantSection(data), maturitySection(data), controlSection(data)],
      metadata: { symbol: data.symbol, issuer: data.issuer, asOf: data.asOf, access: data.access, lockedRows: data.lockedRows, status: data.status } };
  },
};

/** An issuer whose documents the catalog and the docs use as the example. */
const CREDIT_EXAMPLE_SYMBOL = "FICO";

/**
 * Why an issuer's report has no rows at all, from the payload: no issuer on
 * file for the symbol, or an issuer with no debt instrument read from its
 * filings yet; with the command for an issuer that has documents. Null when
 * any section has a row.
 */
export function creditEmptyReason(
  data: Pick<CreditDocumentsPayload, "symbol" | "issuer" | "instruments" | "covenants" | "maturities" | "changeOfControl" | "lockedRows">,
  requested: string,
): string | null {
  const rows = data.instruments.length + data.covenants.length + data.maturities.length + data.changeOfControl.length;
  if (rows > 0 || data.lockedRows > 0) return null;
  const symbol = requested.trim().toUpperCase();
  const why = data.issuer
    ? `No credit documents on file for ${data.issuer.name} (${symbol}): no debt instrument has been read from its filings yet.`
    : `No credit documents on file for ${symbol}: it is not an issuer the credit-document set covers.`;
  const example = creditIssuerSymbol(symbol) === CREDIT_EXAMPLE_SYMBOL ? "" : ` Try \`gloom fn CRDOC ${CREDIT_EXAMPLE_SYMBOL}\` for an issuer with documents.`;
  return `${why}${example}`;
}

export const covenantsHeadless: HeadlessPaneDefinition<"bundle"> = {
  ...creditHeadless,
  discovery: { ...creditHeadless.discovery, aliases: ["COVN"] },
  options: creditHeadless.options.map((option) => option.key === "tab" ? { ...option, defaultValue: "covenants" } : option),
};
