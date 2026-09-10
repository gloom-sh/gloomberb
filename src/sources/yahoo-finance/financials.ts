import type { FinancialStatement, PricePoint } from "../../types/financials";

export const YAHOO_TIMESERIES_TYPES = {
  annual: [
    "annualTotalRevenue", "annualCostOfRevenue", "annualGrossProfit",
    "annualSellingGeneralAndAdministration", "annualResearchAndDevelopment",
    "annualOperatingExpense", "annualOperatingIncome",
    "annualOperatingRevenue", "annualTotalExpenses", "annualPretaxIncome",
    "annualNormalizedIncome", "annualNetIncomeCommonStockholders",
    "annualNetIncomeContinuousOperations", "annualOtherIncomeExpense",
    "annualOtherNonOperatingIncomeExpenses",
    "annualDepreciationAmortizationDepletionIncomeStatement",
    "annualDepreciationAndAmortizationInIncomeStatement",
    "annualInterestExpense", "annualTaxProvision",
    "annualNetIncome", "annualEBITDA",
    "annualBasicEPS", "annualDilutedEPS",
    "annualBasicAverageShares", "annualDilutedAverageShares",
    "annualOperatingCashFlow", "annualCapitalExpenditure", "annualFreeCashFlow",
    "annualDepreciationAndAmortization", "annualDeferredIncomeTax",
    "annualDepreciationAmortizationDepletion", "annualDepreciation",
    "annualDeferredTax", "annualStockBasedCompensation", "annualOtherNonCashItems",
    "annualChangeInWorkingCapital",
    "annualChangeInReceivables", "annualChangeInInventory",
    "annualChangeInPayable", "annualChangeInAccountPayable",
    "annualChangeInOtherWorkingCapital", "annualPurchaseOfPPE", "annualSaleOfPPE",
    "annualNetPPEPurchaseAndSale",
    "annualInvestingCashFlow", "annualFinancingCashFlow",
    "annualCashFlowFromContinuingOperatingActivities",
    "annualInterestPaidSupplementalData", "annualIncomeTaxPaidSupplementalData",
    "annualCashFlowFromContinuingInvestingActivities",
    "annualPurchaseOfBusiness", "annualSaleOfBusiness", "annualNetBusinessPurchaseAndSale",
    "annualPurchaseOfInvestment", "annualSaleOfInvestment", "annualNetInvestmentPurchaseAndSale",
    "annualNetOtherInvestingChanges", "annualCashFlowFromContinuingFinancingActivities",
    "annualIssuanceOfDebt", "annualRepaymentOfDebt",
    "annualNetIssuancePaymentsOfDebt", "annualRepurchaseOfCapitalStock",
    "annualLongTermDebtIssuance", "annualLongTermDebtPayments", "annualNetLongTermDebtIssuance",
    "annualShortTermDebtIssuance", "annualShortTermDebtPayments", "annualNetShortTermDebtIssuance",
    "annualCommonStockIssuance", "annualCommonStockPayments", "annualNetCommonStockIssuance",
    "annualCashDividendsPaid", "annualCommonStockDividendPaid", "annualNetOtherFinancingCharges",
    "annualBeginningCashPosition", "annualEndCashPosition",
    "annualChangesInCash", "annualEffectOfExchangeRateChanges",
    "annualTotalAssets", "annualCurrentAssets", "annualCashAndCashEquivalents",
    "annualCashCashEquivalentsAndShortTermInvestments", "annualOtherShortTermInvestments",
    "annualReceivables", "annualAccountsReceivable", "annualInventory",
    "annualPrepaidAssets", "annualOtherCurrentAssets", "annualTotalNonCurrentAssets",
    "annualNetPPE", "annualGrossPPE", "annualAccumulatedDepreciation",
    "annualGoodwill", "annualOtherIntangibleAssets", "annualGoodwillAndOtherIntangibleAssets",
    "annualInvestmentsAndAdvances", "annualOtherNonCurrentAssets",
    "annualTotalLiabilitiesNetMinorityInterest", "annualCurrentLiabilities",
    "annualCurrentDebt", "annualCurrentDebtAndCapitalLeaseObligation",
    "annualPayablesAndAccruedExpenses", "annualCurrentAccruedExpenses",
    "annualPayables", "annualAccountsPayable", "annualCurrentDeferredRevenue",
    "annualCurrentDeferredLiabilities",
    "annualOtherCurrentLiabilities", "annualTotalNonCurrentLiabilitiesNetMinorityInterest",
    "annualLongTermDebt", "annualLongTermDebtAndCapitalLeaseObligation",
    "annualLongTermCapitalLeaseObligation", "annualNonCurrentDeferredLiabilities",
    "annualNonCurrentDeferredTaxesLiabilities", "annualOtherNonCurrentLiabilities",
    "annualTotalDebt", "annualCapitalLeaseObligations", "annualTotalCapitalization",
    "annualStockholdersEquity", "annualTotalEquityGrossMinorityInterest",
    "annualCommonStockEquity", "annualCommonStock", "annualCapitalStock",
    "annualAdditionalPaidInCapital", "annualTreasuryStock",
    "annualGainsLossesNotAffectingRetainedEarnings", "annualOtherEquityAdjustments",
    "annualRetainedEarnings", "annualLongTermEquityInvestment",
    "annualWorkingCapital", "annualNetTangibleAssets", "annualInvestedCapital",
    "annualTangibleBookValue", "annualShareIssued", "annualOrdinarySharesNumber",
    "annualTreasurySharesNumber",
  ],
  quarterly: [
    "quarterlyTotalRevenue", "quarterlyCostOfRevenue", "quarterlyGrossProfit",
    "quarterlySellingGeneralAndAdministration", "quarterlyResearchAndDevelopment",
    "quarterlyOperatingExpense", "quarterlyOperatingIncome",
    "quarterlyOperatingRevenue", "quarterlyTotalExpenses", "quarterlyPretaxIncome",
    "quarterlyNormalizedIncome", "quarterlyNetIncomeCommonStockholders",
    "quarterlyNetIncomeContinuousOperations", "quarterlyOtherIncomeExpense",
    "quarterlyOtherNonOperatingIncomeExpenses",
    "quarterlyDepreciationAmortizationDepletionIncomeStatement",
    "quarterlyDepreciationAndAmortizationInIncomeStatement",
    "quarterlyInterestExpense", "quarterlyTaxProvision",
    "quarterlyNetIncome", "quarterlyEBITDA",
    "quarterlyBasicEPS", "quarterlyDilutedEPS",
    "quarterlyBasicAverageShares", "quarterlyDilutedAverageShares",
    "quarterlyOperatingCashFlow", "quarterlyCapitalExpenditure", "quarterlyFreeCashFlow",
    "quarterlyDepreciationAndAmortization", "quarterlyDeferredIncomeTax",
    "quarterlyDepreciationAmortizationDepletion", "quarterlyDepreciation",
    "quarterlyDeferredTax", "quarterlyStockBasedCompensation", "quarterlyOtherNonCashItems",
    "quarterlyChangeInWorkingCapital",
    "quarterlyChangeInReceivables", "quarterlyChangeInInventory",
    "quarterlyChangeInPayable", "quarterlyChangeInAccountPayable",
    "quarterlyChangeInOtherWorkingCapital", "quarterlyPurchaseOfPPE", "quarterlySaleOfPPE",
    "quarterlyNetPPEPurchaseAndSale",
    "quarterlyInvestingCashFlow", "quarterlyFinancingCashFlow",
    "quarterlyCashFlowFromContinuingOperatingActivities",
    "quarterlyInterestPaidSupplementalData", "quarterlyIncomeTaxPaidSupplementalData",
    "quarterlyCashFlowFromContinuingInvestingActivities",
    "quarterlyPurchaseOfBusiness", "quarterlySaleOfBusiness", "quarterlyNetBusinessPurchaseAndSale",
    "quarterlyPurchaseOfInvestment", "quarterlySaleOfInvestment", "quarterlyNetInvestmentPurchaseAndSale",
    "quarterlyNetOtherInvestingChanges", "quarterlyCashFlowFromContinuingFinancingActivities",
    "quarterlyIssuanceOfDebt", "quarterlyRepaymentOfDebt",
    "quarterlyNetIssuancePaymentsOfDebt", "quarterlyRepurchaseOfCapitalStock",
    "quarterlyLongTermDebtIssuance", "quarterlyLongTermDebtPayments", "quarterlyNetLongTermDebtIssuance",
    "quarterlyShortTermDebtIssuance", "quarterlyShortTermDebtPayments", "quarterlyNetShortTermDebtIssuance",
    "quarterlyCommonStockIssuance", "quarterlyCommonStockPayments",
    "quarterlyNetCommonStockIssuance", "quarterlyCashDividendsPaid",
    "quarterlyCommonStockDividendPaid", "quarterlyNetOtherFinancingCharges",
    "quarterlyBeginningCashPosition", "quarterlyEndCashPosition", "quarterlyChangesInCash",
    "quarterlyEffectOfExchangeRateChanges",
    "quarterlyTotalAssets", "quarterlyCurrentAssets", "quarterlyCashAndCashEquivalents",
    "quarterlyCashCashEquivalentsAndShortTermInvestments", "quarterlyOtherShortTermInvestments",
    "quarterlyReceivables", "quarterlyAccountsReceivable", "quarterlyInventory",
    "quarterlyPrepaidAssets", "quarterlyOtherCurrentAssets", "quarterlyTotalNonCurrentAssets",
    "quarterlyNetPPE", "quarterlyGrossPPE", "quarterlyAccumulatedDepreciation",
    "quarterlyGoodwill", "quarterlyOtherIntangibleAssets", "quarterlyGoodwillAndOtherIntangibleAssets",
    "quarterlyInvestmentsAndAdvances", "quarterlyOtherNonCurrentAssets",
    "quarterlyTotalLiabilitiesNetMinorityInterest", "quarterlyCurrentLiabilities",
    "quarterlyCurrentDebt", "quarterlyCurrentDebtAndCapitalLeaseObligation",
    "quarterlyPayablesAndAccruedExpenses", "quarterlyCurrentAccruedExpenses",
    "quarterlyPayables", "quarterlyAccountsPayable", "quarterlyCurrentDeferredRevenue",
    "quarterlyCurrentDeferredLiabilities",
    "quarterlyOtherCurrentLiabilities", "quarterlyTotalNonCurrentLiabilitiesNetMinorityInterest",
    "quarterlyLongTermDebt", "quarterlyLongTermDebtAndCapitalLeaseObligation",
    "quarterlyLongTermCapitalLeaseObligation", "quarterlyNonCurrentDeferredLiabilities",
    "quarterlyNonCurrentDeferredTaxesLiabilities", "quarterlyOtherNonCurrentLiabilities",
    "quarterlyTotalDebt", "quarterlyCapitalLeaseObligations", "quarterlyTotalCapitalization",
    "quarterlyStockholdersEquity", "quarterlyTotalEquityGrossMinorityInterest",
    "quarterlyCommonStockEquity", "quarterlyCommonStock", "quarterlyCapitalStock",
    "quarterlyAdditionalPaidInCapital", "quarterlyTreasuryStock",
    "quarterlyGainsLossesNotAffectingRetainedEarnings", "quarterlyOtherEquityAdjustments",
    "quarterlyRetainedEarnings", "quarterlyLongTermEquityInvestment",
    "quarterlyWorkingCapital", "quarterlyNetTangibleAssets", "quarterlyInvestedCapital",
    "quarterlyTangibleBookValue", "quarterlyShareIssued", "quarterlyOrdinarySharesNumber",
    "quarterlyTreasurySharesNumber",
  ],
  trailing: [
    "trailingMarketCap", "trailingPeRatio", "trailingForwardPeRatio",
    "trailingPegRatio", "trailingEnterpriseValue", "trailingOperatingCashFlow",
    "trailingFreeCashFlow", "trailingDividendYield",
  ],
};

