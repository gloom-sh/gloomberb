import { metricNumber, moneyAmount, textOrNull, tickerSymbol, uniqueStrings } from "../format";
import type {
  BuildoutCompany,
  BuildoutList,
  BuildoutObservation,
  BuildoutRelatedCompany,
  BuildoutReportSection,
  BuildoutSite,
  BuildoutSource,
  BuildoutUpdate,
  RawObject,
} from "./types";

function stringField(raw: RawObject, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = textOrNull(raw[key]);
    if (value != null) return value;
  }
  return null;
}

function stringArrayField(raw: RawObject, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) {
      return uniqueStrings(value.map(textOrNull).filter((item): item is string => item != null));
    }
    const textValue = textOrNull(value);
    if (textValue) return [textValue];
  }
  return [];
}

function numberField(raw: RawObject, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = metricNumber(value);
      if (parsed != null) return parsed;
    }
  }
  return null;
}

function booleanField(raw: RawObject, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (/^(true|yes)$/i.test(value.trim())) return true;
      if (/^(false|no)$/i.test(value.trim())) return false;
    }
  }
  return null;
}

function objectField(raw: RawObject, ...keys: string[]): RawObject | null {
  for (const key of keys) {
    const value = raw[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as RawObject;
    }
  }
  return null;
}

function arrayField(raw: RawObject, ...keys: string[]): RawObject[] {
  for (const key of keys) {
    const value = raw[key];
    if (Array.isArray(value)) return value.filter((item): item is RawObject => (
      item != null && typeof item === "object" && !Array.isArray(item)
    ));
  }
  return [];
}

