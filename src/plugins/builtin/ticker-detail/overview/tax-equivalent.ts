import { MISSING_VALUE } from "../../../../utils/format";
import { useCallback } from "react";
import type { FundBondFacts } from "../../../../api-client/fund-facts";
import {
  analyzeTaxEquivalent, formatMuniTreasuryRatio, loadTreasuryTenors, taxEquivalentLines,
  type NoBondFigures, type TaxEquivalentAnalysis, type TaxRates, type YieldBasis,
} from "../../../../market-data/tax-equivalent";
import { useAsyncResource } from "../../../../react/async-resource";
import { formatFundYield } from "../../../../market-data/bond-funds";
import type { StatField } from "./types";

/**
 * A fund's tax-equivalent yield and muni/Treasury ratio for the overview, at
 * the rates `fn DES MUB --tax-rate 40.8` set on the pane: the same analysis
 * DVD, ETF and fundamentals show. Null without rates, and while the fund's
 * facts or the Treasury curve are still read, so a section is never drawn
 * and then withdrawn.
 */
export function useOverviewTaxEquivalent(input: {
  symbol: string;
  tax: { rates: TaxRates } | { error: string } | null;
  /** The fund's bond facts once read: null for a fund without them, undefined while they are read. */
  bond: FundBondFacts | null | undefined;
  distribution: YieldBasis | null;
  /** Why the listing has no bond figures to read: not a fund, or a fund listed abroad. */
  noBondFigures?: NoBondFigures | null;
}): TaxEquivalentAnalysis | { error: string } | null {
  const rates = input.tax && "rates" in input.tax ? input.tax.rates : null;
  const loader = useCallback(() => loadTreasuryTenors(), []);
  // A listing with no bond figures to read has no ratio to divide either.
  const treasury = useAsyncResource(rates && !input.noBondFigures ? loader : null);
  if (!input.tax) return null;
  if ("error" in input.tax) return input.tax;
  if (input.bond === undefined || (treasury.loading && !treasury.data)) return null;
  return analyzeTaxEquivalent({
    symbol: input.symbol, bond: input.bond, rates: input.tax.rates, distribution: input.distribution, treasury: treasury.data ?? null,
    noBondFigures: input.noBondFigures ?? null,
  });
}

/**
 * The analysis as overview figures, as narrow as the bond figures beside
 * them: the rate, the tax-equivalent yield and what it is on, the ratio and
 * the Treasury it divides by. A figure that is missing reads `—` with why,
 * cut to fit; DVD and fundamentals give the formulas whole.
 */
export function taxEquivalentFields(analysis: TaxEquivalentAnalysis | { error: string }): StatField[] {
  const missing = (label: string, why: string): StatField => ({ label, value: MISSING_VALUE, detail: why, clipDetail: true });
  if ("error" in analysis) return [missing("Tax-Eq Yld", analysis.error)];
  const lines = taxEquivalentLines(analysis);
  const line = (key: string) => lines.find((entry) => entry.key === key);
  const fields: StatField[] = [];
  const rate = line("taxRate");
  if (rate) fields.push({ label: "Tax Rate", value: rate.export.formatted, detail: analysis.stateApplied && analysis.rates.state ? `federal + ${analysis.rates.state.code}` : "federal" });
  const basis = analysis.basis;
  if (analysis.checkError || analysis.notApplicable || analysis.taxEquivalentYield == null || !basis) {
    fields.push(missing("Tax-Eq Yld", (analysis.checkError ?? analysis.notApplicable ?? "").replace(/^no tax-equivalent yield: /, "")));
    return fields;
  }
  fields.push({ label: "Tax-Eq Yld", value: formatFundYield(analysis.taxEquivalentYield),
    detail: basis.kind === "sec"
      ? [`on SEC yield${basis.asOf ? ` ${basis.asOf}` : ""}`, "on SEC yield", "SEC"]
      : [`on ${basis.label}`, "on dist yield", "dist"] });
  const ratio = analysis.ratio;
  fields.push(ratio
    ? { label: "Muni/Tsy", value: formatMuniTreasuryRatio(ratio.value),
      detail: [`vs ${ratio.treasury.tenor} ${formatFundYield(ratio.treasury.yield)}${ratio.treasury.asOf ? ` ${ratio.treasury.asOf}` : ""}`, `vs ${ratio.treasury.tenor} ${formatFundYield(ratio.treasury.yield)}`, `vs ${ratio.treasury.tenor}`] }
    : missing("Muni/Tsy", (analysis.ratioNote ?? "").replace(/^no ratio: /, "")));
  return fields;
}