type YahooTimeseriesPoint = {
  asOfDate: string;
  currency?: string;
  periodType?: string;
  value: number;
};

export type YahooTimeseriesMetrics = Record<string, YahooTimeseriesPoint[]>;

export function parseYahooTimeseries(results: Array<Record<string, any>>): YahooTimeseriesMetrics {
  const parsed: YahooTimeseriesMetrics = {};
  for (const result of results) {
    const type = result?.meta?.type?.[0];
    if (!type) continue;
    const key = Object.keys(result).find((candidate) => candidate !== "meta" && candidate !== "timestamp");
    if (!key) continue;
    parsed[type] = (Array.isArray(result[key]) ? result[key] : [])
      .map((point: any) => ({
        asOfDate: point?.asOfDate,
        currency: typeof point?.currencyCode === "string" ? point.currencyCode : undefined,
        periodType: point?.periodType,
        value: point?.reportedValue?.raw,
      }))
      .filter((point: any) =>
        typeof point.asOfDate === "string" &&
        typeof point.value === "number" &&
        Number.isFinite(point.value)
      );
  }
  return parsed;
}

export function latestYahooMetric(metrics: YahooTimeseriesMetrics, type: string): number | undefined {
  const points = metrics[type];
  return points?.length ? points[points.length - 1]!.value : undefined;
}

