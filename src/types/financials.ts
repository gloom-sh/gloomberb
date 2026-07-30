
export type MarketState = "PRE" | "REGULAR" | "POST" | "PREPRE" | "POSTPOST" | "CLOSED";
export type SessionConfidence = "explicit" | "derived" | "unknown";
export type QuoteDataSource = "live" | "delayed" | "snapshot";
export type QuoteDelivery = "stream" | "poll";

export interface QuoteFieldProvenance {
  providerId: string;
  dataSource?: QuoteDataSource;
}

export interface QuoteProvenance {
  price?: QuoteFieldProvenance;
  session?: QuoteFieldProvenance;
  listing?: QuoteFieldProvenance;
  routing?: QuoteFieldProvenance;
  descriptive?: QuoteFieldProvenance;
  fields?: Record<string, QuoteFieldProvenance>;
  rejectedPriceProviders?: string[];
}

export interface Quote {
  symbol: string;
  providerId?: string;
  price: number;
  currency: string;
  change: number;
  changePercent: number;
  previousClose?: number;
  high52w?: number;
  low52w?: number;
  marketCap?: number;
  volume?: number;
  name?: string;
  lastUpdated: number; // timestamp ms
  receivedAt?: number; // local receipt timestamp ms for streamed/display freshness
  delivery?: QuoteDelivery;
  stale?: boolean;
  exchangeName?: string;
  fullExchangeName?: string;
  listingExchangeName?: string;
  listingExchangeFullName?: string;
  routingExchangeName?: string;
  routingExchangeFullName?: string;
  marketState?: MarketState;
  sessionConfidence?: SessionConfidence;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  open?: number;
  high?: number;
  low?: number;
  mark?: number;
  provenance?: QuoteProvenance;
  /** Freshness class for the quote data. Provider identity lives in providerId/provenance. */
  dataSource?: QuoteDataSource;
}

export interface QuoteContribution extends Quote {
  providerId: string;
}

export type QuoteContributionMap = Record<string, QuoteContribution>;

export interface Fundamentals {
  trailingPE?: number;
  forwardPE?: number;
  pegRatio?: number;
  enterpriseValue?: number;
  operatingCashFlow?: number;
  freeCashFlow?: number;
  dividendYield?: number;
  revenue?: number;
  netIncome?: number;
  eps?: number;
  operatingMargin?: number;
  profitMargin?: number;
  revenueGrowth?: number;
  return1Y?: number;
  return3Y?: number;
  lastQuarterGrowth?: number;
  sharesOutstanding?: number;
}

type HolderOwnerType = "institution" | "fund" | "direct" | "insider";

export interface HolderRecord {
  providerId?: string;
  ownerType: HolderOwnerType;
  name: string;
  reportDate?: string;
  shares?: number;
  value?: number;
  percentHeld?: number;
  changeShares?: number;
  changePercent?: number;
}

interface HolderSummary {
  insidersPercentHeld?: number;
  institutionsPercentHeld?: number;
  institutionsFloatPercentHeld?: number;
  institutionsCount?: number;
}

export interface HolderData {
  providerId?: string;
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  asOf?: string;
  summary?: HolderSummary;
  holders: HolderRecord[];
}

interface AnalystPriceTarget {
  high?: number;
  median?: number;
  low?: number;
  average?: number;
  current?: number;
  currency?: string;
}

interface AnalystRecommendationTrend {
  period: string;
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}

export interface AnalystRatingRecord {
  date: string;
  firm: string;
  action?: string;
  current?: string;
  prior?: string;
  currentPriceTarget?: number;
  priorPriceTarget?: number;
}

export interface AnalystEstimateRecord {
  date: string;
  period: string;
  analysts?: number;
  average?: number;
  low?: number;
  high?: number;
  yearAgo?: number;
  growth?: number;
}