function compactInteger(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function normalizeSource(raw: RawObject): BuildoutSource {
  return {
    field: stringField(raw, "field"),
    title: stringField(raw, "title", "name"),
    url: stringField(raw, "url"),
    domain: stringField(raw, "domain"),
    snippet: stringField(raw, "snippet", "excerpt"),
    reasoning: stringField(raw, "reasoning"),
    confidence: stringField(raw, "confidence"),
    tier: stringField(raw, "tier"),
    citations: arrayField(raw, "citations").map((citation) => ({
      title: stringField(citation, "title", "name"),
      url: stringField(citation, "url"),
      excerpts: stringArrayField(citation, "excerpts"),
    })),
  };
}

function normalizeRelatedCompany(raw: RawObject): BuildoutRelatedCompany {
  return {
    id: stringField(raw, "id", "companyId", "company_id"),
    name: stringField(raw, "name", "companyName", "company_name"),
    ticker: tickerSymbol(stringField(raw, "ticker", "companyTicker", "company_ticker")),
    logoUrl: stringField(raw, "logoUrl", "logo_url", "companyLogoUrl", "company_logo_url"),
    websiteUrl: stringField(raw, "websiteUrl", "website_url", "companyWebsiteUrl", "company_website_url"),
  };
}

export function normalizeList(raw: RawObject): BuildoutList {
  const slug = stringField(raw, "slug") ?? stringField(raw, "id") ?? "all";
  return {
    id: stringField(raw, "id") ?? slug,
    slug,
    name: stringField(raw, "name") ?? slug,
    description: stringField(raw, "description"),
    shortDescription: stringField(raw, "shortDescription", "short_description"),
    companyCount: numberField(raw, "companyCount", "company_count"),
    totalMarketCap: stringField(raw, "totalMarketCap", "total_market_cap"),
    avgSectorGrowth: stringField(raw, "avgSectorGrowth", "avg_sector_growth"),
    avgReturn1y: stringField(raw, "avgReturn1y", "avg_return_1y"),
    avgMargin: stringField(raw, "avgMargin", "avg_margin"),
  };
}

/**
 * The statement figures a depositary receipt can carry in the issuer's
 * reporting currency under a "$" and the receipt's USD currency: the service
 * converts a foreign listing's figures and keeps the local ones as "...Original",
 * but for an ADR it prints the local amounts as they are and names no currency
 * (SK hynix's receipt shows the won revenue of its Korean listing as dollars).
 */
const STATEMENT_FIELDS = ["revenue", "netIncome", "freeCashFlow", "operatingCashFlow", "totalCash", "totalDebt", "dilutedEps"] as const;

/** A yearly figure this many times the company's whole market value is not dollars. */
const IMPLAUSIBLE_MULTIPLE_OF_MARKET_CAP = 10;

/**
 * A USD row with nothing converted whose revenue or net income dwarfs its own
 * market cap has statements in another currency, and the row does not say
 * which: the figures are left out rather than shown as wrong dollars. The
 * ordinary range of revenue to market cap is a few times; the rows this
 * catches sit at 15 to 4,000.
 */
function withoutUnconvertedStatements(company: BuildoutCompany): BuildoutCompany {
  const converted = [company.revenueOriginal, company.netIncomeOriginal].some((value) => textOrNull(value) != null);
  const usd = (company.currency?.trim().toUpperCase() || "USD") === "USD";
  const cap = moneyAmount(company.marketCap);
  if (converted || !usd || cap == null || cap <= 0) return company;
  const revenue = moneyAmount(company.revenue);
  const income = moneyAmount(company.netIncome);
  const limit = cap * IMPLAUSIBLE_MULTIPLE_OF_MARKET_CAP;
  if ((revenue == null || Math.abs(revenue) <= limit) && (income == null || Math.abs(income) <= limit)) return company;
  return { ...company, ...Object.fromEntries(STATEMENT_FIELDS.map((field) => [field, null])) };
}

export function normalizeCompany(raw: RawObject): BuildoutCompany {
  return withoutUnconvertedStatements(readCompany(raw));
}

function readCompany(raw: RawObject): BuildoutCompany {
  const ticker = tickerSymbol(stringField(raw, "ticker"));
  const name = stringField(raw, "name") ?? ticker ?? "Company";
  const supplyChain = objectField(raw, "supplyChain", "supply_chain");
  return {
    id: stringField(raw, "id") ?? ticker ?? name,
    name,
    ticker,
    exchange: stringField(raw, "exchange"),
    starred: booleanField(raw, "starred") === true,
    description: stringField(raw, "description"),
    longDescription: stringField(raw, "longDescription", "long_description"),
    primarySector: stringField(raw, "primarySector", "primary_sector", "sector_yf", "industry"),
    primarySubsector: stringField(raw, "primarySubsector", "primary_subsector"),
    primaryTechnology: stringField(raw, "primaryTechnology", "primary_technology"),
    sectors: stringArrayField(raw, "sectors"),
    subSectors: stringArrayField(raw, "subSectors", "sub_sectors"),
    technologies: stringArrayField(raw, "technologies"),
    valueChainStages: stringArrayField(raw, "valueChainStages", "value_chain_stages"),
    aiCriticality: stringField(raw, "aiCriticality", "ai_criticality"),
    aiCriticalityJustification: stringField(raw, "aiCriticalityJustification", "ai_criticality_justification"),
    exportControlExposure: stringField(raw, "exportControlExposure", "export_control_exposure"),
    maturity: stringField(raw, "maturity"),
    currency: stringField(raw, "currency"),
    marketCap: stringField(raw, "marketCap", "market_cap"),
    marketCapOriginal: stringField(raw, "marketCapOriginal", "market_cap_original"),
    enterpriseValue: stringField(raw, "enterpriseValue", "enterprise_value"),
    stockPrice: stringField(raw, "stockPrice", "stock_price"),
    stockPriceOriginal: stringField(raw, "stockPriceOriginal", "stock_price_original"),
    revenue: stringField(raw, "revenue"),
    revenueOriginal: stringField(raw, "revenueOriginal", "revenue_original"),
    revenueGrowthYoy: stringField(raw, "revenueGrowthYoy", "revenue_growth_yoy", "revenue_growth"),
    lastQuarterGrowth: stringField(raw, "lastQuarterGrowth", "last_quarter_growth", "last_quarter_revenue_growth"),
    netIncome: stringField(raw, "netIncome", "net_income"),
    netIncomeOriginal: stringField(raw, "netIncomeOriginal", "net_income_original"),
    peRatio: stringField(raw, "peRatio", "pe_ratio", "pe_ratio_ttm"),
    profitMargins: stringField(raw, "profitMargins", "profit_margins", "profit_margin", "margin"),
    netProfitMargin: stringField(raw, "netProfitMargin", "net_profit_margin"),
    forwardPE: stringField(raw, "forwardPE", "forwardPe", "forward_pe"),
    trailingPE: stringField(raw, "trailingPE", "trailingPe", "trailing_pe"),
    pegRatio: stringField(raw, "pegRatio", "peg_ratio"),
    priceToBook: stringField(raw, "priceToBook", "price_to_book"),
    dilutedEps: stringField(raw, "dilutedEps", "diluted_eps"),
    dilutedEpsOriginal: stringField(raw, "dilutedEpsOriginal", "diluted_eps_original"),
    beta: stringField(raw, "beta"),
    high52w: stringField(raw, "high52w", "high_52w"),
    high52wOriginal: stringField(raw, "high52wOriginal", "high_52w_original"),
    low52w: stringField(raw, "low52w", "low_52w"),
    low52wOriginal: stringField(raw, "low52wOriginal", "low_52w_original"),
    grossProfitMargin: stringField(raw, "grossProfitMargin", "gross_profit_margin"),
    operatingMargin: stringField(raw, "operatingMargin", "operating_margin"),
    returnOnEquity: stringField(raw, "returnOnEquity", "return_on_equity"),
    returnOnAssets: stringField(raw, "returnOnAssets", "return_on_assets"),
    freeCashFlow: stringField(raw, "freeCashFlow", "free_cash_flow"),
    freeCashFlowOriginal: stringField(raw, "freeCashFlowOriginal", "free_cash_flow_original"),
    operatingCashFlow: stringField(raw, "operatingCashFlow", "operating_cash_flow"),
    totalCash: stringField(raw, "totalCash", "total_cash"),
    totalCashOriginal: stringField(raw, "totalCashOriginal", "total_cash_original"),
    totalDebt: stringField(raw, "totalDebt", "total_debt"),
    totalDebtOriginal: stringField(raw, "totalDebtOriginal", "total_debt_original"),
    debtToEquity: stringField(raw, "debtToEquity", "debt_to_equity"),
    currentRatio: stringField(raw, "currentRatio", "current_ratio"),
    quickRatio: stringField(raw, "quickRatio", "quick_ratio"),
    dividendYield: stringField(raw, "dividendYield", "dividend_yield"),
    exDividendDate: stringField(raw, "exDividendDate", "ex_dividend_date"),
    dividendDate: stringField(raw, "dividendDate", "dividend_date"),
    targetHighPrice: stringField(raw, "targetHighPrice", "target_high_price"),
    targetHighPriceOriginal: stringField(raw, "targetHighPriceOriginal", "target_high_price_original"),
    targetLowPrice: stringField(raw, "targetLowPrice", "target_low_price"),
    targetLowPriceOriginal: stringField(raw, "targetLowPriceOriginal", "target_low_price_original"),
    targetMeanPrice: stringField(raw, "targetMeanPrice", "target_mean_price"),
    targetMeanPriceOriginal: stringField(raw, "targetMeanPriceOriginal", "target_mean_price_original"),
    analystCount: stringField(raw, "analystCount", "analyst_count"),
    recommendation: stringField(raw, "recommendation"),
    strongBuy: stringField(raw, "strongBuy", "strong_buy"),
    buy: stringField(raw, "buy"),
    hold: stringField(raw, "hold"),
    sell: stringField(raw, "sell"),
    strongSell: stringField(raw, "strongSell", "strong_sell"),
    heldByInsiders: stringField(raw, "heldByInsiders", "held_by_insiders"),
    heldByInstitutions: stringField(raw, "heldByInstitutions", "held_by_institutions"),
    sharesShort: stringField(raw, "sharesShort", "shares_short"),
    shortRatio: stringField(raw, "shortRatio", "short_ratio"),
    sharesOutstanding: stringField(raw, "sharesOutstanding", "shares_outstanding"),
    floatShares: stringField(raw, "floatShares", "float_shares"),
    nextEarningsDate: stringField(raw, "nextEarningsDate", "next_earnings_date"),
    return1y: stringField(raw, "return1y", "return_1y", "oneYearReturn", "one_year_return"),
    return3y: stringField(raw, "return3y", "return_3y", "threeYearReturn", "three_year_return"),
    employeeCount: compactInteger(numberField(raw, "employeeCount", "employee_count", "employees")) ?? stringField(raw, "employeeCount", "employee_count", "employees"),
    countryHq: stringField(raw, "countryHq", "country_hq"),
    hqAddress: stringField(raw, "hqAddress", "hq_address"),
    city: stringField(raw, "city"),
    state: stringField(raw, "state"),
    websiteUrl: stringField(raw, "websiteUrl", "website_url"),
    logoUrl: stringField(raw, "logoUrl", "logo_url"),
    researchReport: stringField(raw, "researchReport", "research_report"),
    listReason: stringField(raw, "listReason", "list_reason"),
    intelligence: arrayField(raw, "intelligence").map((item) => ({
      publishedAt: stringField(item, "publishedAt", "published_at"),
      headline: stringField(item, "headline", "title"),
      content: stringField(item, "content"),
      sentimentScore: stringField(item, "sentimentScore", "sentiment_score"),
      sourceUrl: stringField(item, "sourceUrl", "source_url"),
    })),
    supplyChain: supplyChain
      ? {
        suppliers: arrayField(supplyChain, "suppliers").map(normalizeRelatedCompany),
        customers: arrayField(supplyChain, "customers").map(normalizeRelatedCompany),
        competitors: arrayField(supplyChain, "competitors").map(normalizeRelatedCompany),
      }
      : undefined,
    sites: arrayField(raw, "sites").map((site) => {
      const siteLocation = objectField(site, "location");
      const areaKm2 = numberField(site, "areaKm2", "area_km2");
      return {
        name: stringField(site, "name"),
        type: stringField(site, "type"),
        relationship: stringField(site, "relationship"),
        role: stringField(site, "role"),
        involvementSummary: stringField(site, "involvementSummary", "involvement_summary"),
        ownerName: stringField(site, "ownerName", "owner_name"),
        ownerTicker: tickerSymbol(stringField(site, "ownerTicker", "owner_ticker")),
        powerCapacity: stringField(site, "powerCapacity", "power_capacity"),
        areaKm2: areaKm2 == null ? stringField(site, "areaKm2", "area_km2") : `${areaKm2.toFixed(2)} km2`,
        constructionActivity: numberField(site, "constructionActivity", "construction_activity"),
        parkingActivity: numberField(site, "parkingActivity", "parking_activity"),
        location: siteLocation
          ? {
            city: stringField(siteLocation, "city"),
            country: stringField(siteLocation, "country"),
          }
          : undefined,
      };
    }),
  };
}

function normalizeObservation(raw: RawObject): BuildoutObservation {
  const captureBounds = objectField(raw, "captureBounds", "capture_bounds");
  return {
    id: stringField(raw, "id") ?? undefined,
    captureDate: stringField(raw, "captureDate", "capture_date"),
    imageUrl: stringField(raw, "imageUrl", "image_url"),
    originalImageUrl: stringField(raw, "originalImageUrl", "original_image_url"),
    upscaledImageUrl: stringField(raw, "upscaledImageUrl", "upscaled_image_url"),
    swirImageUrl: stringField(raw, "swirImageUrl", "swir_image_url"),
    nirImageUrl: stringField(raw, "nirImageUrl", "nir_image_url"),
    observationSource: stringField(raw, "observationSource", "observation_source"),
    note: stringField(raw, "note"),
    captureBounds: captureBounds
      ? {
        minLng: numberField(captureBounds, "minLng", "min_lng"),
        maxLng: numberField(captureBounds, "maxLng", "max_lng"),
        minLat: numberField(captureBounds, "minLat", "min_lat"),
        maxLat: numberField(captureBounds, "maxLat", "max_lat"),
      }
      : null,
  };
}

function normalizeReportSection(raw: RawObject): BuildoutReportSection {
  return {
    title: stringField(raw, "title", "heading", "name"),
    body: stringField(raw, "body", "text"),
    content: stringField(raw, "content"),
    markdown: stringField(raw, "markdown"),
    section: stringField(raw, "section"),
  };
}

function normalizeReportSections(raw: RawObject): BuildoutReportSection[] {
  const arraySections = arrayField(raw, "projectReportSections", "project_report_sections");
  if (arraySections.length > 0) return arraySections.map(normalizeReportSection);

  const objectSections = objectField(raw, "projectReportSections", "project_report_sections");
  if (!objectSections) return [];

  return [
    { key: "overview", title: "Project Overview" },
    { key: "construction", title: "Construction" },
    { key: "technology", title: "Technology" },
    { key: "funding", title: "Funding" },
    { key: "future", title: "Future" },
  ].flatMap(({ key, title }) => {
    const value = stringField(objectSections, key);
    return value ? [{ title, markdown: value }] : [];
  });
}

export function normalizeSite(raw: RawObject): BuildoutSite {
  const location = objectField(raw, "location");
  const park = objectField(raw, "park");
  const area = stringField(raw, "areaKm2", "area_km2");
  return {
    id: stringField(raw, "id") ?? stringField(raw, "name") ?? "site",
    name: stringField(raw, "name") ?? "Site",
    type: stringField(raw, "type"),
    starred: booleanField(raw, "starred") === true,
    ownerName: stringField(raw, "ownerName", "owner_name"),
    ownerTicker: tickerSymbol(stringField(raw, "ownerTicker", "owner_ticker")),
    ownerLogoUrl: stringField(raw, "ownerLogoUrl", "owner_logo_url"),
    ownerWebsiteUrl: stringField(raw, "ownerWebsiteUrl", "owner_website_url"),
    address: stringField(raw, "address"),
    location: location
      ? {
        city: stringField(location, "city"),
        country: stringField(location, "country"),
      }
      : undefined,
    boundaryConfirmed: booleanField(raw, "boundaryConfirmed", "boundary_confirmed"),
    constructionActivity: numberField(raw, "constructionActivity", "construction_activity"),
    parkingActivity: numberField(raw, "parkingActivity", "parking_activity"),
    latestCapture: stringField(raw, "latestCapture", "latest_capture"),
    activityUpdatedAt: stringField(raw, "activityUpdatedAt", "activity_updated_at"),
    powerCapacity: stringField(raw, "powerCapacity", "power_capacity"),
    eta: stringField(raw, "eta"),
    description: stringField(raw, "description"),
    parkName: stringField(raw, "parkName", "park_name") ?? (park ? stringField(park, "name") : null),
    areaKm2: area ? `${area} km2` : null,
    siteMetadata: objectField(raw, "siteMetadata", "site_metadata"),
    observations: arrayField(raw, "observations").map(normalizeObservation),
    projectReportSections: normalizeReportSections(raw),
    projectReportSources: arrayField(raw, "projectReportSources", "project_report_sources").map(normalizeSource),
    researchReport: stringField(raw, "researchReport", "research_report"),
    lastEnrichedAt: stringField(raw, "lastEnrichedAt", "last_enriched_at"),
    builders: arrayField(raw, "builders").map((builder) => ({
      companyName: stringField(builder, "companyName", "company_name", "name"),
      companyTicker: tickerSymbol(stringField(builder, "companyTicker", "company_ticker", "ticker")),
      companyWebsiteUrl: stringField(builder, "companyWebsiteUrl", "company_website_url", "websiteUrl", "website_url"),
      role: stringField(builder, "role"),
      summary: stringField(builder, "summary"),
    })),
    discoverySources: arrayField(raw, "discoverySources", "discovery_sources").map(normalizeSource),
  };
}

export function normalizeUpdate(raw: RawObject): BuildoutUpdate {
  return {
    id: stringField(raw, "id") ?? stringField(raw, "headline") ?? "intel",
    headline: stringField(raw, "headline", "title") ?? "Intel",
    content: stringField(raw, "content"),
    context: stringField(raw, "context"),
    imageUrl: stringField(raw, "imageUrl", "image_url"),
    type: stringField(raw, "type"),
    publishedAt: stringField(raw, "publishedAt", "published_at"),
    verificationStatus: stringField(raw, "verificationStatus", "verification_status"),
    companies: arrayField(raw, "companies").map((company) => ({
      name: stringField(company, "name"),
      ticker: tickerSymbol(stringField(company, "ticker")),
      websiteUrl: stringField(company, "websiteUrl", "website_url"),
      countryHq: stringField(company, "countryHq", "country_hq"),
    })),
    contextSources: arrayField(raw, "contextSources", "context_sources").map(normalizeSource),
    sourceUrls: Array.isArray(raw.sourceUrls)
      ? raw.sourceUrls.map((value) => textOrNull(value)).filter((value): value is string => value != null)
      : Array.isArray(raw.source_urls)
        ? raw.source_urls.map((value) => textOrNull(value)).filter((value): value is string => value != null)
        : [],
    isDelayed: raw.isDelayed === true || raw.is_delayed === true,
  };
}

export function allCompaniesList(): BuildoutList {
  return {
    id: "all",
    slug: "all",
    name: "All Companies",
    description: "View all companies in the database.",
  };
}