export function computeYahooReturn(history: PricePoint[], days: number): number | undefined {
  if (history.length < 2) return undefined;
  const latest = history[history.length - 1]!;
  const cutoff = new Date(latest.date.getTime() - days * 86400_000);
  let baseline = history[0]!;
  for (const point of history) {
    if (point.date <= cutoff) baseline = point;
    else break;
  }
  if (!baseline.close) return undefined;
  return (latest.close - baseline.close) / baseline.close;
}

export function buildYahooStatements(
  metrics: YahooTimeseriesMetrics,
  prefix: "annual" | "quarterly",
): FinancialStatement[] {
  const byDate = new Map<string, FinancialStatement>();
  const assign = (type: string, field: keyof FinancialStatement) => {
    for (const point of metrics[type] || []) {
      const row = byDate.get(point.asOfDate) || { date: point.asOfDate };
      if (row.currency && point.currency && row.currency !== point.currency) continue;
      if (point.currency) row.currency = point.currency;
      (row as any)[field] = point.value;
      byDate.set(point.asOfDate, row);
    }
  };

  assign(`${prefix}TotalRevenue`, "totalRevenue");
  assign(`${prefix}CostOfRevenue`, "costOfRevenue");
  assign(`${prefix}GrossProfit`, "grossProfit");
  assign(`${prefix}SellingGeneralAndAdministration`, "sellingGeneralAndAdministration");
  assign(`${prefix}ResearchAndDevelopment`, "researchAndDevelopment");
  assign(`${prefix}OperatingExpense`, "operatingExpense");
  assign(`${prefix}OperatingIncome`, "operatingIncome");
  assign(`${prefix}OperatingRevenue`, "operatingRevenue");
  assign(`${prefix}TotalExpenses`, "totalExpenses");
  assign(`${prefix}PretaxIncome`, "pretaxIncome");
  assign(`${prefix}NormalizedIncome`, "normalizedIncome");
  assign(`${prefix}NetIncomeCommonStockholders`, "netIncomeCommonStockholders");
  assign(`${prefix}NetIncomeContinuousOperations`, "netIncomeContinuousOperations");
  assign(`${prefix}OtherIncomeExpense`, "otherIncomeExpense");
  assign(`${prefix}OtherNonOperatingIncomeExpenses`, "otherNonOperatingIncomeExpenses");
  assign(`${prefix}DepreciationAmortizationDepletionIncomeStatement`, "depreciationAmortizationDepletionIncomeStatement");
  assign(`${prefix}DepreciationAndAmortizationInIncomeStatement`, "depreciationAndAmortizationInIncomeStatement");
  assign(`${prefix}InterestExpense`, "interestExpense");
  assign(`${prefix}TaxProvision`, "taxProvision");
  assign(`${prefix}NetIncome`, "netIncome");
  assign(`${prefix}EBITDA`, "ebitda");
  assign(`${prefix}BasicEPS`, "basicEps");
  assign(`${prefix}DilutedEPS`, "eps");
  assign(`${prefix}BasicAverageShares`, "basicShares");
  assign(`${prefix}DilutedAverageShares`, "dilutedShares");
  assign(`${prefix}OperatingCashFlow`, "operatingCashFlow");
  assign(`${prefix}DepreciationAndAmortization`, "depreciationAndAmortization");
  assign(`${prefix}DepreciationAmortizationDepletion`, "depreciationAmortizationDepletion");
  assign(`${prefix}Depreciation`, "depreciation");
  assign(`${prefix}DeferredIncomeTax`, "deferredIncomeTax");
  assign(`${prefix}DeferredTax`, "deferredTax");
  assign(`${prefix}StockBasedCompensation`, "stockBasedCompensation");
  assign(`${prefix}OtherNonCashItems`, "otherNonCashItems");
  assign(`${prefix}ChangeInWorkingCapital`, "changeInWorkingCapital");
  assign(`${prefix}ChangeInReceivables`, "changeInReceivables");
  assign(`${prefix}ChangeInInventory`, "changeInInventory");
  assign(`${prefix}ChangeInPayable`, "changeInPayable");
  assign(`${prefix}ChangeInAccountPayable`, "changeInAccountPayable");
  assign(`${prefix}ChangeInOtherWorkingCapital`, "changeInOtherWorkingCapital");
  assign(`${prefix}CapitalExpenditure`, "capitalExpenditure");
  assign(`${prefix}CashFlowFromContinuingOperatingActivities`, "cashFlowFromContinuingOperatingActivities");
  assign(`${prefix}InterestPaidSupplementalData`, "interestPaidSupplementalData");
  assign(`${prefix}IncomeTaxPaidSupplementalData`, "incomeTaxPaidSupplementalData");
  assign(`${prefix}PurchaseOfPPE`, "purchaseOfPPE");
  assign(`${prefix}SaleOfPPE`, "saleOfPPE");
  assign(`${prefix}NetPPEPurchaseAndSale`, "netPPEPurchaseAndSale");
  assign(`${prefix}FreeCashFlow`, "freeCashFlow");
  assign(`${prefix}InvestingCashFlow`, "investingCashFlow");
  assign(`${prefix}CashFlowFromContinuingInvestingActivities`, "cashFlowFromContinuingInvestingActivities");
  assign(`${prefix}PurchaseOfBusiness`, "purchaseOfBusiness");
  assign(`${prefix}SaleOfBusiness`, "saleOfBusiness");
  assign(`${prefix}NetBusinessPurchaseAndSale`, "netBusinessPurchaseAndSale");
  assign(`${prefix}PurchaseOfInvestment`, "purchaseOfInvestment");
  assign(`${prefix}SaleOfInvestment`, "saleOfInvestment");
  assign(`${prefix}NetInvestmentPurchaseAndSale`, "netInvestmentPurchaseAndSale");
  assign(`${prefix}NetOtherInvestingChanges`, "netOtherInvestingChanges");
  assign(`${prefix}FinancingCashFlow`, "financingCashFlow");
  assign(`${prefix}CashFlowFromContinuingFinancingActivities`, "cashFlowFromContinuingFinancingActivities");
  assign(`${prefix}IssuanceOfDebt`, "issuanceOfDebt");
  assign(`${prefix}RepaymentOfDebt`, "repaymentOfDebt");
  assign(`${prefix}NetIssuancePaymentsOfDebt`, "netIssuancePaymentsOfDebt");
  assign(`${prefix}LongTermDebtIssuance`, "longTermDebtIssuance");
  assign(`${prefix}LongTermDebtPayments`, "longTermDebtPayments");
  assign(`${prefix}NetLongTermDebtIssuance`, "netLongTermDebtIssuance");
  assign(`${prefix}ShortTermDebtIssuance`, "shortTermDebtIssuance");
  assign(`${prefix}ShortTermDebtPayments`, "shortTermDebtPayments");
  assign(`${prefix}NetShortTermDebtIssuance`, "netShortTermDebtIssuance");
  assign(`${prefix}RepurchaseOfCapitalStock`, "repurchaseOfCapitalStock");
  assign(`${prefix}CommonStockIssuance`, "commonStockIssuance");
  assign(`${prefix}CommonStockPayments`, "commonStockPayments");
  assign(`${prefix}NetCommonStockIssuance`, "netCommonStockIssuance");
  assign(`${prefix}CashDividendsPaid`, "cashDividendsPaid");
  assign(`${prefix}CommonStockDividendPaid`, "commonStockDividendPaid");
  assign(`${prefix}NetOtherFinancingCharges`, "netOtherFinancingCharges");
  assign(`${prefix}BeginningCashPosition`, "beginningCashPosition");
  assign(`${prefix}EndCashPosition`, "endCashPosition");
  assign(`${prefix}ChangesInCash`, "changesInCash");
  assign(`${prefix}EffectOfExchangeRateChanges`, "effectOfExchangeRateChanges");
  assign(`${prefix}TotalAssets`, "totalAssets");
  assign(`${prefix}CurrentAssets`, "currentAssets");
  assign(`${prefix}CashAndCashEquivalents`, "cashAndCashEquivalents");
  assign(`${prefix}CashCashEquivalentsAndShortTermInvestments`, "cashCashEquivalentsAndShortTermInvestments");
  assign(`${prefix}OtherShortTermInvestments`, "otherShortTermInvestments");
  assign(`${prefix}Receivables`, "receivables");
  assign(`${prefix}AccountsReceivable`, "accountsReceivable");
  assign(`${prefix}Inventory`, "inventory");
  assign(`${prefix}PrepaidAssets`, "prepaidAssets");
  assign(`${prefix}OtherCurrentAssets`, "otherCurrentAssets");
  assign(`${prefix}TotalNonCurrentAssets`, "totalNonCurrentAssets");
  assign(`${prefix}NetPPE`, "netPPE");
  assign(`${prefix}GrossPPE`, "grossPPE");
  assign(`${prefix}AccumulatedDepreciation`, "accumulatedDepreciation");
  assign(`${prefix}Goodwill`, "goodwill");
  assign(`${prefix}OtherIntangibleAssets`, "otherIntangibleAssets");
  assign(`${prefix}GoodwillAndOtherIntangibleAssets`, "goodwillAndOtherIntangibleAssets");
  assign(`${prefix}InvestmentsAndAdvances`, "investmentsAndAdvances");
  assign(`${prefix}OtherNonCurrentAssets`, "otherNonCurrentAssets");
  assign(`${prefix}TotalLiabilitiesNetMinorityInterest`, "totalLiabilities");
  assign(`${prefix}CurrentLiabilities`, "currentLiabilities");
  assign(`${prefix}CurrentDebt`, "currentDebt");
  assign(`${prefix}CurrentDebtAndCapitalLeaseObligation`, "currentDebtAndCapitalLeaseObligation");
  assign(`${prefix}PayablesAndAccruedExpenses`, "payablesAndAccruedExpenses");
  assign(`${prefix}CurrentAccruedExpenses`, "currentAccruedExpenses");
  assign(`${prefix}Payables`, "payables");
  assign(`${prefix}AccountsPayable`, "accountsPayable");
  assign(`${prefix}CurrentDeferredRevenue`, "currentDeferredRevenue");
  assign(`${prefix}CurrentDeferredLiabilities`, "currentDeferredLiabilities");
  assign(`${prefix}OtherCurrentLiabilities`, "otherCurrentLiabilities");
  assign(`${prefix}TotalNonCurrentLiabilitiesNetMinorityInterest`, "totalNonCurrentLiabilities");
  assign(`${prefix}LongTermDebt`, "longTermDebt");
  assign(`${prefix}LongTermDebtAndCapitalLeaseObligation`, "longTermDebtAndCapitalLeaseObligation");
  assign(`${prefix}LongTermCapitalLeaseObligation`, "longTermCapitalLeaseObligation");
  assign(`${prefix}NonCurrentDeferredLiabilities`, "nonCurrentDeferredLiabilities");
  assign(`${prefix}NonCurrentDeferredTaxesLiabilities`, "nonCurrentDeferredTaxesLiabilities");
  assign(`${prefix}OtherNonCurrentLiabilities`, "otherNonCurrentLiabilities");
  assign(`${prefix}TotalDebt`, "totalDebt");
  assign(`${prefix}CapitalLeaseObligations`, "capitalLeaseObligations");
  assign(`${prefix}TotalCapitalization`, "totalCapitalization");
  assign(`${prefix}StockholdersEquity`, "totalEquity");
  assign(`${prefix}TotalEquityGrossMinorityInterest`, "totalEquityGrossMinorityInterest");
  assign(`${prefix}CommonStockEquity`, "commonStockEquity");
  assign(`${prefix}CommonStock`, "commonStock");
  assign(`${prefix}CapitalStock`, "capitalStock");
  assign(`${prefix}AdditionalPaidInCapital`, "additionalPaidInCapital");
  assign(`${prefix}TreasuryStock`, "treasuryStock");
  assign(`${prefix}GainsLossesNotAffectingRetainedEarnings`, "gainsLossesNotAffectingRetainedEarnings");
  assign(`${prefix}OtherEquityAdjustments`, "otherEquityAdjustments");
  assign(`${prefix}RetainedEarnings`, "retainedEarnings");
  assign(`${prefix}LongTermEquityInvestment`, "longTermEquityInvestment");
  assign(`${prefix}WorkingCapital`, "workingCapital");
  assign(`${prefix}NetTangibleAssets`, "netTangibleAssets");
  assign(`${prefix}InvestedCapital`, "investedCapital");
  assign(`${prefix}TangibleBookValue`, "tangibleBookValue");
  assign(`${prefix}ShareIssued`, "shareIssued");
  assign(`${prefix}OrdinarySharesNumber`, "ordinarySharesNumber");
  assign(`${prefix}TreasurySharesNumber`, "treasurySharesNumber");

  return Array.from(byDate.values()).sort((left, right) => left.date.localeCompare(right.date));
}
