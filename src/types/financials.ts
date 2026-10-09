import type { PriceBasis } from "./instrument";

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

/** Static listing facts from a quote observation, without an investable price. */
export interface QuoteMetadataSource {
  providerId?: string;
  lastUpdated?: number;
  stale?: boolean;
  provenance?: QuoteProvenance;
}

export interface QuoteMetadata {
  symbol: string;
  currency?: string;
  instrumentType?: string;
  listingExchangeName?: string;
  source: QuoteMetadataSource;
  /** Overrides only when a missing field was supplied by another observation. */
  fieldSources?: Partial<Record<"currency" | "instrumentType", QuoteMetadataSource>>;
}

/**
 * What a record's share counts count: depositary receipts or the ordinary
 * shares behind them. Gloom Cloud states it only when it established it.
 */
export type ShareBasis = "depositary_receipt" | "ordinary";

/** How a depositary receipt relates to the ordinary shares, as Gloom Cloud states it. */
interface DepositaryReceiptFacts {
  /** Whether the listing is a depositary receipt; absent when unknown. */
  isDepositaryReceipt?: boolean;
  /** Ordinary shares per receipt, on a receipt's own records. */
  adrRatio?: number;
}

export interface Quote extends DepositaryReceiptFacts {
  /** Applies to this price observation; a stored position cannot supply it. */
  priceBasis?: PriceBasis;
  /** Daily fund net asset value; independent of the units used to format its price. */
  priceObservation?: "nav";
  symbol: string;
  /** Provider-reported security type, independent of the company profile. */
  instrumentType?: string;
  providerId?: string;
  price: number;
  currency: string;
  /** Source units per `currency` unit when the venue quotes a sub-unit, such as 100 for a London line in pence. */
  providerPriceDivisor?: number;
  change: number;
  changePercent: number;
  previousClose?: number;
  /** Official close of a completed regular session, in this quote's currency. */
  regularClose?: number;
  /** Exchange-local date of regularClose; separate from the daily previous-close reference. */
  regularCloseSessionDate?: string;
  /** Move of that completed regular session from the one before it, in this quote's currency; set and cleared together with regularClose. */
  regularChange?: number;
  regularChangePercent?: number;
  /** Provider's exchange-local session date for the daily quote reference. */
  changeSessionDate?: string;
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
  /** Executed trade, separate from a midpoint or indicative mark. */
  lastTradePrice?: number;
  /** Timestamp of that trade in milliseconds. */
  lastTradeTime?: number;
  provenance?: QuoteProvenance;
  /** Freshness class for the quote data. Provider identity lives in providerId/provenance. */
  dataSource?: QuoteDataSource;
}

export interface QuoteContribution extends Quote {
  providerId: string;
}

export type QuoteContributionMap = Record<string, QuoteContribution>;

export interface Fundamentals extends DepositaryReceiptFacts {
  /** Every share count here is on this basis, the basis of the listing's price and market cap; absent when unproven. */
  shareBasis?: ShareBasis;
  /** On a receipt, the ordinary shares behind `sharesOutstanding`. */
  underlyingOrdinaryShares?: number;
  source?: "gloom";
  fetchedAt?: string;
  stale?: boolean;
  /** Currency of reported revenue, income, and cash flows; may differ from the listing. */
  financialCurrency?: string;
  /** Provider-reported issuer market cap; marketCapCurrency identifies its units when known. */
  marketCap?: number;
  marketCapCurrency?: string;
  trailingPE?: number;
  forwardPE?: number;
  /**
   * Forward EPS behind `forwardPE`, per share in the listing's major currency
   * unit. Served only when its basis matches the multiple, so the multiple can
   * be repriced from a live quote; absent otherwise.
   */
  forwardEps?: number;
  pegRatio?: number;
  enterpriseValue?: number;
  enterpriseToRevenue?: number;
  /** Explicit provider retractions; omitted fields alone remain eligible for fallback. */
  unavailableFields?: Array<"enterpriseValue" | "enterpriseToRevenue">;
  operatingCashFlow?: number;
  freeCashFlow?: number;
  dividendYield?: number;
  dividendYieldBasis?: "forward" | "trailing";
  dividendYieldSource?: "gloom";
  /**
   * Annual dividend per share behind `dividendYield`, in the listing's major
   * currency unit. Served only when its basis matches the yield, so the yield
   * can be repriced from a live quote; absent otherwise.
   */
  dividendRate?: number;
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
  /** Free float: shares outstanding less insider and strategic holdings. */
  floatShares?: number;
  beta?: number;
  /** Shares sold short at the source's latest settlement. */
  sharesShort?: number;
  /** Shares short over float from the same observation, as a fraction (0.0127 for 1.27%). */
  shortPercentOfFloat?: number;
  /** Days to cover: shares short over average daily volume. */
  shortRatio?: number;
  /** Fractions of shares outstanding. */
  insiderPercentHeld?: number;
  institutionPercentHeld?: number;
  /** The latest ex-dividend date (YYYY-MM-DD) while the dividend is being paid. */
  exDividendDate?: string;
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
  /** Set when the position's filing ties it to the receipts or to the ordinary shares. */
  shareBasis?: ShareBasis;
}

