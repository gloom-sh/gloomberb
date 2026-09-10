import type { FinancialStatement } from "../../../../types/financials";

export type FinancialPeriod = "annual" | "quarterly";

const FLOW_KEYS = new Set<string>([
  "totalRevenue",
  "costOfRevenue",
  "grossProfit",
  "sellingGeneralAndAdministration",
  "researchAndDevelopment",
  "operatingExpense",
  "operatingIncome",
  "operatingRevenue",
  "totalExpenses",
  "pretaxIncome",
  "normalizedIncome",
  "netIncomeCommonStockholders",
  "netIncomeContinuousOperations",
  "otherIncomeExpense",
  "otherNonOperatingIncomeExpenses",
  "depreciationAmortizationDepletionIncomeStatement",
  "depreciationAndAmortizationInIncomeStatement",
  "interestExpense",
  "taxProvision",
  "netIncome",
  "ebitda",
  "basicEps",
  "eps",
  "operatingCashFlow",
  "depreciationAndAmortization",
  "depreciationAmortizationDepletion",
  "depreciation",
  "deferredIncomeTax",
  "deferredTax",
  "stockBasedCompensation",
  "otherNonCashItems",
  "changeInWorkingCapital",
  "changeInReceivables",
  "changeInInventory",
  "changeInPayable",
  "changeInAccountPayable",
  "changeInOtherWorkingCapital",
  "capitalExpenditure",
  "cashFlowFromContinuingOperatingActivities",
  "interestPaidSupplementalData",
  "incomeTaxPaidSupplementalData",
  "freeCashFlow",
  "purchaseOfPPE",
  "saleOfPPE",
  "netPPEPurchaseAndSale",
  "investingCashFlow",
  "cashFlowFromContinuingInvestingActivities",
  "purchaseOfBusiness",
  "saleOfBusiness",
  "netBusinessPurchaseAndSale",
  "purchaseOfInvestment",
  "saleOfInvestment",
  "netInvestmentPurchaseAndSale",
  "netOtherInvestingChanges",
  "financingCashFlow",
  "cashFlowFromContinuingFinancingActivities",
  "issuanceOfDebt",
  "repaymentOfDebt",
  "netIssuancePaymentsOfDebt",
  "longTermDebtIssuance",
  "longTermDebtPayments",
  "netLongTermDebtIssuance",
  "shortTermDebtIssuance",
  "shortTermDebtPayments",
  "netShortTermDebtIssuance",
  "repurchaseOfCapitalStock",
  "commonStockIssuance",
  "commonStockPayments",
  "netCommonStockIssuance",
  "cashDividendsPaid",
  "commonStockDividendPaid",
  "netOtherFinancingCharges",
  "changesInCash",
  "effectOfExchangeRateChanges",
]);

const BALANCE_KEYS = new Set<string>([
  "totalAssets",
  "currentAssets",
  "cashAndCashEquivalents",
  "cashCashEquivalentsAndShortTermInvestments",
  "otherShortTermInvestments",
  "receivables",
  "accountsReceivable",
  "inventory",
  "prepaidAssets",
  "otherCurrentAssets",
  "totalNonCurrentAssets",
  "netPPE",
  "grossPPE",
  "accumulatedDepreciation",
  "goodwill",
  "otherIntangibleAssets",
  "goodwillAndOtherIntangibleAssets",
  "investmentsAndAdvances",
  "otherNonCurrentAssets",
  "totalLiabilities",
  "currentLiabilities",
  "currentDebt",
  "currentDebtAndCapitalLeaseObligation",
  "payablesAndAccruedExpenses",
  "currentAccruedExpenses",
  "payables",
  "accountsPayable",
  "currentDeferredRevenue",
  "currentDeferredLiabilities",
  "otherCurrentLiabilities",
  "totalNonCurrentLiabilities",
  "longTermDebt",
  "longTermDebtAndCapitalLeaseObligation",
  "longTermCapitalLeaseObligation",
  "nonCurrentDeferredLiabilities",
  "nonCurrentDeferredTaxesLiabilities",
  "otherNonCurrentLiabilities",
  "totalDebt",
  "capitalLeaseObligations",
  "totalCapitalization",
  "totalEquity",
  "totalEquityGrossMinorityInterest",
  "commonStockEquity",
  "commonStock",
  "capitalStock",
  "additionalPaidInCapital",
  "treasuryStock",
  "gainsLossesNotAffectingRetainedEarnings",
  "otherEquityAdjustments",
  "retainedEarnings",
  "longTermEquityInvestment",
  "workingCapital",
  "netTangibleAssets",
  "investedCapital",
  "tangibleBookValue",
  "shareIssued",
  "ordinarySharesNumber",
  "treasurySharesNumber",
  "endCashPosition",
]);

