import type { ReactNode } from "react";
import { Section } from "../../../../components";
import { formatMarketPriceWithCurrency } from "../../../../market-data/market/format";
import { useInlineTickerQuote } from "../../../../state/hooks/inline-tickers";
import { useTickerQuoteStream } from "../../../../state/hooks/live-ticker-financials";
import { colors } from "../../../../theme/colors";
import type { Quote } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { Box, Text } from "../../../../ui";
import { formatCompact } from "../../../../utils/format";
import { activityLabel, criticalityColor, dateShort, metricColor, metricNumber, textOrNull, tickerSymbol, truncate } from "../format";
import type { BuildoutCompany } from "../model/types";
import { DetailListLine, DetailSpecGrid, MarkdownBlock, RelatedCompaniesLine, tickerBadges, type DetailSpec, type InlineTickerCatalog } from "./ui";
import { dateCell, detailListValues, recommendationColor, valueWithOriginal } from "./values";

interface LiveCompanyValues {
  price: string | null;
  marketCap: string | null;
}

/**
 * Price and market cap from the live quote. The dataset prints them in USD
 * (with the local price in brackets for foreign listings), so the quote only
 * replaces them for a USD listing; the cap moves with the price, from the
 * dataset's own cap and price. Anything else keeps the dataset's strings.
 */
export function liveCompanyValues(company: BuildoutCompany, quote: Quote | null): LiveCompanyValues | null {
  if (!quote || quote.stale || !(quote.price > 0) || quote.currency !== "USD") return null;
  if ((company.currency?.trim().toUpperCase() || "USD") !== "USD") return null;
  const datasetPrice = metricNumber(company.stockPrice);
  const datasetCap = metricNumber(company.marketCap);
  const liveCap = datasetPrice != null && datasetPrice > 0 && datasetCap != null && datasetCap > 0
    ? datasetCap * (quote.price / datasetPrice)
    : null;
  return {
    price: formatMarketPriceWithCurrency(quote.price, quote.currency, { minimumFractionDigits: 2 }),
    marketCap: liveCap != null ? `$${formatCompact(liveCap)}` : null,
  };
}

function useLiveCompanyValues(company: BuildoutCompany, ticker: TickerRecord | null, stream: boolean): LiveCompanyValues | null {
  const symbol = ticker ? tickerSymbol(company.ticker) : null;
  // The detail's own price: on screen, so it takes the fast lane.
  useTickerQuoteStream(symbol, ticker, { enabled: stream, surface: "detail", weight: 50 });
  return liveCompanyValues(company, useInlineTickerQuote(symbol, ticker));
}

/** The spec grid with the live price; only this grid re-renders on a tick. */
function CompanyOverviewGrid({ company, ticker, width, items }: {
  company: BuildoutCompany;
  ticker: TickerRecord | null;
  width: number;
  items: (price: string | null) => DetailSpec[];
}) {
  const live = useLiveCompanyValues(company, ticker, true);
  return <DetailSpecGrid width={width} items={items(live?.price ?? valueWithOriginal(company.stockPrice, company.stockPriceOriginal))} />;
}

function CompanyValuationGrid({ company, ticker, width, items }: {
  company: BuildoutCompany;
  ticker: TickerRecord | null;
  width: number;
  items: (marketCap: string | null) => DetailSpec[];
}) {
  const live = useLiveCompanyValues(company, ticker, false);
  return (
    <DetailSpecGrid
      width={width}
      marginTop={0}
      items={items(live?.marketCap ?? valueWithOriginal(company.marketCap, company.marketCapOriginal))}
    />
  );
}