interface HolderSummary {
  insidersPercentHeld?: number;
  institutionsPercentHeld?: number;
  institutionsFloatPercentHeld?: number;
  institutionsCount?: number;
}

export interface HolderData extends DepositaryReceiptFacts {
  providerId?: string;
  symbol: string;
  name?: string;
  /** The listing's price currency. */
  currency?: string;
  /** The currency of `value`, which can differ from the listing's (USD on a London line priced from 13F filings). */
  valueCurrency?: string;
  /** Reported shares times the latest price, or times the price at the report date. */
  valueBasis?: "latest_price" | "period_end_price";
  /** Set when every row is on one basis. */
  shareBasis?: ShareBasis;
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
  /** Explicit currency for these estimates; independent of the listing currency. */
  currency?: string;
  analysts?: number;
  average?: number;
  low?: number;
  high?: number;
  yearAgo?: number;
  growth?: number;
}

export interface AnalystResearchData {
  providerId?: string;
  fetchedAt?: string;
  stale?: boolean;
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
  /** Provider adjustment ratio; may represent a split or a spinoff price adjustment, not verified share terms. */
  ratio?: number;
  /** Denominator of the provider adjustment factor. */
  fromFactor?: number;
  /** Numerator of the provider adjustment factor. */
  toFactor?: number;
}

export interface EarningsAction {
  date: string;
  dateType?: "announcement" | "fiscal-period-end";
  currency?: string;
  time?: string;
  epsEstimate?: number;
  epsActual?: number;
  difference?: number;
  surprisePercent?: number;
}

export interface CorporateActionsData {
  providerId?: string;
  fetchedAt?: string;
  stale?: boolean;
  coverage?: Partial<Record<"dividends" | "splits" | "earnings", "available" | "unavailable">>;
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
  employees?: number;
  website?: string;
  /** SEC Standard Industrial Classification, four digits (US filers). */
  sic?: string;
  sicDescription?: string;
  /** Fiscal year end as MM-DD (US filers). */
  fiscalYearEnd?: string;
}

/** A company's next report from the earnings calendar. */
export interface NextEarnings {
  date: string;
  /** Before the open, during market hours, after the close. */
  timing: "bmo" | "dmh" | "amc" | null;
  /** "history" when the timing is predicted from the last two reports. */
  timingSource: "filing" | "calendar" | "history" | null;
}

export type IncomeStatementField = "netIncome" | "netIncomeIncludingNoncontrollingInterests" | "netIncomeCommonStockholders";

export interface IncomeStatementSource {
  source: "sec";
  concept: string;
  accessionNumber?: string;
  filed?: string;
  startDate?: string;
  endDate: string;
  unit: string;
  basis: "parent" | "consolidated" | "common";
}

/**
 * Statement lines a source can declare unavailable for one period. A declared
 * gap survives merges and caches, and charts never recompute it, for example
 * as the full year minus the other quarters.
 */
export type StatementGapField = IncomeStatementField | "totalRevenue" | "operatingRevenue" | "pretaxIncome" | "taxProvision";

/** Per-share earnings lines that can be declared unavailable. */
export type EarningsField = "basicEps" | "eps";

/** @deprecated Operating results no longer carry filing or provider provenance. */
export type ReportedOperatingField = "grossProfit" | "operatingExpense" | "operatingIncome";
/** @deprecated Operating results no longer carry filing or provider provenance. */
export type ProviderOperatingField = ReportedOperatingField | "totalExpenses" | "ebitda";