function aggregateQuarterlyStatements(
  statements: FinancialStatement[],
  date: string,
): FinancialStatement | null {
  if (statements.length !== 4) return null;
  // A provider may return semiannual reports or skip a quarter. Four rows do
  // not necessarily cover twelve months; never label those sums as TTM.
  for (let index = 1; index < statements.length; index += 1) {
    const days = (Date.parse(statements[index]!.date) - Date.parse(statements[index - 1]!.date)) / 86_400_000;
    if (!Number.isFinite(days) || days < 60 || days > 120) return null;
  }
  const currencies = new Set(statements.map((statement) => statement.currency));
  if (currencies.size > 1) return null;

  const aggregate: FinancialStatement = { date, currency: [...currencies][0] };
  for (const key of FLOW_KEYS) {
    const values = statements
      .map((statement) => (statement as unknown as Record<string, unknown>)[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 4) {
      (aggregate as unknown as Record<string, unknown>)[key] = values.reduce((left, right) => left + right, 0);
    }
  }

  const latest = statements[statements.length - 1]!;
  for (const key of BALANCE_KEYS) {
    const value = (latest as unknown as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      (aggregate as unknown as Record<string, unknown>)[key] = value;
    }
  }

  const openingCash = statements[0]!.beginningCashPosition;
  if (openingCash != null && Number.isFinite(openingCash)) aggregate.beginningCashPosition = openingCash;

  // These are average shares over each quarter, unlike balance-sheet shares.
  for (const key of ["basicShares", "dilutedShares"] as const) {
    const values = statements.map((statement) => statement[key]);
    if (values.every((value): value is number => value != null && Number.isFinite(value))) {
      aggregate[key] = values.reduce((sum, value) => sum + value, 0) / 4;
    }
  }
  return aggregate;
}

export function computeTTM(quarterlyStatements: FinancialStatement[]) {
  return aggregateQuarterlyStatements([...quarterlyStatements].sort((a, b) => a.date.localeCompare(b.date)).slice(-4), "TTM");
}

function computePreviousTtm(quarterlyStatements: FinancialStatement[]) {
  return aggregateQuarterlyStatements([...quarterlyStatements].sort((a, b) => a.date.localeCompare(b.date)).slice(-8, -4), "prevTTM");
}

export function buildPreviousStatementMap(
  period: FinancialPeriod,
  annualStatements: FinancialStatement[],
  quarterlyStatements: FinancialStatement[],
  ttm: FinancialStatement | null,
) {
  const sourceStatements = period === "annual" ? annualStatements : quarterlyStatements;
  const previousMap = new Map<string, FinancialStatement>();

  for (let index = 1; index < sourceStatements.length; index += 1) {
    const current = sourceStatements[index]!;
    const previous = sourceStatements[index - 1]!;
    const days = (Date.parse(current.date) - Date.parse(previous.date)) / 86_400_000;
    const [minimum, maximum] = period === "annual" ? [300, 430] : [60, 120];
    if (days < minimum! || days > maximum! || !Number.isFinite(days)) continue;
    if (current.currency && previous.currency && current.currency !== previous.currency) continue;
    previousMap.set(current.date, previous);
  }

  if (ttm) {
    const previousTtm = computePreviousTtm(quarterlyStatements);
    const latest = quarterlyStatements.at(-1);
    const prior = quarterlyStatements.at(-5);
    const days = latest && prior ? (Date.parse(latest.date) - Date.parse(prior.date)) / 86_400_000 : NaN;
    if (previousTtm && days >= 300 && days <= 430 && (!ttm.currency || !previousTtm.currency || ttm.currency === previousTtm.currency)) {
      previousMap.set("TTM", previousTtm);
    }
  }

  return previousMap;
}
