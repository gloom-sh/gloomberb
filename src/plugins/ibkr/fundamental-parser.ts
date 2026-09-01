import type { Fundamentals, FinancialStatement } from "../../types/financials";

/**
 * Parse IBKR ReportSnapshot XML (from getFundamentalData "ReportSnapshot")
 * into a Fundamentals object. Uses <Ratio FieldName="...">value</Ratio> tags.
 */
export function parseReportSnapshot(xml: string): Fundamentals {
  const ratios = new Map<string, number>();
  const ratioRegex = /<Ratio\s+FieldName="([^"]+)"[^>]*>([^<]+)<\/Ratio>/gi;
  let match: RegExpExecArray | null;
  while ((match = ratioRegex.exec(xml)) !== null) {
    const value = parseFloat(match[2]!);
    if (Number.isFinite(value)) {
      ratios.set(match[1]!.toUpperCase(), value);
    }
  }

  const get = (key: string): number | undefined => ratios.get(key.toUpperCase());

  const fundamentals: Fundamentals = {};

  const trailingPE = get("PEEXCLXOR");
  if (trailingPE != null) fundamentals.trailingPE = trailingPE;

  const forwardPE = get("APENORM");
  if (forwardPE != null) fundamentals.forwardPE = forwardPE;

  const pegRatio = get("PEGR");
  if (pegRatio != null) fundamentals.pegRatio = pegRatio;

  const eps = get("TTMEPSXCLX");
  if (eps != null) fundamentals.eps = eps;

  const dividendYield = get("YIELD");
  if (dividendYield != null) fundamentals.dividendYield = dividendYield / 100;

  const revenue = get("TTMREV");
  if (revenue != null) fundamentals.revenue = revenue * 1_000_000;

  const netIncome = get("TTMNIAC");
  if (netIncome != null) fundamentals.netIncome = netIncome * 1_000_000;

  const freeCashFlow = get("TTMFCF");
  if (freeCashFlow != null) fundamentals.freeCashFlow = freeCashFlow * 1_000_000;

  const operatingMargin = get("TTMOPMGN");
  if (operatingMargin != null) fundamentals.operatingMargin = operatingMargin / 100;

  const profitMargin = get("TTMNPMGN");
  if (profitMargin != null) fundamentals.profitMargin = profitMargin / 100;

  const enterpriseValue = get("ENTRVAL");
  if (enterpriseValue != null) fundamentals.enterpriseValue = enterpriseValue * 1_000_000;

  const revenueGrowth = get("REVCHNGYR");
  if (revenueGrowth != null) fundamentals.revenueGrowth = revenueGrowth / 100;

  const sharesOutstanding = get("SHAESSION");
  if (sharesOutstanding != null) fundamentals.sharesOutstanding = sharesOutstanding;

  return fundamentals;
}

/** COA code → FinancialStatement field mapping */
const COA_MAP: Record<string, keyof FinancialStatement> = {
  SREV: "totalRevenue",
  SCOR: "costOfRevenue",
  SGRP: "grossProfit",
  SSGA: "sellingGeneralAndAdministration",
  ERAD: "researchAndDevelopment",
  ETOE: "operatingExpense",
  SOPI: "operatingIncome",
  STIE: "interestExpense",
  TTAX: "taxProvision",
  NINC: "netIncome",
  SDAJ: "eps",
  SDBF: "basicEps",
  SDWS: "dilutedShares",
  ATOT: "totalAssets",
  ATCA: "currentAssets",
  ACAE: "cashAndCashEquivalents",
  LTLL: "totalLiabilities",
  LTCL: "currentLiabilities",
  LTTD: "longTermDebt",
  STLD: "totalDebt",
  QTLE: "totalEquity",
  QRED: "retainedEarnings",
  OTLO: "operatingCashFlow",
  SCEX: "capitalExpenditure",
  ITLI: "investingCashFlow",
  FTLF: "financingCashFlow",
  FPRD: "issuanceOfDebt",
  FPSS: "repurchaseOfCapitalStock",
  FCDP: "cashDividendsPaid",
};

function parsePeriods(xml: string, sectionTag: string): FinancialStatement[] {
  const sectionRegex = new RegExp(`<${sectionTag}[^>]*>([\\s\\S]*?)<\\/${sectionTag}>`, "i");
  const sectionMatch = sectionRegex.exec(xml);
  if (!sectionMatch) return [];

  const section = sectionMatch[1]!;
  const statements: FinancialStatement[] = [];

  // Match each FiscalPeriod
  const periodRegex = /<FiscalPeriod[^>]*EndDate="([^"]+)"[^>]*>([\s\S]*?)<\/FiscalPeriod>/gi;
  let periodMatch: RegExpExecArray | null;

  while ((periodMatch = periodRegex.exec(section)) !== null) {
    const endDate = periodMatch[1]!;
    const periodContent = periodMatch[2]!;
    const stmt: FinancialStatement = { date: endDate };

    // Match all lineItems across all Statement types
    const lineItemRegex = /<lineItem\s+[^>]*coaCode="([^"]+)"[^>]*>([^<]+)<\/lineItem>/gi;
    let lineMatch: RegExpExecArray | null;

    while ((lineMatch = lineItemRegex.exec(periodContent)) !== null) {
      const coaCode = lineMatch[1]!.toUpperCase();
      const field = COA_MAP[coaCode];
      if (field && field !== "date") {
        const value = parseFloat(lineMatch[2]!);
        if (Number.isFinite(value)) {
          (stmt as any)[field] = value;
        }
      }
    }

    // Compute freeCashFlow if not directly available
    if (stmt.freeCashFlow == null && stmt.operatingCashFlow != null && stmt.capitalExpenditure != null) {
      stmt.freeCashFlow = stmt.operatingCashFlow - Math.abs(stmt.capitalExpenditure);
    }

    statements.push(stmt);
  }

  return statements;
}

/**
 * Parse IBKR ReportsFinStatements XML (from getFundamentalData "ReportsFinStatements")
 * into annual and quarterly FinancialStatement arrays.
 */
export function parseFinStatements(xml: string): { annual: FinancialStatement[]; quarterly: FinancialStatement[] } {
  return {
    annual: parsePeriods(xml, "AnnualPeriods"),
    quarterly: parsePeriods(xml, "InterimPeriods"),
  };
}