export function CompanyDetail({
  company,
  bodyWidth,
  catalog,
  openTicker,
  favoriteToggle,
}: {
  company: BuildoutCompany;
  bodyWidth: number;
  catalog: InlineTickerCatalog;
  openTicker: (symbol: string) => void;
  favoriteToggle: ReactNode;
}) {
  const categoryAnchor = [company.primarySector, company.primarySubsector, company.primaryTechnology];
  const sectors = detailListValues(company.sectors ?? [], [company.primarySector]);
  const subSectors = detailListValues(company.subSectors ?? [], [company.primarySubsector]);
  const technologies = detailListValues(company.technologies ?? [], [company.primaryTechnology]);
  const valueChainStages = detailListValues(company.valueChainStages ?? [], categoryAnchor);
  const hasCategories = sectors.length > 0 || subSectors.length > 0 || technologies.length > 0 || valueChainStages.length > 0;
  const supplyChain = company.supplyChain;
  const companySymbol = tickerSymbol(company.ticker);
  const companyTicker = companySymbol ? catalog[companySymbol]?.ticker ?? null : null;
  const hasSupplyChain = (supplyChain?.suppliers.length ?? 0) > 0
    || (supplyChain?.customers.length ?? 0) > 0
    || (supplyChain?.competitors.length ?? 0) > 0
    || textOrNull(company.aiCriticalityJustification) != null;

  return (
    <>
      {favoriteToggle || company.ticker ? (
        <Box flexDirection="row" height={1} gap={1}>
          {favoriteToggle}
          {company.ticker ? tickerBadges({
            symbols: [company.ticker],
            width: Math.min(bodyWidth - (favoriteToggle ? 3 : 0), 16),
          }) : null}
        </Box>
      ) : null}
      <CompanyOverviewGrid
        company={company}
        ticker={companyTicker}
        width={bodyWidth}
        items={(price) => [
          { label: "Exchange", value: company.exchange },
          { label: "Price", value: price, color: metricColor(company.return1y) },
          { label: "1Y", value: company.return1y, color: metricColor(company.return1y) },
          { label: "3Y", value: company.return3y, color: metricColor(company.return3y) },
          { label: "Sector", value: [company.primarySector, company.primarySubsector, company.primaryTechnology].filter(Boolean).join(" / ") },
          { label: "Critical", value: company.aiCriticality, color: criticalityColor(company.aiCriticality, false) },
          { label: "Maturity", value: company.maturity },
          { label: "Export", value: company.exportControlExposure },
          { label: "Employees", value: company.employeeCount },
          { label: "HQ", value: company.hqAddress ?? [company.city, company.state, company.countryHq].filter(Boolean).join(", ") },
          { label: "Currency", value: company.currency && company.currency !== "USD" ? company.currency : null },
        ]}
      />
      <MarkdownBlock text={company.listReason} width={bodyWidth} catalog={catalog} openTicker={openTicker} />
      <MarkdownBlock text={company.longDescription ?? company.description} width={bodyWidth} catalog={catalog} openTicker={openTicker} />
      {hasCategories ? (
        <Section title="Categories" width={bodyWidth}>
          <DetailListLine label="Sectors" values={sectors} width={bodyWidth} />
          <DetailListLine label="Subsectors" values={subSectors} width={bodyWidth} />
          <DetailListLine label="Technologies" values={technologies} width={bodyWidth} />
          <DetailListLine label="Chain" values={valueChainStages} width={bodyWidth} />
        </Section>
      ) : null}
      {hasSupplyChain ? (
        <Section title="Supply Chain" width={bodyWidth}>
          <MarkdownBlock text={company.aiCriticalityJustification} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
          <RelatedCompaniesLine label="Suppliers" companies={supplyChain?.suppliers} width={bodyWidth} />
          <RelatedCompaniesLine label="Customers" companies={supplyChain?.customers} width={bodyWidth} />
          <RelatedCompaniesLine label="Competitors" companies={supplyChain?.competitors} width={bodyWidth} />
        </Section>
      ) : null}
      <Section title="Valuation & Trading" width={bodyWidth}>
        <CompanyValuationGrid
          company={company}
          ticker={companyTicker}
          width={bodyWidth}
          items={(marketCap) => [
            { label: "Mkt Cap", value: marketCap },
            { label: "EV", value: company.enterpriseValue },
            { label: "Fwd P/E", value: company.forwardPE },
            { label: "Trail P/E", value: company.trailingPE },
            { label: "P/E", value: company.peRatio },
            { label: "PEG", value: company.pegRatio },
            { label: "P/B", value: company.priceToBook },
            { label: "EPS", value: valueWithOriginal(company.dilutedEps, company.dilutedEpsOriginal) },
            { label: "Beta", value: company.beta },
            { label: "52W High", value: valueWithOriginal(company.high52w, company.high52wOriginal) },
            { label: "52W Low", value: valueWithOriginal(company.low52w, company.low52wOriginal) },
          ]}
        />
      </Section>
      <Section title="Operating Metrics" width={bodyWidth}>
        <DetailSpecGrid
          width={bodyWidth}
          marginTop={0}
          items={[
            { label: "Revenue", value: valueWithOriginal(company.revenue, company.revenueOriginal) },
            { label: "Net Inc", value: valueWithOriginal(company.netIncome, company.netIncomeOriginal), color: metricColor(company.netIncome) },
            { label: "Rev Grw", value: company.revenueGrowthYoy, color: metricColor(company.revenueGrowthYoy) },
            { label: "Last Q", value: company.lastQuarterGrowth, color: metricColor(company.lastQuarterGrowth) },
            { label: "Gross Mgn", value: company.grossProfitMargin, color: metricColor(company.grossProfitMargin) },
            { label: "Op Mgn", value: company.operatingMargin, color: metricColor(company.operatingMargin) },
            { label: "Profit Mgn", value: company.profitMargins ?? company.netProfitMargin, color: metricColor(company.profitMargins ?? company.netProfitMargin) },
            { label: "ROE", value: company.returnOnEquity, color: metricColor(company.returnOnEquity) },
            { label: "ROA", value: company.returnOnAssets, color: metricColor(company.returnOnAssets) },
          ]}
        />
      </Section>
      <Section title="Cash & Balance" width={bodyWidth}>
        <DetailSpecGrid
          width={bodyWidth}
          marginTop={0}
          items={[
            { label: "FCF", value: valueWithOriginal(company.freeCashFlow, company.freeCashFlowOriginal), color: metricColor(company.freeCashFlow) },
            { label: "OCF", value: company.operatingCashFlow, color: metricColor(company.operatingCashFlow) },
            { label: "Cash", value: valueWithOriginal(company.totalCash, company.totalCashOriginal) },
            { label: "Debt", value: valueWithOriginal(company.totalDebt, company.totalDebtOriginal) },
            { label: "D/E", value: company.debtToEquity },
            { label: "Current", value: company.currentRatio },
            { label: "Quick", value: company.quickRatio },
            { label: "Div Yld", value: company.dividendYield, color: metricColor(company.dividendYield) },
            { label: "Ex-Div", value: dateCell(company.exDividendDate) },
            { label: "Div Date", value: dateCell(company.dividendDate) },
            { label: "Earnings", value: dateCell(company.nextEarningsDate) },
          ]}
        />
      </Section>
      <Section title="Analyst & Ownership" width={bodyWidth}>
        <DetailSpecGrid
          width={bodyWidth}
          marginTop={0}
          items={[
            { label: "Target Low", value: valueWithOriginal(company.targetLowPrice, company.targetLowPriceOriginal) },
            { label: "Target Mean", value: valueWithOriginal(company.targetMeanPrice, company.targetMeanPriceOriginal) },
            { label: "Target High", value: valueWithOriginal(company.targetHighPrice, company.targetHighPriceOriginal) },
            { label: "Analysts", value: company.analystCount },
            { label: "Rec", value: company.recommendation, color: recommendationColor(company.recommendation) },
            { label: "Strong Buy", value: company.strongBuy },
            { label: "Buy", value: company.buy },
            { label: "Hold", value: company.hold },
            { label: "Sell", value: company.sell },
            { label: "Strong Sell", value: company.strongSell },
            { label: "Insiders", value: company.heldByInsiders },
            { label: "Institutions", value: company.heldByInstitutions },
            { label: "Short", value: company.sharesShort },
            { label: "Short Ratio", value: company.shortRatio },
            { label: "Shares", value: company.sharesOutstanding },
            { label: "Float", value: company.floatShares },
          ]}
        />
      </Section>
      {(company.sites?.length ?? 0) > 0 ? (
        <Section title="Sites" width={bodyWidth}>
          {company.sites!.slice(0, 12).map((site, index) => {
            const activity = site.constructionActivity != null ? `construction ${activityLabel(site.constructionActivity)}` : null;
            const parts = [
              site.name ?? "Site",
              site.type,
              site.relationship === "involved" ? site.role : site.relationship,
              site.powerCapacity,
              site.areaKm2,
              [site.location?.city, site.location?.country].filter(Boolean).join(", "),
              activity,
            ].filter(Boolean);
            return (
              <Box key={`${site.name}-${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
                <Text fg={colors.textMuted}>{truncate(parts.join(" - "), bodyWidth)}</Text>
                {site.involvementSummary ? (
                  <MarkdownBlock text={site.involvementSummary} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
                ) : null}
              </Box>
            );
          })}
        </Section>
      ) : null}
      {(company.intelligence?.length ?? 0) > 0 ? (
        <Section title="Recent Intel" width={bodyWidth}>
          {company.intelligence!.slice(0, 5).map((item, index) => (
            <Box key={`${item.headline ?? "intel"}:${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Text fg={colors.textDim}>{truncate(`${dateShort(item.publishedAt)} ${item.headline ?? ""}`, bodyWidth)}</Text>
              <MarkdownBlock text={item.content} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
            </Box>
          ))}
        </Section>
      ) : null}
      {company.researchReport ? (
        <Section title="Research" width={bodyWidth}>
          <MarkdownBlock text={company.researchReport} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
        </Section>
      ) : null}
    </>
  );
}