/** @deprecated No longer populated. Operating income follows the provider's as-reported figure. */
export interface ReportedOperatingCohort {
  cik: string;
  period: "annual" | "quarterly";
  startDate: string;
  endDate: string;
  currency: "USD";
  accessionNumber: string;
  filed: string;
  form: string;
  values: Record<ReportedOperatingField, number>;
  anchors?: { totalRevenue?: number; costOfRevenue?: number };
  origin: { kind: "companyfacts" } | {
    kind: "filing-table";
    documentUrl: string;
    documentSha256: string;
    table: "summary-quarterly-results";
    unitScale: 1000000;
  };
}

/** @deprecated No longer populated. */
export interface ProviderOperatingObservation {
  provider: "gloom";
  sourceField: string;
  period: "annual" | "quarterly";
  endDate: string;
  currency: string;
  value: number;
}

/** @deprecated No longer populated. */
export interface OperatingResult {
  version: 1;
  reported?: ReportedOperatingCohort;
  provider?: Partial<Record<ProviderOperatingField, ProviderOperatingObservation>>;
  derived?: { ebitda?: DerivedOperatingObservation };
}

/** @deprecated No longer populated. */
export interface DerivedOperatingObservation {
  definition: "operating-income-plus-depreciation-amortization";
  period: "annual" | "quarterly";
  endDate: string;
  currency: string;
  value: number;
  inputs: { operatingIncome: number; depreciationAndAmortization: number };
}

/** @deprecated No longer populated. */
export interface OperatingResultAggregation {
  kind: "trailing-four-quarters";
  sourcePeriods: Array<Pick<FinancialStatement, "date" | "currency" | "operatingResult" | "depreciationAndAmortization" | ProviderOperatingField>>;
  unavailableFields: ProviderOperatingField[];
}

/** @deprecated No longer populated. EPS that disagrees with its row's income and shares is listed in `unavailableEarnings` instead. */
export interface ReportedEarningsCohort {
  cik: string;
  basis: "us-gaap";
  shareBasis: "ordinary";
  period: "annual";
  startDate: string;
  endDate: string;
  currency: "EUR";
  accessionNumber: string;
  filed: string;
  form: "20-F" | "20-F/A";
  values: Record<EarningsField, number>;
  anchors: Record<"netIncome" | "totalRevenue" | "operatingIncome" | "basicShares" | "dilutedShares", number> & { grossProfit?: number };
  concepts: Record<EarningsField | "netIncome" | "totalRevenue" | "operatingIncome" | "basicShares" | "dilutedShares", { concept: string; unit: string }>
    & { grossProfit?: { concept: string; unit: string } };
}

/** @deprecated No longer populated. */
export interface EarningsResultProvenance { version: 1; reported: ReportedEarningsCohort }

