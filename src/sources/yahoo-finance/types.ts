type TradingPeriod = { start?: number; end?: number; gmtoffset?: number; timezone?: string };

export type ChartResult = {
  meta?: {
    dataGranularity?: string;
    instrumentType?: string;
    symbol?: string;
    currency?: string; longName?: string; shortName?: string;
    regularMarketPrice?: number; chartPreviousClose?: number;
    fiftyTwoWeekHigh?: number; fiftyTwoWeekLow?: number;
    exchangeName?: string; fullExchangeName?: string;
    regularMarketTime?: number;
    currentTradingPeriod?: { pre?: TradingPeriod; regular?: TradingPeriod; post?: TradingPeriod };
    preMarketPrice?: number; postMarketPrice?: number;
  };
  timestamp?: number[];
  indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
  events?: {
    dividends?: Record<string, { amount?: number; date?: number }>;
    splits?: Record<string, {
      date?: number;
      numerator?: number;
      denominator?: number;
      splitRatio?: string;
    }>;
  };
};

export type ChartResponse = { chart?: { result?: ChartResult[]; error?: { description?: string } | null } };

export type TimeseriesResponse = { timeseries?: { result?: Array<Record<string, any>>; error?: { description?: string } | null } };

export type QuoteSummaryResponse = {
  quoteSummary?: {
    result?: Array<{
      price?: {
        symbol?: string;
        currency?: string;
        shortName?: string;
        longName?: string;
        exchangeName?: string;
      };
      quoteType?: {
        exchange?: string;
        shortName?: string;
        longName?: string;
      };
      financialData?: {
        currentPrice?: { raw?: number } | number | null;
        targetHighPrice?: { raw?: number } | number | null;
        targetLowPrice?: { raw?: number } | number | null;
        targetMeanPrice?: { raw?: number } | number | null;
        targetMedianPrice?: { raw?: number } | number | null;
        recommendationMean?: { raw?: number } | number | null;
        payoutRatio?: { raw?: number } | number | null;
      };
      recommendationTrend?: {
        trend?: Array<{
          period?: string;
          strongBuy?: number;
          buy?: number;
          hold?: number;
          sell?: number;
          strongSell?: number;
        }>;
      };
      upgradeDowngradeHistory?: {
        history?: Array<{
          epochGradeDate?: number;
          firm?: string;
          action?: string;
          priceTargetAction?: string;
          toGrade?: string;
          fromGrade?: string;
          currentPriceTarget?: { raw?: number } | number | null;
          priorPriceTarget?: { raw?: number } | number | null;
        }>;
      };
      earningsTrend?: {
        trend?: Array<{
          period?: string;
          endDate?: string;
          earningsEstimate?: {
            earningsCurrency?: string;
            avg?: { raw?: number } | number | null;
            low?: { raw?: number } | number | null;
            high?: { raw?: number } | number | null;
            yearAgoEps?: { raw?: number } | number | null;
            numberOfAnalysts?: { raw?: number } | number | null;
            growth?: { raw?: number } | number | null;
          };
          revenueEstimate?: {
            revenueCurrency?: string;
            avg?: { raw?: number } | number | null;
            low?: { raw?: number } | number | null;
            high?: { raw?: number } | number | null;
            yearAgoRevenue?: { raw?: number } | number | null;
            numberOfAnalysts?: { raw?: number } | number | null;
            growth?: { raw?: number } | number | null;
          };
          epsTrend?: {
            current?: { raw?: number } | number | null;
            "7daysAgo"?: { raw?: number } | number | null;
            "30daysAgo"?: { raw?: number } | number | null;
          };
          epsRevisions?: {
            upLast7days?: { raw?: number } | number | null;
            upLast30days?: { raw?: number } | number | null;
            downLast7Days?: { raw?: number } | number | null;
            downLast30days?: { raw?: number } | number | null;
          };
        }>;
      };
      calendarEvents?: {
        earnings?: {
          earningsDate?: Array<{ raw?: number; fmt?: string }>;
          earningsCallDate?: Array<{ raw?: number; fmt?: string }>;
          earningsAverage?: { raw?: number } | number | null;
          earningsLow?: { raw?: number } | number | null;
          earningsHigh?: { raw?: number } | number | null;
          revenueAverage?: { raw?: number } | number | null;
          revenueLow?: { raw?: number } | number | null;
          revenueHigh?: { raw?: number } | number | null;
          isEarningsDateEstimate?: boolean;
        };
      };
      earningsHistory?: {
        history?: Array<{
          currency?: string;
          epsActual?: { raw?: number } | number | null;
          epsEstimate?: { raw?: number } | number | null;
          epsDifference?: { raw?: number } | number | null;
          surprisePercent?: { raw?: number } | number | null;
          quarter?: { raw?: number; fmt?: string } | number | string | null;
        }>;
      };
      assetProfile?: {
        longBusinessSummary?: string;
        sector?: string;
        industry?: string;
      };
      summaryDetail?: {
        bid?: { raw?: number } | number | null;
        ask?: { raw?: number } | number | null;
        bidSize?: { raw?: number } | number | null;
        askSize?: { raw?: number } | number | null;
        previousClose?: { raw?: number } | number | null;
        open?: { raw?: number } | number | null;
        dayHigh?: { raw?: number } | number | null;
        dayLow?: { raw?: number } | number | null;
        trailingAnnualDividendRate?: { raw?: number } | number | null;
        trailingAnnualDividendYield?: { raw?: number } | number | null;
        forwardAnnualDividendRate?: { raw?: number } | number | null;
        dividendRate?: { raw?: number } | number | null;
        payoutRatio?: { raw?: number } | number | null;
        exDividendDate?: { raw?: number } | number | null;
        dividendDate?: { raw?: number } | number | null;
        currency?: string;
      };
      defaultKeyStatistics?: {
        payoutRatio?: { raw?: number } | number | null;
        sharesShort?: { raw?: number } | number | null;
        sharesShortPriorMonth?: { raw?: number } | number | null;
        sharesShortPreviousMonthDate?: { raw?: number; fmt?: string } | number | string | null;
        dateShortInterest?: { raw?: number; fmt?: string } | number | string | null;
        shortRatio?: { raw?: number } | number | null;
        shortPercentOfFloat?: { raw?: number } | number | null;
        floatShares?: { raw?: number } | number | null;
      };
      majorHoldersBreakdown?: {
        insidersPercentHeld?: { raw?: number } | number | null;
        institutionsPercentHeld?: { raw?: number } | number | null;
        institutionsFloatPercentHeld?: { raw?: number } | number | null;
        institutionsCount?: { raw?: number } | number | null;
      };
      institutionOwnership?: {
        ownershipList?: Array<{
          organization?: string;
          reportDate?: { raw?: number; fmt?: string } | number | string | null;
          position?: { raw?: number } | number | null;
          value?: { raw?: number } | number | null;
          pctHeld?: { raw?: number } | number | null;
          pctChange?: { raw?: number } | number | null;
        }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

export type YahooQuoteSummaryResult = NonNullable<NonNullable<QuoteSummaryResponse["quoteSummary"]>["result"]>[number];
export type YahooEarningsTrend = NonNullable<NonNullable<YahooQuoteSummaryResult["earningsTrend"]>["trend"]>[number];
