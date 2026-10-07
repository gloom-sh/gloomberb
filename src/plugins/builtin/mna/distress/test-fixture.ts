/** Records trimmed from the public distress routes as they answered on 2026-10-06. */

export const filingEvent = (overrides: Record<string, unknown> = {}) => ({
  id: "f5ccc32c-2090-4800-9959-25820ac8f403",
  ticker: "LESL",
  company: { ticker: "LESL", cik: "0001821806", name: "Leslie's, Inc.", shortName: "Leslie's" },
  filedAt: "2026-10-05T20:45:22.000Z",
  filingDate: "2026-10-05",
  form: "8-K",
  docUrl: "https://www.sec.gov/Archives/edgar/data/1821806/000119312526414287/d190635d8k.htm",
  items: ["1.01", "1.03", "2.03", "3.01", "9.01"],
  labels: ["Material agreement", "Bankruptcy or receivership", "New debt or financial obligation", "Listing standard notice or delisting", "Exhibits"],
  kinds: ["agreement", "distress", "financing", "listing"],
  material: true,
  headline: "Leslie’s enters $90 million term-loan DIP facility and $225 million ABL DIP facility",
  summary: "Borrowed $45 million under the term-loan facility on October 2, 2026; no ABL DIP loans were drawn.",
  people: [],
  read: true,
  ...overrides,
});

/** A filer with no trading symbol keeps its CIK placeholder. */
export const placeholderFilingEvent = () => filingEvent({
  id: "d68db667-91a3-43d5-872f-08015f151098",
  ticker: "CIK1966394",
  company: { ticker: "CIK1966394", cik: "0001966394", name: "Fortress Net Lease REIT", shortName: "Fortress Net Lease REIT" },
  items: ["1.01", "2.04", "9.01"],
  labels: ["Material agreement", "Triggering event on an obligation", "Exhibits"],
  headline: "Credit facilities increased $30 million to $1.98 billion; Associated Bank joins as lender",
});

export const goingConcernRow = (overrides: Record<string, unknown> = {}) => ({
  id: "418",
  cik: "73290",
  ticker: "BMRA:NASDAQ",
  accession: "0001493152-26-040851",
  form: "10-K",
  period_end: "2026-05-31",
  filed_at: "2026-08-31",
  fact_date: "2026-05-31",
  tag: "LiquidityAndGoingConcernPolicyTextBlock",
  verdict: "doubt_raised",
  within_one_year: true,
  source_within_one_year: null,
  summary: "The company disclosed that \"These factors raise substantial doubt about our ability to continue as a going concern.\"",
  quote: "These factors raise substantial doubt about our ability to continue as a going concern.",
  text: "LIQUIDITY AND GOING CONCERN We have incurred net losses and negative cash flows from operations and as of May 31, 2026, have an accumulated deficit.",
  dataset_month: "2026-08",
  read_at: "2026-10-06T17:27:12.974Z",
  text_truncated: false,
  company: { ticker: "BMRA:NASDAQ", cik: "73290", name: "Biomerica Inc.", shortName: "Biomerica" },
  filing_url: "https://www.sec.gov/Archives/edgar/data/73290/000149315226040851/0001493152-26-040851-index.html",
  ...overrides,
});

const TWSE_ATTRIBUTION = {
  source: "twse",
  dataset: "終止上市公司 / 證券變更交易",
  version: "OpenAPI 1.0",
  organization: "Financial Supervisory Commission, Securities and Futures Bureau; Taiwan Stock Exchange",
  datasets: ["https://data.gov.tw/dataset/11543", "https://data.gov.tw/dataset/11760"],
  licence: "Open Government Data License, version 1.0",
  licenceUrl: "https://data.gov.tw/license",
  notice: "The Open Data is made available to the public under the Open Government Data License. Users may use it when complying with its conditions and obligations.",
  year: 2026,
};

export const designationRow = (overrides: Record<string, unknown> = {}) => ({
  id: "11",
  source: "twse",
  region: "TW",
  exchange: "TWSE",
  symbol: "4943:TWSE",
  local_code: "4943",
  entity_name: "康控-KY",
  entity_name_en: null,
  market_segment: "TWSE",
  kind: "changed_trading_method",
  designated_at: null,
  effective_at: null,
  first_seen_at: "2026-10-06T14:17:28.811Z",
  last_seen_at: "2026-10-06T14:17:28.811Z",
  ended_at: null,
  remarks: "PeriodicCallAuctionTrading=**; official designation date not supplied",
  source_url: "https://openapi.twse.com.tw/v1/exchangeReport/TWT85U",
  notice_url: null,
  date_basis: "first_observed",
  ...overrides,
});

export const delistedRow = () => designationRow({
  id: "1",
  symbol: "2867:TWSE",
  local_code: "2867",
  entity_name: "三商壽",
  kind: "delisted",
  effective_at: "2026-09-01",
  remarks: "",
  source_url: "https://openapi.twse.com.tw/v1/company/suspendListingCsvAndHtml",
  date_basis: "effective",
});

export const designationsPage = (designations: unknown[], extra: Record<string, unknown> = {}) => ({
  designations, hasMore: false, limit: 100, offset: 0, attributions: [TWSE_ATTRIBUTION], ...extra,
});

const GAZETTE_ATTRIBUTION = {
  source: "gazette_uk",
  organization: "The Gazette, The National Archives",
  dataset: "UK company insolvency notices",
  datasetUrl: "https://www.thegazette.co.uk/insolvency",
  licence: "Open Government Licence v3.0, Crown copyright (personal data excluded)",
  licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  notice: "Contains public sector information licensed under the Open Government Licence v3.0. Crown copyright. Personal data excluded. No endorsement by the source.",
};

export const insolvencyRow = (overrides: Record<string, unknown> = {}) => ({
  source: "gazette_uk",
  country: "GB",
  registry_id: "11332517",
  entity_name: "CAMBERLEY FISH BAR LTD",
  symbol: null,
  kind: "liquidation",
  raw_code: "2441",
  notice_date: "2026-10-02",
  published_date: "2026-10-05",
  court: "",
  notice_id: "5224538",
  notice_url: "https://www.thegazette.co.uk/notice/5224538",
  notice_type: "annonce",
  original_notice_id: null,
  status: "active",
  first_seen_at: "2026-10-06T21:18:23.778Z",
  last_seen_at: "2026-10-06T21:30:17.115Z",
  ...overrides,
});

export const insolvencyPage = (notices: unknown[], extra: Record<string, unknown> = {}) => ({
  notices, hasMore: false, limit: 100, offset: 0, attributions: [GAZETTE_ATTRIBUTION], ...extra,
});