export interface FinancialStatement {
  /** The basis of this row's share counts and per-share earnings; absent when unproven. */
  shareBasis?: ShareBasis;
  /** @deprecated No longer populated. */
  earningsResult?: EarningsResultProvenance;
  /** EPS lines unavailable for this period, for example because they disagree with the row's own income and shares. */
  unavailableEarnings?: EarningsField[];
  /** @deprecated No longer populated. */
  operatingResult?: OperatingResult;
  /** @deprecated No longer populated. */
  operatingResultAggregation?: OperatingResultAggregation;
  /**
   * @deprecated No longer populated. Gloom Cloud withdrawal ids are read into
   * `unavailableFields` and `unavailableEarnings` when a response arrives.
   */
  withdrawnObservations?: string[];
  /** SEC EPS share basis; raw source values remain available in the evidence. */
  epsBasis?: import("../utils/sec-eps-basis").SecEpsBasis;
  date: string;
  /** Source of the fiscal period date; does not establish metric publication dates. */
  dateSource?: "sec" | "provider";
  /** Original vendor period date when independent filing evidence changes it. */
  providerDate?: string;
  /** Filing evidence for the period identity only, not availability of every field. */
  dateEvidence?: {
    accessionNumber: string;
    filed: string;
    startDate: string;
  };
  /** Reporting currency for monetary statement fields (per-share values use reported shares). */
  currency?: string;
  /** Earliest date on which the complete row was publicly available, when known. */
  availableAt?: string;
  /** Per-field publication dates used by point-in-time charts and calculations. */
  fieldAvailability?: Record<string, string>;
  /** Income attribution belongs to each field, not to the row's date evidence. */
  fieldSources?: Partial<Record<IncomeStatementField, IncomeStatementSource>>;
  /** Lines unavailable for this period; another source or income basis must not fill them. */
  unavailableFields?: StatementGapField[];
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
  netIncomeIncludingNoncontrollingInterests?: number;
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

/**
 * Provider identity once attached to individual observations.
 * @deprecated No longer populated. A source's coverage boundary is the
 * `coverageStart` of the result `getPriceHistoryWithMetadata` and its
 * siblings return.
 */
export interface PriceHistorySource {
  provider: string;
  symbol: string;
  exchange: string;
  currency: string;
  /** Source coverage restriction, not security inception or an adjustment ratio. */
  verifiedLineageStart?: string;
}

export interface PricePoint {
  /** @deprecated No longer populated; read the history result's `coverageStart` instead. */
  historySource?: PriceHistorySource;
  date: Date;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  volume?: number;
}

export interface StatementHistoryAttempt {
  mode: "extended";
  source: "sec";
  status: "available" | "unsupported" | "retryable-failure";
  fetchedAt: string;
  attemptedAt?: string;
  cik?: string;
  reason?: string;
}

/** Consensus EPS for one reported quarter as it stood at the report. */
export interface ReportedEpsEstimate {
  /** Announcement date. A row without an actual is an upcoming report. */
  date: string;
  epsEstimate?: number;
  epsActual?: number;
}

export type ConsensusPeriod = "current quarter" | "next quarter" | "current year" | "next year";

/** Today's consensus for a period still open. */
export interface ConsensusEpsEstimate {
  period: ConsensusPeriod | string;
  /** Fiscal period end. */
  date: string;
  average?: number;
  analysts?: number;
  currency?: string;
}

/** One day's observation of the consensus for a period, recorded by the cloud. */
export interface ConsensusEpsSnapshot {
  observedOn: string;
  period: ConsensusPeriod | string;
  periodEnd?: string;
  epsAverage?: number;
  analysts?: number;
  source: string;
}

/**
 * The inputs behind a forward multiple history. Providers only serve today's
 * consensus, so the past is the pre-report consensus per quarter plus whatever
 * the cloud has recorded day by day since it started observing the listing.
 */
export interface EpsEstimateHistory {
  fetchedAt?: string;
  currency?: string;
  reported: ReportedEpsEstimate[];
  consensus: ConsensusEpsEstimate[];
  snapshots: ConsensusEpsSnapshot[];
}

export interface TickerFinancials {
  statementHistory?: StatementHistoryAttempt;
  /** @deprecated No longer populated. */
  operatingHistoryRetryAt?: number;
  /** @deprecated No longer populated. */
  earningsHistoryRetryAt?: number;
  financialCurrency?: string;
  quote?: Quote;
  quoteMetadata?: QuoteMetadata;
  quoteContributions?: QuoteContributionMap;
  fundamentals?: Fundamentals;
  profile?: CompanyProfile;
  nextEarnings?: NextEarnings;
  annualStatements: FinancialStatement[];
  quarterlyStatements: FinancialStatement[];
  priceHistory: PricePoint[];
  /** Acquired history cadence. Null explicitly marks an opaque provider default; absent on legacy snapshots. */
  priceHistoryResolution?: import("../time-series/resolution").ManualChartResolution | null;
  /** Stable original acquisition identity, used to replay distinct opaque history windows. */
  priceHistoryRequestKey?: string;
  priceHistorySession?: import("./price-history").HistorySession;
  priceHistorySourceKey?: string;
  /** Present on extended statement history from the cloud. */
  epsEstimates?: EpsEstimateHistory;
}

export interface OptionContract {
  contractSymbol: string;
  strike: number;
  currency: string;
  lastPrice: number;
  change: number;
  percentChange: number;
  /** Missing activity is unknown; an explicitly reported zero remains zero. */
  volume?: number;
  openInterest?: number;
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
  feed?: "opra" | "gloom";
  delayMinutes?: number;
  realtimeEligible?: boolean;
  /** ISO timestamp for the upstream options snapshot. */
  asOf?: string;
}