export interface AnalystResearchData {
  providerId?: string;
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  micCode?: string;
  exchangeTimezone?: string;
  priceTarget?: AnalystPriceTarget;
  recommendationRating?: number;
  recommendations: AnalystRecommendationTrend[];
  ratings: AnalystRatingRecord[];
  earningsEstimates: AnalystEstimateRecord[];
  revenueEstimates: AnalystEstimateRecord[];
}

export interface DividendAction {
  exDate: string;
  amount: number;
}

export interface SplitAction {
  date: string;
  description?: string;
  ratio?: number;
  fromFactor?: number;
  toFactor?: number;
}

export interface EarningsAction {
  date: string;
  time?: string;
  epsEstimate?: number;
  epsActual?: number;
  difference?: number;
  surprisePercent?: number;
}

export interface CorporateActionsData {
  providerId?: string;
  symbol: string;
  name?: string;
  currency?: string;
  exchange?: string;
  micCode?: string;
  exchangeTimezone?: string;
  dividends: DividendAction[];
  splits: SplitAction[];
  earnings: EarningsAction[];
}

export interface CompanyProfile {
  description?: string;
  sector?: string;
  industry?: string;
}

export interface FinancialStatement {
  date: string;
  /** Earliest date on which the complete row was publicly available, when known. */
  availableAt?: string;
  /** Per-field publication dates used by point-in-time charts and calculations. */
  fieldAvailability?: Record<string, string>;
  // Income Statement
  totalRevenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  sellingGeneralAndAdministration?: number;
  researchAndDevelopment?: number;
  operatingExpense?: number;
  operatingIncome?: number;
  operatingRevenue?: number;
  totalExpenses?: number;
  pretaxIncome?: number;
  normalizedIncome?: number;
  netIncomeCommonStockholders?: number;
  netIncomeContinuousOperations?: number;
  otherIncomeExpense?: number;
  otherNonOperatingIncomeExpenses?: number;
  depreciationAmortizationDepletionIncomeStatement?: number;
  depreciationAndAmortizationInIncomeStatement?: number;
  interestExpense?: number;
  taxProvision?: number;
  netIncome?: number;
  ebitda?: number;
  basicEps?: number;
  eps?: number; // diluted
  basicShares?: number;
  dilutedShares?: number;
  // Cash Flow
  operatingCashFlow?: number;
  depreciationAndAmortization?: number;
  depreciationAmortizationDepletion?: number;
  depreciation?: number;
  deferredIncomeTax?: number;
  deferredTax?: number;
  stockBasedCompensation?: number;
  otherNonCashItems?: number;
  changeInWorkingCapital?: number;
  changeInReceivables?: number;
  changeInInventory?: number;
  changeInPayable?: number;
  changeInAccountPayable?: number;
  changeInOtherWorkingCapital?: number;
  capitalExpenditure?: number;
  cashFlowFromContinuingOperatingActivities?: number;
  interestPaidSupplementalData?: number;
  incomeTaxPaidSupplementalData?: number;
  purchaseOfPPE?: number;
  saleOfPPE?: number;
  netPPEPurchaseAndSale?: number;
  freeCashFlow?: number;
  investingCashFlow?: number;
  cashFlowFromContinuingInvestingActivities?: number;
  purchaseOfBusiness?: number;
  saleOfBusiness?: number;
  netBusinessPurchaseAndSale?: number;
  purchaseOfInvestment?: number;
  saleOfInvestment?: number;
  netInvestmentPurchaseAndSale?: number;
  netOtherInvestingChanges?: number;
  financingCashFlow?: number;
  cashFlowFromContinuingFinancingActivities?: number;
  issuanceOfDebt?: number;
  repaymentOfDebt?: number;
  netIssuancePaymentsOfDebt?: number;
  longTermDebtIssuance?: number;
  longTermDebtPayments?: number;
  netLongTermDebtIssuance?: number;
  shortTermDebtIssuance?: number;
  shortTermDebtPayments?: number;
  netShortTermDebtIssuance?: number;
  repurchaseOfCapitalStock?: number;
  commonStockIssuance?: number;
  commonStockPayments?: number;
  netCommonStockIssuance?: number;
  cashDividendsPaid?: number;
  commonStockDividendPaid?: number;
  netOtherFinancingCharges?: number;
  beginningCashPosition?: number;
  endCashPosition?: number;
  changesInCash?: number;
  effectOfExchangeRateChanges?: number;
  // Balance Sheet
  totalAssets?: number;
  currentAssets?: number;
  cashAndCashEquivalents?: number;
  cashCashEquivalentsAndShortTermInvestments?: number;
  otherShortTermInvestments?: number;
  receivables?: number;
  accountsReceivable?: number;
  inventory?: number;
  prepaidAssets?: number;
  otherCurrentAssets?: number;
  totalNonCurrentAssets?: number;
  netPPE?: number;
  grossPPE?: number;
  accumulatedDepreciation?: number;
  goodwill?: number;
  otherIntangibleAssets?: number;
  goodwillAndOtherIntangibleAssets?: number;
  investmentsAndAdvances?: number;
  otherNonCurrentAssets?: number;
  totalLiabilities?: number;
  currentLiabilities?: number;
  currentDebt?: number;
  currentDebtAndCapitalLeaseObligation?: number;
  payablesAndAccruedExpenses?: number;
  currentAccruedExpenses?: number;
  payables?: number;
  accountsPayable?: number;
  currentDeferredRevenue?: number;
  currentDeferredLiabilities?: number;
  otherCurrentLiabilities?: number;
  totalNonCurrentLiabilities?: number;
  longTermDebt?: number;
  longTermDebtAndCapitalLeaseObligation?: number;
  longTermCapitalLeaseObligation?: number;
  nonCurrentDeferredLiabilities?: number;
  nonCurrentDeferredTaxesLiabilities?: number;
  otherNonCurrentLiabilities?: number;
  totalDebt?: number;
  capitalLeaseObligations?: number;
  totalCapitalization?: number;
  totalEquity?: number;
  totalEquityGrossMinorityInterest?: number;
  commonStockEquity?: number;
  commonStock?: number;
  capitalStock?: number;
  additionalPaidInCapital?: number;
  treasuryStock?: number;
  gainsLossesNotAffectingRetainedEarnings?: number;
  otherEquityAdjustments?: number;
  retainedEarnings?: number;
  longTermEquityInvestment?: number;
  workingCapital?: number;
  netTangibleAssets?: number;
  investedCapital?: number;
  tangibleBookValue?: number;
  shareIssued?: number;
  ordinarySharesNumber?: number;
  treasurySharesNumber?: number;
}

export interface PricePoint {
  date: Date;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

export interface TickerFinancials {
  quote?: Quote;
  quoteContributions?: QuoteContributionMap;
  fundamentals?: Fundamentals;
  profile?: CompanyProfile;
  annualStatements: FinancialStatement[];
  quarterlyStatements: FinancialStatement[];
  priceHistory: PricePoint[];
}

export interface OptionContract {
  contractSymbol: string;
  strike: number;
  currency: string;
  lastPrice: number;
  change: number;
  percentChange: number;
  volume: number;
  openInterest: number;
  bid: number;
  ask: number;
  impliedVolatility: number;
  inTheMoney: boolean;
  expiration: number;
  lastTradeDate: number;
  /** Millisecond timestamp for the latest streamed quote applied to this snapshot. */
  lastUpdated?: number;
}

export interface OptionsChain {
  underlyingSymbol: string;
  expirationDates: number[];
  calls: OptionContract[];
  puts: OptionContract[];
  providerId?: string;
  dataSource?: "live" | "delayed";
  feed?: "opra" | "yahoo";
  delayMinutes?: number;
  realtimeEligible?: boolean;
  /** ISO timestamp for the upstream options snapshot. */
  asOf?: string;
}
