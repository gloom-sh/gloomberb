import type { FinancialStatement } from "../../../../types/financials";
import { completeAvailability, statementFieldAvailability } from "../../../../utils/financial-statements";

export type FinancialPeriod = "annual" | "quarterly";

export interface FinancialTableStatement extends FinancialStatement {
  aggregation?: {
    kind: "trailing-four-quarters";
    periodEnd: string;
    sourcePeriods: Array<Pick<FinancialStatement,
      "date" | "currency" | "dateSource" | "providerDate" | "dateEvidence" | "availableAt" | "fieldAvailability" | "fieldSources" | "unavailableFields" | "unavailableEarnings"
    >>;
  };
}

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
  "netIncomeIncludingNoncontrollingInterests",
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
): FinancialTableStatement | null {
  if (statements.length !== 4) return null;
  // A provider may return semiannual reports or skip a quarter. Four rows do
  // not necessarily cover twelve months; never label those sums as TTM.
  for (let index = 1; index < statements.length; index += 1) {
    const days = (Date.parse(statements[index]!.date) - Date.parse(statements[index - 1]!.date)) / 86_400_000;
    if (!Number.isFinite(days) || days < 60 || days > 120) return null;
  }
  const currencies = new Set(statements.map((statement) => statement.currency));
  if (currencies.size > 1) return null;
  // Its counts and EPS are on the quarters' share basis when all four state the same one.
  const shareBases = new Set(statements.map((statement) => statement.shareBasis));
  const shareBasis = shareBases.size === 1 ? [...shareBases][0] : undefined;

  const aggregate: FinancialTableStatement = {
    date,
    currency: [...currencies][0],
    ...(shareBasis ? { shareBasis } : {}),
    aggregation: {
      kind: "trailing-four-quarters",
      periodEnd: statements.at(-1)!.date,
      sourcePeriods: statements.map(({ date, currency, dateSource, providerDate, dateEvidence, availableAt, fieldAvailability, fieldSources, unavailableFields, unavailableEarnings }) => ({
        date, currency, dateSource, providerDate,
        ...(dateEvidence ? { dateEvidence: { ...dateEvidence } } : {}),
        availableAt,
        ...(fieldAvailability ? { fieldAvailability: { ...fieldAvailability } } : {}),
        ...(fieldSources ? { fieldSources: { ...fieldSources } } : {}),
        ...(unavailableFields ? { unavailableFields: [...unavailableFields] } : {}),
        ...(unavailableEarnings ? { unavailableEarnings: [...unavailableEarnings] } : {}),
      })),
    },
  };
  const availability: Record<string, string> = {};
  const includedFields: string[] = [];
  const retainAvailability = (key: string, sources: FinancialStatement[]) => {
    includedFields.push(key);
    const availableAt = completeAvailability(sources.map((source) => statementFieldAvailability(source, key)));
    if (availableAt) availability[key] = availableAt;
  };
  for (const key of FLOW_KEYS) {
    const values = statements
      .map((statement) => (statement as unknown as Record<string, unknown>)[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 4) {
      (aggregate as unknown as Record<string, unknown>)[key] = values.reduce((left, right) => left + right, 0);
      retainAvailability(key, statements);
    }
  }

  const latest = statements[statements.length - 1]!;
  for (const key of BALANCE_KEYS) {
    const value = (latest as unknown as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      (aggregate as unknown as Record<string, unknown>)[key] = value;
      retainAvailability(key, [latest]);
    }
  }

  const openingCash = statements[0]!.beginningCashPosition;
  if (openingCash != null && Number.isFinite(openingCash)) {
    aggregate.beginningCashPosition = openingCash;
    retainAvailability("beginningCashPosition", [statements[0]!]);
  }

  // These are average shares over each quarter, unlike balance-sheet shares.
  for (const key of ["basicShares", "dilutedShares"] as const) {
    const values = statements.map((statement) => statement[key]);
    if (values.every((value): value is number => value != null && Number.isFinite(value))) {
      aggregate[key] = values.reduce((sum, value) => sum + value, 0) / 4;
      retainAvailability(key, statements);
    }
  }
  if (Object.keys(availability).length > 0) aggregate.fieldAvailability = availability;
  const availableAt = completeAvailability(includedFields.map((key) => availability[key]));
  if (availableAt) aggregate.availableAt = availableAt;
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
    // Providers can include off-cycle 12-month observations (for example ADR
    // EPS) between fiscal years. They must not hide a comparable prior year.
    // More than one annual candidate is ambiguous; do not guess its identity.
    const candidates = period === "annual"
      ? sourceStatements.filter((candidate) => {
        const days = (Date.parse(current.date) - Date.parse(candidate.date)) / 86_400_000;
        return days >= 300 && days <= 430;
      })
      : [sourceStatements[index - 1]!];
    if (candidates.length !== 1) continue;
    const previous = candidates[0]!;
    const days = (Date.parse(current.date) - Date.parse(previous.date)) / 86_400_000;
    const [minimum, maximum] = period === "annual" ? [300, 430] : [60, 120];
    if (days < minimum! || days > maximum! || !Number.isFinite(days)) continue;
    previousMap.set(current.date, previous);
  }

  if (ttm) {
    const previousTtm = computePreviousTtm(quarterlyStatements);
    const latest = quarterlyStatements.at(-1);
    const prior = quarterlyStatements.at(-5);
    const days = latest && prior ? (Date.parse(latest.date) - Date.parse(prior.date)) / 86_400_000 : NaN;
    if (previousTtm && days >= 300 && days <= 430) {
      previousMap.set("TTM", previousTtm);
    }
  }

  return previousMap;
}
