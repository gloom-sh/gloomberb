/**
 * The help card behind `HELP <fn>` and F1: what a function answers, how to
 * call it, the keys that matter in its pane, how fresh its data is on each
 * plan, the Bloomberg function it stands in for, and its docs entry.
 *
 * One entry per mnemonic the app's own plugins and commands register, keyed
 * by the primary mnemonic (aliases resolve to it). `function-help.test.ts`
 * fails when a function ships without an entry, or an entry outlives its
 * function. Summaries follow the docs catalog (gloom.sh/docs/functions); keys
 * are the pane's own footer hints, written the way the footer prints them.
 *
 * Freshness says what the data is and how fresh, never who sells it: no data
 * provider is named here, as in panes.
 */

const FUNCTION_DOCS_URL = "https://gloom.sh/docs/functions";

/** A pane key as its footer hint draws it: `{ key: "e", label: "xpiry" }` reads `[e]xpiry`. */
export interface FunctionHelpKey {
  key: string;
  label: string;
}

/** A function Free cannot fully open: Pro only, or a limited preview on Free. */
export type FunctionAccess = "pro" | "preview";

/** How fresh the function's data is on each plan, in the words a pane footer uses. */
export interface FunctionFreshness {
  free: string;
  pro: string;
}

export interface FunctionHelp {
  /** One or two sentences: what the function answers and when to reach for it. */
  summary: string;
  /** How it is typed, with a real argument; one line per form when the argument is optional. */
  usage: readonly string[];
  /** The two to four keys that matter in its pane; empty when it opens no pane of its own. */
  keys: readonly FunctionHelpKey[];
  /** Null when the function shows no market data (settings, your own notes). */
  data: FunctionFreshness | null;
  /**
   * What Free gets: `pro` when only Pro opens it, `preview` when Free sees a
   * limited preview of the same data. Absent when Free gets the whole
   * function, even where Pro makes it fresher.
   */
  access?: FunctionAccess;
  /** The Bloomberg mnemonics it stands in for; empty when Bloomberg has none. */
  bloomberg: readonly string[];
  /** The docs entry when it is filed under another mnemonic (BTST under BT), or the full URL of a page of its own. */
  docs?: string;
}

/** The docs page's anchor for a mnemonic, as the page builds heading ids, or a full docs URL as is. */
export function functionDocsUrl(code: string): string {
  if (code.startsWith("https://")) return code;
  const anchor = code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return anchor ? `${FUNCTION_DOCS_URL}#${anchor}` : FUNCTION_DOCS_URL;
}

const key = (hotkey: string, label: string): FunctionHelpKey => ({ key: hotkey, label });
const same = (value: string): FunctionFreshness => ({ free: value, pro: value });

const DELAYED = "15 minutes delayed";
const REAL_TIME = "Real-time";
/** Stocks and ETFs: US listings stream on Pro; other venues are delayed on every plan. Crypto streams on every plan. */
const QUOTES: FunctionFreshness = { free: "15 minutes delayed, crypto real-time", pro: "Real-time for US listings and crypto, other venues delayed" };
/** US option chains and the quotes behind them. */
const OPTIONS: FunctionFreshness = { free: DELAYED, pro: REAL_TIME };
const FX: FunctionFreshness = { free: DELAYED, pro: REAL_TIME };
/** Open interest settles once a session; spot and the quotes behind gamma follow the plan. */
const OPX_DATA: FunctionFreshness = {
  free: "Open interest as of the prior session; spot and gamma 15 minutes delayed",
  pro: "Open interest as of the prior session; spot and gamma real-time",
};
const NEWS: FunctionFreshness = { free: "12 hours delayed", pro: REAL_TIME };
const US_SCANNER: FunctionFreshness = { free: DELAYED, pro: REAL_TIME };
const AS_FILED = same("As filed with the SEC");
const DAILY_CLOSES = same("Daily closes");
const ON_RELEASE = same("On release");
/** Report days: dates daily, implied moves from live option quotes. */
const EARNINGS_DAYS: FunctionFreshness = { free: "Daily, implied moves 15 minutes delayed", pro: "Daily, implied moves real-time" };
/** Stored daily IV: a reading just before the 16:00 New York close, trade closes after 18:00. */
const IV_DAILY: FunctionFreshness = { free: "Daily, 15 minutes after the pre-close reading", pro: "Daily, read just before the 16:00 New York close" };
/** A Pro function: nothing on Free but the upgrade. */
const pro = (value: string): FunctionFreshness => ({ free: "Pro only", pro: value });

const TABS = key("h/l", " tabs");
const OPEN = key("Enter", " open");
const SEARCH = key("/", "search");
const OPEN_SOURCE = key("o", "pen source");
const POP_OUT = key("p", "op out");
const STEP = key("←/→", " step");
/** THEM and MEMB members: open them in RRG, CORR, SIW or RIPL, or save them as a watchlist. */
const MEMBERS_MENU = key(".", " open members in, save as watchlist");
const CHART_KEYS = [key("s", "eries"), key("i", "ndicators"), key("t", "imeframe"), key("f", "ormulas")];

export const FUNCTION_HELP: Readonly<Record<string, FunctionHelp>> = {
  // Research companies
  DES: {
    summary: "The starting point for any ticker: live quote, day and 52-week range, price chart, fundamentals, and tabs into every other research pane.",
    usage: ["DES NVDA"],
    keys: [TABS, key(".", " go to tab")],
    data: QUOTES,
    bloomberg: ["DES"],
  },
  QQ: {
    summary: "A compact board of live quotes for any list of tickers, each with change, range and a sparkline. Good as the always-open strip in a layout.",
    usage: ["QQ NVDA, AAPL, MSFT"],
    keys: [key("t", "ickers"), OPEN],
    data: QUOTES,
    bloomberg: ["W"],
  },
  GP: {
    summary: "A price chart with volume, on a multi-year range by default. Add indicators, drawings or other series in the same pane.",
    usage: ["GP AAPL"],
    keys: CHART_KEYS,
    data: QUOTES,
    bloomberg: ["GP"],
  },
  GIP: {
    summary: "One or five sessions of intraday candles with the session boundaries marked.",
    usage: ["GIP TSLA"],
    keys: CHART_KEYS,
    data: QUOTES,
    bloomberg: ["GIP"],
  },
  G: {
    summary: "Chart any series together: prices, statement lines, valuation multiples, FRED series, map series such as chokepoint transits, indicators and formulas. Series read SYMBOL:field, FRED:series or GEO:series.",
    usage: ["G", "G NVDA:revenue, NVDA:net_income", "G XOM, GEO:HORMUZ"],
    keys: CHART_KEYS,
    data: { free: "Prices 15 minutes delayed, other series as published", pro: "Prices real-time for US listings, other series as published" },
    bloomberg: ["G"],
  },
  CAT: {
    summary: "Search every series the chart composer knows: securities, options, crypto, FRED, Treasuries and futures. Pick one to chart it.",
    usage: ["CAT", "CAT fed funds"],
    keys: [SEARCH, key("g", "raph")],
    data: null,
    bloomberg: [],
  },
  CMP: {
    summary: "Price returns rebased to a shared start date for two or more tickers, so relative performance reads at a glance.",
    usage: ["CMP NVDA, AMD, AVGO"],
    keys: CHART_KEYS,
    data: QUOTES,
    bloomberg: ["COMP", "TRA"],
  },
  GF: {
    summary: "Quarterly revenue for one or more companies as grouped columns, with any other statement field one step away in Series.",
    usage: ["GF MSFT, GOOGL, AMZN"],
    keys: CHART_KEYS,
    data: AS_FILED,
    bloomberg: ["GF"],
  },
  GE: {
    summary: "Trailing P/E history for one or more tickers; switch to forward P/E, PEG, P/S, EV/EBITDA or P/FCF in Series.",
    usage: ["GE AAPL, MSFT"],
    keys: CHART_KEYS,
    data: same("Daily, earnings as filed"),
    bloomberg: ["EQRV"],
  },
  FA: {
    summary: "Annual and quarterly income statement, balance sheet and cash flow, with derived margins and growth.",
    usage: ["FA MSFT"],
    keys: [TABS, key("p", "eriod"), key("e", "xpand"), key("c", "ollapse")],
    data: AS_FILED,
    bloomberg: ["FA"],
  },
  DDIS: {
    summary: "Principal due in the next 12 months, in each of years two to five, and after, from the latest annual filing, with the near-term share ranked against 10 years.",
    usage: ["DDIS ORCL"],
    keys: [TABS, STEP, OPEN_SOURCE],
    data: AS_FILED,
    bloomberg: ["DDIS"],
  },
  HP: {
    summary: "Daily open, high, low, close and volume in a scrollable table.",
    usage: ["HP AAPL"],
    keys: [key("t", " range")],
    data: QUOTES,
    bloomberg: ["HP"],
  },
  RETURN: {
    summary: "Interval and cumulative price returns in a scrollable table, for a selectable range and granularity.",
    usage: ["RETURN AAPL"],
    keys: [key("/", "search")],
    data: QUOTES,
    bloomberg: [],
  },
  GR: {
    summary: "How two tickers move together: indexed prices, their ratio, rolling correlation, and a return regression with beta, alpha and R².",
    usage: ["GR NVDA, AMD"],
    keys: [key("t", " range")],
    data: DAILY_CLOSES,
    bloomberg: ["HS", "BETA", "HRA"],
  },
  CORR: {
    summary: "A date-aligned correlation matrix of daily returns for a basket: how diversified a set of names really is.",
    usage: ["CORR NVDA, AMD, AVGO, TSM"],
    keys: [],
    data: DAILY_CLOSES,
    bloomberg: ["CORR"],
  },
  BT: {
    summary: "Test a long-only rule on daily history against buy-and-hold: a preset like golden cross or RSI, or your own, like rsi(14) < 30. Equity, drawdown, CAGR, Sharpe and every trade.",
    usage: ["BT AAPL"],
    keys: [key("s", "trategy"), key("e", "dit rules"), key("v", "iew")],
    data: DAILY_CLOSES,
    bloomberg: ["BTST"],
  },
  BTST: {
    summary: "The Bloomberg name for BT: test a long-only indicator rule on daily history against buy-and-hold.",
    usage: ["BTST AAPL"],
    keys: [key("s", "trategy"), key("e", "dit rules"), key("v", "iew")],
    data: DAILY_CLOSES,
    bloomberg: ["BTST"],
    docs: "BT",
  },
  RV: {
    summary: "Valuation and operating metrics for a peer group in one table: market cap, P/E, EV/EBITDA, margins, growth and more.",
    usage: ["RV NVDA, AMD, AVGO"],
    keys: [OPEN],
    data: same("Daily, statements as filed"),
    bloomberg: ["RV"],
  },
  EQS: {
    summary: "Screen covered stocks on valuation, growth, margins, liquidity, short interest, insider activity and 13F holders, then rank the matches by any metric.",
    usage: ["EQS"],
    keys: [key("a", "dd criterion"), key("m", "etric"), key("s", "ave screen"), key("o", "pen research")],
    data: same("Daily snapshot, statements as filed"),
    bloomberg: ["EQS"],
  },
  OMON: {
    summary: "Calls and puts by expiry with bid, ask, spread, volume, open interest, implied volatility, Greeks and extrinsic per year. "
      + "The Strikes filter lists every strike, a count either side of the money, or a delta band such as .70 to .90 for deep in-the-money LEAPS.",
    usage: ["OMON NVDA", "gloomberb fn OMON NVDA --expiration 2028-01-21"],
    keys: [key("c", "alc"), key("a", "dd to OSA"), key("s", "urface")],
    data: OPTIONS,
    bloomberg: ["OMON"],
  },
  OPX: {
    summary: "Open interest by strike for one expiry with max pain and spot marked, every expiry's open interest, put/call ratio and max pain, and dealer gamma (GEX) by strike with its flip level and a range for the dealer assumption. MAXPAIN opens it too.",
    usage: ["OPX", "OPX SPY", "OPX SPX"],
    keys: [TABS, OPEN],
    data: OPX_DATA,
    bloomberg: ["OPX"],
  },
  GEX: {
    summary: "Net dealer gamma by strike across every expiry or one, with the total, the flip level and a range for the dealer assumption. The GEX tab of OPX.",
    usage: ["GEX", "GEX SPY", "GEX SPX"],
    keys: [TABS],
    data: OPX_DATA,
    bloomberg: [],
    docs: "OPX",
  },
  OVME: {
    summary: "Price a European or American call or put from spot, strike, rate, volatility and expiry, with Greeks, or solve implied volatility from a market price.",
    usage: ["OVME"],
    keys: [key("e", "dit"), key("m", "odel"), key("v", "ol source"), key("t", "icker")],
    data: OPTIONS,
    bloomberg: ["OVME", "OVML"],
  },
  OSA: {
    summary: "Build a multi-leg options position and value it at any spot, date and vol shift: payoff, P&L grid, breakevens and Greeks. European pricing, so no early exercise.",
    usage: ["OSA AAPL", "gloomberb fn OSA AAPL --strategy vertical --expiration 2027-01-15"],
    keys: [key("a", "dd leg"), key("c", "hain"), key("d", "ate"), key("v", "ol shift")],
    data: OPTIONS,
    bloomberg: ["OSA"],
  },
  OVDV: {
    summary: "The implied volatility surface fitted from option quotes: 3D sheet, table, smiles, ATM term structure, 25-delta skew and forwards, live or on stored daily closes.",
    usage: ["OVDV NVDA", "gloomberb fn OVDV NVDA --tab skew --expiration 2027-01-15"],
    keys: [key("v", "iew"), key("c", "hain"), key("m", "ore expiries"), key("t", " stored dates")],
    data: { free: `${DELAYED}; stored dates at the close`, pro: "Real-time; stored dates at the close" },
    bloomberg: ["OVDV"],
  },
  HIVG: {
    summary: "Daily 30-day, 90-day and one-year at-the-money implied vol since February 2024 against realized vol, with each measure's 52-week rank and percentile.",
    usage: ["HIVG AAPL"],
    keys: [key("s", "urface")],
    data: IV_DAILY,
    bloomberg: ["HIVG", "GV"],
  },
  HVG: {
    summary: "Rolling realized volatility over windows from 10 to 260 sessions, with price and today's at-the-money IV for reference.",
    usage: ["HVG MSFT"],
    keys: [key("v", "iew"), key("i", "v on"), key("s", "urface")],
    data: { free: `Daily closes; ATM IV ${DELAYED}`, pro: "Daily closes; ATM IV real-time" },
    bloomberg: ["HVG"],
  },
  HVT: {
    summary: "Each window's realized volatility against its one- or two-year range, as a cone and a table, with today's at-the-money IV on top: is vol high for this name?",
    usage: ["HVT TSLA"],
    keys: [key("v", "iew"), key("i", "v on"), key("s", "urface")],
    data: { free: `Daily closes; ATM IV ${DELAYED}`, pro: "Daily closes; ATM IV real-time" },
    bloomberg: ["HVT"],
    docs: "HVT",
  },
  SEAS: {
    summary: "Does this name have a calendar? Monthly returns for each year, every month's average, median and share of up years, and each year's path laid over one January-to-December axis.",
    usage: ["SEAS AAPL"],
    keys: [],
    data: DAILY_CLOSES,
    bloomberg: ["SEAS"],
  },
  RIPL: {
    summary: "Which of my holdings are tied to a company that reports soon? Customers your holdings name in their filings, and suppliers whose filings name your holdings, with the disclosed revenue share, by report date. With Pro, the 2 hops tab adds a supplier's supplier or a customer's customer, the company in between and each hop's share.",
    usage: ["RIPL", "RIPL CRUS QRVO"],
    keys: [TABS, key("Enter", " supply chain, the route on 2 hops"), key("e", "arnings")],
    data: ON_RELEASE,
    bloomberg: [],
  },
  RDCF: {
    summary: "What growth is the price assuming? The yearly free cash flow growth over ten years that makes a DCF equal today's enterprise value, next to the growth the company delivered.",
    usage: ["RDCF AAPL"],
    keys: [],
    data: ON_RELEASE,
    bloomberg: [],
  },
  PEB: {
    summary: "Is the stock cheap or rich against itself? Weekly price against round multiples of trailing EPS, stepping when each EPS figure became known, with today's P/E ranked in its own history.",
    usage: ["PEB AAPL", "PEB RELIANCE.NS"],
    keys: [],
    data: ON_RELEASE,
    bloomberg: [],
  },
  MDAY: {
    summary: "Does this name care about CPI day? Its average move on CPI, jobs report and FOMC days against a normal day, the average signed move and share of up days, and the move on every release day.",
    usage: ["MDAY SPY"],
    keys: [],
    data: DAILY_CLOSES,
    bloomberg: [],
  },
  VCA: {
    summary: "IV rank, one-year IV and its percentile, term slope, skew and IV against realized vol for up to 60 US tickers, flagged rich or cheap against each name's own year. Alone it screens index and sector ETFs.",
    usage: ["VCA", "VCA NVDA, AAPL, TSLA"],
    keys: [OPEN],
    data: IV_DAILY,
    bloomberg: ["VCA"],
  },
  ANR: {
    summary: "Consensus price target with its range, the rating distribution, and recent upgrades, downgrades and initiations by firm.",
    usage: ["ANR AMZN"],
    keys: [STEP],
    data: same("Daily"),
    bloomberg: ["ANR"],
  },
  EE: {
    summary: "Quarterly and annual EPS and revenue estimates next to reported results, with beats and misses.",
    usage: ["EE NVDA"],
    keys: [OPEN],
    data: same("Daily"),
    bloomberg: ["EE"],
  },
  EM: {
    summary: "Consensus EPS by quarter and year with its latest change, 30-day up and down revisions and range; open a period to chart it. Surprises and Guidance tabs too.",
    usage: ["EM MSFT"],
    keys: [TABS, OPEN, STEP],
    data: same("Daily"),
    bloomberg: ["EM", "EEO"],
  },
  GUID: {
    summary: "The outlook the company gave on its latest earnings call, taken from the transcript, above consensus for the coming periods. US listings.",
    usage: ["GUID NVDA"],
    keys: [TABS, OPEN_SOURCE],
    data: same("After each earnings call"),
    bloomberg: [],
  },
  EVT: {
    summary: "Dividend and split history plus past and upcoming earnings dates and estimates in one timeline.",
    usage: ["EVT AAPL"],
    keys: [OPEN],
    data: same("Daily"),
    bloomberg: ["CACS"],
  },
  EVTS: {
    summary: "The market's report days with implied and past moves; a ticker picks its row.",
    usage: ["EVTS", "EVTS NVDA"],
    keys: [key("t", "icker"), key("e", "stimates"), key("c", "alls"), key("a", "nalysts")],
    data: EARNINGS_DAYS,
    bloomberg: ["EVTS"],
    docs: "ERN",
  },
  ERN: {
    summary: "The market's report days with implied and past moves. Alone it is the market board; with tickers, just those names and their report history.",
    usage: ["ERN", "ERN NVDA, AAPL, MSFT"],
    keys: [key("t", "icker"), key("e", "stimates"), key("c", "alls"), key("a", "nalysts")],
    data: EARNINGS_DAYS,
    bloomberg: ["ERN"],
  },
  DVD: {
    summary: "Cash distributions, trailing yield, indicated rate when available, and payout growth. Future payments are not forecast.",
    usage: ["DVD KO"],
    keys: [STEP],
    data: same("Daily"),
    bloomberg: ["DVD"],
  },
  SI: {
    summary: "FINRA short interest settlements with shares short, days to cover and average daily volume over time. Daily volume is the other tab.",
    usage: ["SI AAPL"],
    keys: [key("v", "iew"), STEP],
    data: same("Twice a month, as FINRA publishes"),
    bloomberg: ["SI"],
  },
  SIW: {
    summary: "Which of your names are crowded shorts that are moving up? Short interest as a share of float, days to cover, the change since the prior settlement and the month's price move across your portfolios and watchlists, or the tickers you give.",
    usage: ["SIW", "SIW GME, AMC, CVNA"],
    keys: [OPEN],
    data: same("Twice a month, as FINRA publishes; daily closes"),
    bloomberg: [],
  },
  SIV: {
    summary: "The short interest pane on Daily volume: FINRA off-exchange short volume as a share of volume, against its one-year range.",
    usage: ["SIV TSLA"],
    keys: [key("v", "iew"), STEP, OPEN_SOURCE],
    data: same("Daily, the evening after each session"),
    bloomberg: [],
  },
  DIAG: {
    summary: "A read of the company's filings and numbers into red flags, anomalies, green flags and items to watch, each with the evidence it came from.",
    usage: ["DIAG NVDA"],
    keys: [OPEN_SOURCE],
    data: { free: "A preview of the latest report, verified email", pro: "The full report, rerun on demand" },
    access: "preview",
    bloomberg: [],
  },
  RISK: {
    summary: "The 10-K risk factor section grouped by theme, with what was added, dropped or rewritten since the prior year called out.",
    usage: ["RISK TSLA"],
    keys: [key("y", "ear"), key("o", "pen filing")],
    data: pro(AS_FILED.pro),
    access: "pro",
    bloomberg: [],
  },
  EXEC: {
    summary: "Named executive officers and what they were paid, read from the proxy statement and checked against the filing.",
    usage: ["EXEC NVDA"],
    keys: [key("y", "ear"), key("o", "pen filing")],
    data: pro(AS_FILED.pro),
    access: "pro",
    bloomberg: ["MGMT"],
  },
  EK: {
    summary: "The company's 8-Ks classified by item (agreements, executive changes, auditor changes, restructurings) with a summary of what each one said.",
    usage: ["EK NVDA"],
    keys: [key("o", "pen filing")],
    data: pro(AS_FILED.pro),
    access: "pro",
    bloomberg: ["CF"],
  },
  CALLS: {
    summary: "Earnings call transcripts with speakers, the analyst Q&A, and extracted guidance and quotes. Alone it lists every transcribed call as it lands.",
    usage: ["CALLS", "CALLS NVDA"],
    keys: [OPEN, key("/", "find"), OPEN_SOURCE],
    data: pro("Within hours of the call"),
    access: "pro",
    bloomberg: ["EVT"],
  },
  JOBS: {
    summary: "Hiring read from the company's own careers site every day: open roles over time, by function, country and seniority, new roles and pay ranges. Alone it ranks every covered company.",
    usage: ["JOBS", "JOBS NVDA"],
    keys: [key("1-4", " section"), key("o", "pen role"), key("c", "areers site")],
    data: pro("Daily"),
    access: "pro",
    bloomberg: [],
  },
  SRCH: {
    summary: "Full-text search across earnings call transcripts, news wires and SEC filings, with the matching passage inline. Save a search to get alerted on new hits.",
    usage: ["SRCH data center capex"],
    keys: [SEARCH, key("Ctrl+S", " save search"), key("a", "lerts")],
    data: pro("As calls, stories and filings arrive"),
    access: "pro",
    bloomberg: ["NSE"],
  },
  COVN: {
    summary: "Financial maintenance covenant thresholds, matching reported values and supported headroom. Open a covenant for its definition, calculation limits, literal filing evidence and instrument revisions.",
    usage: ["COVN FICO"],
    keys: [TABS, OPEN, OPEN_SOURCE, key("f", "a"), key("m", "aturities")],
    data: { free: "As filed; three supported rows per section", pro: "As filed; all covenants, evidence and revisions" },
    access: "preview",
    bloomberg: ["CAST"],
  },
  CRDOC: {
    summary: "Issuer capital structure, contractual covenants, supported headroom and maturity walls. Open each instrument for verbatim filing evidence and immutable amendment history. Screen for low headroom and approaching springing maturities.",
    usage: ["CRDOC FICO", "COVN AAPL"],
    keys: [TABS, OPEN, OPEN_SOURCE, key("d", "es"), key("f", "a"), key("m", "aturities"), key("c", "ds")],
    data: { free: "As filed; three rows per section with supporting evidence", pro: "As filed; all stored terms, revisions and risk screens" },
    access: "preview",
    bloomberg: ["CAST", "DDIS"],
  },
  ATTN: {
    summary: "See which tickers opted-in Gloom users are researching, with delayed privacy-qualified hourly counts, abnormal attention, sectors, countries and market context. Suppressed activity is unavailable, never zero.",
    usage: ["ATTN", "ATTN 6758:JPX"],
    keys: [OPEN, key("e", "vidence"), key("d", "es"), key("g", "raph"), key("n", "ews")],
    data: { free: "Three published rows per section and the latest history point", pro: "All published rows and hourly history; minimum one-hour publication lag" },
    access: "preview",
    bloomberg: [],
  },
  HIRE: {
    summary: "Pro hiring momentum: weekly observed open roles, additions and removals, role families, seniority, remote and location mix, peers and primary posting evidence. Observed requisitions are not headcount. No argument opens the covered-company board.",
    usage: ["HIRE", "HIRE NET", "HIRE 0700:HKEX"],
    keys: [TABS, OPEN, key("e", "vidence"), key("o", "pen source"), key("d", "es"), key("g", "raph")],
    data: { free: "Latest values and three rows per section", pro: "Weekly history, all stored observations and evidence" },
    access: "preview",
    bloomberg: [],
  },
  APPS: {
    summary: "Pro app attention: public app ranks by country, rank velocity, rating drift and country spreads, mapped through developers to listed parents. Evidence preserves capture and ownership revisions. Ranks are not downloads or revenue.",
    usage: ["APPS", "APPS META", "APPS 0700:HKEX"],
    keys: [TABS, OPEN, key("e", "vidence"), key("o", "pen source"), key("d", "es"), key("g", "raph")],
    data: { free: "Latest values and three rows per section", pro: "Daily observations, full history, countries and evidence" },
    access: "preview",
    bloomberg: [],
  },
  CATL: {
    summary: "Regulatory, clinical, legal and trade-policy events linked to companies. Filter the calendar by type, agency, country and sector, follow upcoming dates or observed changes, and inspect source evidence and revision history.",
    usage: ["CATL", "CATL PFE", "CATL NOVN:SIX"],
    keys: [TABS, OPEN, OPEN_SOURCE, key("a", "lert"), key("d", "es")],
    data: { free: "Three events with primary-source evidence", pro: "All stored events, revision history and local alerts" },
    access: "preview",
    bloomberg: [],
  },
  LITI: {
    summary: "Company litigation, enforcement and antitrust dockets with primary documents, resolved parties, dated status changes and revision history. Published coverage varies by jurisdiction.",
    usage: ["LITI AAPL", "LITI MSFT"],
    keys: [TABS, OPEN, OPEN_SOURCE, key("t", "o calendar")],
    data: { free: "Three company events with evidence", pro: "All stored company dockets and history" },
    access: "preview",
    bloomberg: ["LITI"],
  },
  KPIS: {
    summary: "Company operating KPIs, fiscal history and revisions with source quotes.",
    usage: ["KPIS CRM", "KPIS 005930:KRX"],
    keys: [TABS, OPEN, key("e", "vidence"), OPEN_SOURCE],
    data: { free: "Pro dataset; fixed latest preview with evidence", pro: "As disclosed; all stored observations and history" },
    access: "preview",
    bloomberg: [],
  },
  GUIDE: {
    summary: "Management guidance ranges, raises, cuts and later actuals, with source quotes.",
    usage: ["GUIDE DAL", "GUIDE CRM"],
    keys: [TABS, OPEN, key("e", "vidence"), OPEN_SOURCE],
    data: { free: "Pro dataset; fixed latest preview with evidence", pro: "As issued; full guidance history and actual matches" },
    access: "preview",
    bloomberg: [],
  },
  EXPO: {
    summary: "Pro scenario exposure engine. Trace country, supplier, customer, commodity, rate, FX and tariff shocks through holdings, disclosed revenue and supply chains. Table, Drivers, Paths and Portfolio preserve evidence, unknowns, signed NAV weights and separate operating denominators. Drivers adds sourced KPIs, guidance and credit disclosures.",
    usage: ["EXPO AAPL=60% NVDA=40%", "EXPO PORT:portfolio-id", "EXPO WATCH:watchlist-id"],
    keys: [TABS, OPEN, key("s", "cenario and holdings"), key("e", "vidence"), key("a", "ll company disclosures"), key("v", "isibility"), key("o", "pen source")],
    data: { free: "One holding and one-hop evidence preview", pro: "Full holdings and up to four-hop paths, as filed" },
    access: "preview",
    bloomberg: ["PORT", "SPLC"],
  },
  SPLC: {
    summary: "Pro global supply chain research in Table, Flow, Graph and Path with a free preview. Filter filings, company announcements, calls and reported evidence. Follow up to four disclosed hops with ranked paths and estimated exposure. Unconfirmed leads stay separate and out of the flow. Evidence carries publisher, date, corroboration, permitted original-language quotes or links, labelled English glosses and native disclosed units.",
    usage: ["SPLC NVDA", "SUPPLY AAPL", "SPLC 005930.KS", "SPLC 8035.T"],
    keys: [OPEN, key("e", "vidence"), key("d", "es"), key("g", "raph")],
    data: { free: "Three relationships per role with evidence and a one-hop graph preview", pro: "Full evidence tiers, one-to-four-hop graphs and ranked paths" },
    access: "preview",
    bloomberg: ["SPLC"],
  },
  AWARDS: {
    summary: "Government contracts mapped to verified listed parents, with a dated feed, company award history, agency concentration, sector leaders and awards relative to annual revenue. Inspect original evidence, revisions, subawards and modifications. Coverage varies by jurisdiction.",
    usage: ["AWARDS", "AWARDS LMT", "AWARDS BA.:LSE"],
    keys: [TABS, OPEN, SEARCH, key("e", "vidence"), key("o", "pen source"), key("d", "es"), key("f", "a"), key("g", "raph"), key("s", "plc"), key("c", "alendar")],
    data: { free: "Pro preview: three rows per section", pro: "All collected awards, history, revisions and relationships" },
    access: "preview",
    bloomberg: [],
  },
  SEG: {
    summary: "Quarterly revenue by product, segment or region from the company's 10-Q and 10-K filings.",
    usage: ["SEG AAPL"],
    keys: [],
    data: { free: "First two lines, about five weeks after each filing", pro: "Every line, about five weeks after each filing" },
    access: "preview",
    bloomberg: [],
  },
  TAS: {
    summary: "Recent trade prints with time, price, size, venue and conditions, observed VWAP, and prints of 10,000 shares or more standing out. US equities.",
    usage: ["TAS AAPL"],
    keys: [TABS, OPEN],
    data: US_SCANNER,
    bloomberg: ["TAS"],
  },
  QR: {
    summary: "Quote history: bid and ask with sizes, venues and spread in basis points, plus the median and widest spread and locked or crossed quotes. The quotes tab of TAS.",
    usage: ["QR AAPL"],
    keys: [TABS, OPEN],
    data: US_SCANNER,
    bloomberg: ["QR"],
  },
  BUZZ: {
    summary: "Daily posts on X naming the ticker's cashtag, the day's top posts and their stance.",
    usage: ["BUZZ TSLA"],
    keys: [OPEN, OPEN_SOURCE],
    data: same("Through the day"),
    bloomberg: [],
  },
  KELLY: {
    summary: "Kelly-based position sizing for a ticker against your bankroll, with loss caps, expected growth, and the trim or add needed.",
    usage: ["KELLY NVDA"],
    keys: [key("e", "dit"), key("s", "ensitivity"), SEARCH],
    data: QUOTES,
    bloomberg: [],
  },
  MA: {
    summary: "Pending, rumored and closed mergers and acquisitions, with live arbitrage spreads on listed targets.",
    usage: ["MA", "MA NVDA"],
    keys: [SEARCH, key("s", "tatus"), key("t", "arget"), OPEN_SOURCE],
    data: { free: "7 days delayed", pro: "As announced, spreads live" },
    bloomberg: ["MA"],
  },
  DIST: {
    summary: "Dated public records about companies in difficulty: 8-K bankruptcy, obligation and listing filings, SEC going-concern disclosures, Taiwan exchange listing designations, and French and UK insolvency notices. The Distress tab of MA.",
    usage: ["DIST"],
    keys: [key("←/→", " source"), OPEN, key("t", "icker"), key("o", "pen")],
    data: same("As published: 8-K filings through the day, going-concern disclosures from monthly SEC data sets, listings and notices daily"),
    bloomberg: [],
  },
  ASKG: {
    summary: "Ask a question about what is on screen and watch the tools Gloom runs to answer it.",
    usage: ["ASKG why is NVDA down today"],
    keys: [key("n", "ew conversation"), key("g", "ood answer"), key("b", "ad answer"), key("t", "ickers"), key("o", "pen pane")],
    data: null,
    bloomberg: ["ASKB"],
  },

  // Follow the news
  TOP: {
    summary: "Curated stories ranked by importance across wires, publishers and X, with tickers and category. The pane to keep open when you only want what matters.",
    usage: ["TOP"],
    keys: [OPEN, SEARCH, POP_OUT, key("t", "icker")],
    data: NEWS,
    bloomberg: ["TOP"],
  },
  N: {
    summary: "Every story as it arrives, newest first, with source, tickers, sentiment and importance; filter by sentiment or minimum score.",
    usage: ["N"],
    keys: [OPEN, SEARCH, POP_OUT, key("t", "icker"), key("y", " share")],
    data: NEWS,
    bloomberg: ["N"],
  },
  CN: {
    summary: "Stories linked to the ticker, newest first.",
    usage: ["CN NVDA"],
    keys: [OPEN, SEARCH, POP_OUT, key("t", "icker")],
    data: NEWS,
    bloomberg: ["CN"],
  },
  NI: {
    summary: "Market news by topic code (MNA, CB, ENERGY, REG, CRYPTO, EARN, IPO) or sector.",
    usage: ["NI ENERGY"],
    keys: [OPEN, SEARCH, POP_OUT, key("t", "icker")],
    data: NEWS,
    bloomberg: ["NI"],
  },
  FIRST: {
    summary: "Stories flagged as breaking or urgent. Turn on Notifications in its pane settings to hear about new ones while the pane is closed.",
    usage: ["FIRST"],
    keys: [OPEN, SEARCH, POP_OUT, key("t", "icker")],
    data: NEWS,
    bloomberg: ["FIRST"],
  },
  TWIT: {
    summary: "An X advanced-search feed for any ticker or query, with likes and views, refreshed every two minutes. Needs a verified email.",
    usage: ["TWIT $NVDA"],
    keys: [SEARCH, key("n", "ew feed"), key("m", "entions")],
    data: same("Every 2 minutes"),
    bloomberg: [],
  },

  // Watch markets
  MOST: {
    summary: "Today's top gainers, losers, most active and trending tickers with price, change, volume against average and market cap. On Pro, pre-market and after-hours movers and the gaps at the open.",
    usage: ["MOST"],
    keys: [TABS, OPEN],
    data: { free: DELAYED, pro: "Real-time, pre-market and after-hours" },
    bloomberg: ["MOST"],
  },
  WEI: {
    summary: "Major indices grouped by region with last, change and session status: which markets are open and how they closed.",
    usage: ["WEI"],
    keys: [OPEN],
    data: same(DELAYED),
    bloomberg: ["WEI"],
  },
  BI: {
    summary: "S&P 500 sectors and industries sorted by the day's move, with their representative ETFs, and curated thematic baskets on the Themes tab.",
    usage: ["BI"],
    keys: [TABS, OPEN],
    data: QUOTES,
    bloomberg: ["IMAP"],
  },
  MEMB: {
    summary: "ETF holdings with weights, shares, member returns, daily contributions and index changes. SPX and SPY use IVV holdings.",
    usage: ["MEMB", "MEMB SPY", "MEMB IWM"],
    keys: [TABS, OPEN, MEMBERS_MENU],
    data: same("Dated fund holdings and partial delayed member returns. Nasdaq-100 is not covered."),
    bloomberg: ["MEMB", "MRR", "IMOV"],
  },
  THEM: {
    summary: "Curated thematic baskets with equal-weight returns and breadth. Open a theme to see its members, leaders and laggards. The Themes tab of BI.",
    usage: ["THEM", "THEM nuclear"],
    keys: [TABS, OPEN, key("Esc", "back"), MEMBERS_MENU],
    data: same("Updated every 15 minutes"),
    bloomberg: ["IMAP", "custom baskets"],
  },
  RRG: {
    summary: "Each name's strength against SPY or another benchmark, plotted against its momentum with weekly trails through the four quadrants. Sector ETFs by default, or your tickers.",
    usage: ["RRG", "RRG NVDA, AAPL, MSFT"],
    keys: [OPEN],
    data: same("Weekly, from daily closes"),
    bloomberg: ["RRG"],
  },
  HM: {
    summary: "The largest US stocks and ETFs as a treemap sized by the square root of market cap or assets, or by plain market cap in its settings, and colored by the day's move.",
    usage: ["HM"],
    keys: [OPEN],
    data: QUOTES,
    bloomberg: ["IMAP"],
  },
  FXC: {
    summary: "A cross-rate matrix for the major currencies, or for any of 45 chosen in its settings or with --currencies from the command line (gloomberb fn FXC --currencies USD,ZAR,NGN).",
    usage: ["FXC"],
    keys: [],
    data: FX,
    bloomberg: ["FXC"],
  },
  PERP: {
    summary: "Perpetual funding, open interest and premiums across venues, for crypto and stock, index, commodity and FX contracts: a board, rankings, one asset across venues, and a market's History and Evidence.",
    usage: ["PERP", "PERP BTC", "PERP TSLA"],
    keys: [TABS, OPEN, SEARCH, key("e", "vidence"), key("a", "lert")],
    data: { free: "A fixed preview and any one market's latest values", pro: "Every market, full rankings and stored history; source timestamps retained" },
    access: "preview",
    bloomberg: [],
  },
  CRYP: {
    summary: "The top coins by market cap, stablecoins on their own tab, with returns from a day to a year, a 30-day sparkline, volume and market cap.",
    usage: ["CRYP"],
    keys: [TABS, OPEN],
    data: same("Real-time where it streams, others every 15 seconds"),
    bloomberg: [],
  },
  FUT: {
    summary: "Front-month futures across equity index, rates, energy, metals, agriculture, livestock and FX with last price and session change, grouped by sector.",
    usage: ["FUT"],
    keys: [SEARCH, OPEN],
    data: same(DELAYED),
    bloomberg: ["GLCO"],
  },
  CTM: {
    summary: "A futures root's listed contracts as a curve against a week and a month ago, with roll yield, contango or backwardation, and each contract's price, open interest and volume. Takes a FUT root, VX or a CME crypto root (BTC, ETH, SOL, XRP), which also shows each contract's premium to spot and annualised basis against the USD pair quote.",
    usage: ["CTM GC", "CTM BTC"],
    keys: [key("d", "ate"), key("c", "urrent"), STEP],
    data: same("Delayed, usually 10 minutes; VIX at settlement"),
    bloomberg: ["CTM", "CT"],
  },
  FNG: {
    summary: "The CNN Fear & Greed index with its history and each of the seven component indicators.",
    usage: ["FNG"],
    keys: [],
    data: same("Through the day, as CNN updates it"),
    bloomberg: [],
  },
  COT: {
    summary: "CFTC Commitments of Traders: net positioning by trader class, the weekly change, and one- and three-year percentiles. Pass a root like CL or BTC (also ETH, MBT, MET, SOL, XRP) for one market, charted under its front-month price where there is one.",
    usage: ["COT", "COT CL", "COT BTC"],
    keys: [key("c", "lass"), key("s", "cope"), SEARCH],
    data: same("Weekly: Tuesday positions, out on Friday"),
    bloomberg: ["COT"],
  },
  DOE: {
    summary: "The EIA's weekly petroleum and natural gas storage numbers: crude, Cushing and the SPR, gasoline, distillates, jet fuel and propane, refinery runs, trade and demand, and gas storage by region. Each row shows the week's build or draw, the change on a year ago and where it sits in its five-year range; the selected one is charted over the year against the five-year band with a plain read of the numbers.",
    usage: ["DOE", "NGS"],
    keys: [],
    data: same("Weekly, on release"),
    bloomberg: ["DOE"],
  },
  POWER: {
    summary: "Pro: global power interconnection queues, recorded MW history, completion and withdrawal cohorts, large-load requests and approvals, utility exposure and generation capacity. Open a project for primary evidence and revisions; mapped companies link to DES, FA, G and SPLC.",
    usage: ["POWER", "POWER NEE"],
    keys: [SEARCH, key("o", "pen source"), key("d", "es"), key("f", "a"), key("g", "raph"), key("s", "plc"), key("c", "ompute"), key("t", "BO")],
    data: { free: "Three rows per section; limited history", pro: "Snapshots as public registers update; coverage by region" },
    access: "preview",
    bloomberg: [],
  },
  GPU: {
    summary: "Pro GPU rental list prices, provider-declared spot rates and marketplace asks in USD per GPU-hour. Compare clouds and hardware variants, inspect observations, anonymised third-party reference indices and dated price changes, and open related equities or TheBuildout.",
    usage: ["GPU", "GPU H100", "GPU B200"],
    keys: [key("t", "BO")],
    data: same("Hourly asks and AWS spot; other published prices every 6 or 24 hours"),
    access: "preview",
    bloomberg: [],
  },
  NGS: {
    summary: "Lower 48 working gas in storage and each region's, the week's injection or withdrawal against a year ago and the five-year average, charted over the year. The Gas Storage tab of DOE.",
    usage: ["NGS"],
    keys: [],
    data: same("Weekly, on release"),
    bloomberg: [],
    docs: "DOE",
  },
  VIX: {
    summary: "Daily VIX tenor closes, the term structure and whether it is in contango or inverted, with the cross-asset volatility board beside it.",
    usage: ["VIX"],
    keys: [key("v", "iew"), STEP],
    data: DAILY_CLOSES,
    bloomberg: [],
  },
  VOLS: {
    summary: "Volatility indices across assets on one board: the VIX term, VVIX, SKEW, MOVE, and index, commodity and emerging-market vol, each with its one-year percentile.",
    usage: ["VOLS"],
    keys: [key("v", "iew"), STEP],
    data: DAILY_CLOSES,
    bloomberg: ["VOLS"],
  },
  HILO: {
    summary: "A live count of US stocks printing new session highs and lows over 30-second, one-minute and five-minute windows.",
    usage: ["HILO"],
    keys: [OPEN],
    data: US_SCANNER,
    bloomberg: [],
  },
  FLOW: {
    summary: "Sweeps, blocks and large premium prints as they hit the tape, with ticker, strike, expiry and premium.",
    usage: ["FLOW"],
    keys: [OPEN],
    data: pro(REAL_TIME),
    access: "pro",
    bloomberg: ["FLOW"],
  },
  HALT: {
    summary: "Current and recent US trading halts with the reason code and resumption times.",
    usage: ["HALT"],
    keys: [key("f", "ilter")],
    data: same("As posted, reread every refresh interval (30 minutes by default)"),
    bloomberg: [],
  },
  IPO: {
    summary: "Upcoming and recently listed IPOs in the US, Asia-Pacific and Europe, with offer price in local currency, deal size in dollars and first-day return.",
    usage: ["IPO", "IPO Klarna"],
    keys: [TABS, SEARCH],
    data: same("Daily"),
    bloomberg: ["IPO"],
  },
  MAP: {
    summary: "Trading venues around the world with open or closed status, local time and time to the next session change. Layers add ships, chokepoints, ports, pipelines, fields, LNG terminals and airports to the same map, each with a table of what is in view and the companies it links to.",
    usage: ["MAP", "MAP ships", "MAP energy", "MAP air", "MAP ports"],
    keys: [SEARCH, OPEN, key("d", "es"), key("+", " zoom in")],
    data: same("Venues live from exchange calendars; ships live, chokepoints and ports daily, the rest reference data"),
    bloomberg: [],
  },
  CHOKE: {
    summary: "Daily vessel transits through the main shipping chokepoints charted together, or one of them by name, as series you can mix with anything else in G.",
    usage: ["CHOKE", "CHOKE SUEZ"],
    keys: CHART_KEYS,
    data: same("Daily"),
    bloomberg: [],
  },

  // Macro and rates
  ECO: {
    summary: "Upcoming releases and central bank events with impact, country, actual, forecast and prior.",
    usage: ["ECO"],
    keys: [key("f", " impact"), key("c", " region"), OPEN],
    data: ON_RELEASE,
    bloomberg: ["ECO", "WECO"],
  },
  ECST: {
    summary: "Inflation, labour, growth, housing and rates indicators with the latest print, the prior, and a chart against their own history.",
    usage: ["ECST", "ECST cpi-yoy"],
    keys: [SEARCH],
    data: ON_RELEASE,
    bloomberg: ["ECST"],
  },
  CPI: {
    summary: "The US consumer price index by component: food, energy, core goods, shelter and services ex shelter, each with its weight, the month's change, three- and six-month annualised rates, the change on a year ago and its contribution in points to the headline. The selected row is charted month by month against the headline with a plain read of the numbers; the header gives the next release.",
    usage: ["CPI", "CPI shelter", "ECAN"],
    keys: [],
    data: same("Monthly, on release"),
    bloomberg: ["ECAN"],
  },
  CBR: {
    summary: "Policy rates for the G20 central banks with the last move, its date and a one-year percentile; open one for its history.",
    usage: ["CBR"],
    keys: [OPEN, OPEN_SOURCE],
    data: same("As each bank publishes, can lag a few days"),
    bloomberg: ["CENB", "CBRT"],
  },
  GC: {
    summary: "The US Treasury curve with the table of maturities, for today or any past date, against a week and a month ago.",
    usage: ["GC", "GC 2025-06-30"],
    keys: [key("d", "ate"), key("c", "urrent"), STEP],
    data: same("Daily close, published the next day"),
    bloomberg: ["GC"],
  },
  WIRP: {
    summary: "The fed funds rate priced for each upcoming FOMC meeting from futures, against a week and a month ago and the Fed's projections, with per-meeting probabilities.",
    usage: ["WIRP"],
    keys: [TABS, STEP],
    data: same("Futures delayed, usually 10 minutes"),
    bloomberg: ["WIRP", "FFIP"],
  },
  CRD: {
    summary: "ICE BofA US corporate option-adjusted spreads by rating bucket and high yield, with the day's change.",
    usage: ["CRD"],
    keys: [OPEN],
    data: same("Daily close, published the next day"),
    bloomberg: ["CRD"],
  },
  AUCT: {
    summary: "Bill, note, bond and TIPS auction results: high rate, bid-to-cover, indirect share and size, with the auctions announced next.",
    usage: ["AUCT", "AUCT 10-year"],
    keys: [SEARCH, key("f", "ilter"), OPEN],
    data: same("Daily, after each auction"),
    bloomberg: ["AUCT"],
  },
  BTMM: {
    summary: "Funding rates (SOFR, EFFR, IORB), Treasury bill yields and their curve, and Fed liquidity from reserves to the reverse repo, each with its one-year percentile.",
    usage: ["BTMM"],
    keys: [TABS, OPEN, STEP],
    data: same("Daily as published, the Fed's balance sheet weekly"),
    bloomberg: ["BTMM"],
  },
  CDS: {
    summary: "Single-name corporate CDS trades and 5Y spread history from DTCC public dissemination, by issuer with trade count and spread.",
    usage: ["CDS", "CDS F"],
    keys: [OPEN, STEP],
    data: same("Delayed, as trades are disseminated"),
    bloomberg: ["CDS"],
  },
  CDX: {
    summary: "CDX IG, HY and EM with iTraxx Main and Crossover on the run: the 5Y level, 1D and 1W moves, 1Y percentile and the day's print count. IG and iTraxx in spread, HY and EM in price. Sovereign CDS is the other tab.",
    usage: ["CDX"],
    keys: [TABS, OPEN],
    data: same("Delayed, as trades are disseminated"),
    bloomberg: ["CDX"],
  },
  SOVR: {
    summary: "The CDS pane on Sovereign: 5Y CDS ranked by the month's move, beside the local currency's move against the dollar, with each country's year of history.",
    usage: ["SOVR"],
    keys: [TABS, OPEN],
    data: same("Delayed, as trades are disseminated"),
    bloomberg: ["SOVR", "WCDS"],
  },
  YAS: {
    summary: "Price a fixed-coupon bond from a yield, or solve the yield from a price: accrued interest, duration, convexity, DV01, spread to Treasuries and cash flows.",
    usage: ["YAS"],
    keys: [key("e", "dit"), key("m", "ode"), key("f", "requency"), key("d", "ay count")],
    data: same("Treasury curve at the daily close"),
    bloomberg: ["YAS"],
  },
  VAL: {
    summary: "Whole-market valuation ratios against their own history, with zones and trend deviation.",
    usage: ["VAL", "VAL buffett"],
    keys: [SEARCH],
    data: same("Monthly or quarterly, as each series publishes"),
    bloomberg: [],
  },

  // Ownership and filings
  SEC: {
    summary: "Recent SEC filings for a ticker with form type and date; open any of them inline. US equities.",
    usage: ["SEC AAPL"],
    keys: [OPEN, OPEN_SOURCE],
    data: AS_FILED,
    bloomberg: ["CF"],
  },
  ETF: {
    summary: "A US-listed fund's SEC filings: registration statements and prospectus updates, shareholder reports, N-CEN and N-PORT reports. Open any of them inline.",
    usage: ["ETF SPY"],
    keys: [OPEN, OPEN_SOURCE],
    data: AS_FILED,
    bloomberg: [],
  },
  TRIAL: {
    summary: "Clinical studies by condition, drug, or sponsor, with status, phase, and enrollment. Open the study record.",
    usage: ["TRIAL", "TRIAL semaglutide"],
    keys: [SEARCH, OPEN],
    data: same("As studies are posted"),
    bloomberg: [],
  },
  CLTR: {
    summary: "SEC staff comment letters and company responses, newest first. Search their text, or type a ticker for one company's letters, and open a letter to read it.",
    usage: ["CLTR", "CLTR revenue recognition", "CLTR AAPL"],
    keys: [SEARCH, OPEN],
    data: AS_FILED,
    bloomberg: [],
  },
  FDA: {
    summary: "FDA drug and device adverse event reports and drug recalls, by drug, device or firm name. A report is what someone observed, not proof the product caused it.",
    usage: ["FDA", "FDA metformin", "FDA insulin pump"],
    keys: [SEARCH, OPEN],
    data: same("As FDA updates each dataset; drug reports quarterly"),
    bloomberg: [],
  },
  HDS: {
    summary: "Institutional holders as a table (value, shares, change, percent held) or as an ownership treemap, and the 13D/G tab: 13D and 13G beneficial owners over 5%, activists and passive stakes, with percent of class, its change and each filer's 13F move.",
    usage: ["HDS NVDA", "HDS CAR"],
    keys: [TABS, OPEN, key("o", "pen 13F or filing")],
    data: same("13F quarterly as filed; 13D and 13G as filed"),
    bloomberg: ["HDS"],
  },
  "13F": {
    summary: "Institutional 13F filings by fund, ticker or CIK with estimated long-book performance, holdings and filing history. Option values are underlying notional.",
    usage: ["13F", "13F Berkshire"],
    keys: [SEARCH, OPEN, key("f", "iling")],
    data: same("Quarterly, as filed"),
    bloomberg: ["13F"],
  },
  INS: {
    summary: "Insider buys, sells, awards and gifts from Form 4 filings, with insider name, size and price. US equities.",
    usage: ["INS NVDA"],
    keys: [OPEN, key("f", "ilter")],
    data: AS_FILED,
    bloomberg: ["INS"],
  },
  CG: {
    summary: "Newly disclosed House and Senate periodic transaction reports: member, ticker, side, amount band and filing lag. Returns are hindsight price moves.",
    usage: ["CG", "CG NVDA"],
    keys: [key("f", "ilters"), key("m", "ember"), key("t", "icker"), OPEN],
    data: same("As disclosed, up to 45 days after the trade"),
    bloomberg: [],
  },

  // Run a workspace
  PF: {
    summary: "Your portfolio or watchlist with live quotes, market value, P&L, weights of the total with cash, and sparklines. With target weights set, each holding adds its target, drift and the trade that rebalances it; broker-synced and manual positions sit in the same table.",
    usage: ["PF"],
    keys: [key("a", "dd"), OPEN, key("s", " grid")],
    data: QUOTES,
    bloomberg: [],
  },
  PORT: {
    summary: "Benchmark-relative risk, factor betas, and index, rate and VIX stress shifts for a portfolio. The Overview view in pane settings has P&L, Sharpe, beta and sector allocation.",
    usage: ["PORT"],
    keys: [TABS, key("p", "ortfolio"), key("i", "mport evidence")],
    data: { free: "Daily closes; live values 15 minutes delayed", pro: "Daily closes; live values real-time" },
    bloomberg: ["PORT"],
  },
  MARS: {
    summary: "Market risk for a portfolio: benchmark-relative risk, factor betas and stress shifts. The Risk view of PORT.",
    usage: ["MARS"],
    keys: [TABS, key("p", "ortfolio"), key("i", "mport evidence")],
    data: { free: "Daily closes; live values 15 minutes delayed", pro: "Daily closes; live values real-time" },
    bloomberg: ["MARS"],
    docs: "PORT",
  },
  ALRT: {
    summary: "Your price alerts with current price, distance to target and trigger state, plus market and filing event alerts.",
    usage: ["ALRT"],
    keys: [key("a", "dd alert"), key("e", "dit"), key("d", "elete"), key("m", "re-arm")],
    data: QUOTES,
    bloomberg: ["ALRT"],
  },
  SA: {
    summary: "Creates an alert from a symbol, a condition (above, below, crosses, or >, <, x) and a target price.",
    usage: ["SA NVDA above 240"],
    keys: [],
    data: null,
    bloomberg: ["ALRT"],
  },
  AW: {
    summary: "Adds a ticker to the active watchlist.",
    usage: ["AW NVDA"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  AP: {
    summary: "Adds a ticker to a manual portfolio, with optional shares, average cost and currency. Set Portfolio Position changes it later.",
    usage: ["AP NVDA"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  RW: {
    summary: "Removes a ticker from the active watchlist.",
    usage: ["RW NVDA"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  RP: {
    summary: "Removes a ticker and its positions from the active portfolio.",
    usage: ["RP NVDA"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  NOTE: {
    summary: "A general-purpose notes pane. Ticker notes live in the research pane; this one is for anything else.",
    usage: ["NOTE"],
    keys: [key("n", "ew"), key("t", "itle"), key("d", "elete")],
    data: null,
    bloomberg: [],
  },
  THESIS: {
    summary: "Your theses and your teams', those needing a ruling first: kill conditions, catalysts, and conviction against position size. THESIS NVDA opens or starts one.",
    usage: ["THESIS", "THESIS NVDA"],
    keys: [SEARCH, key("n", "ew"), key("Enter", " start thesis")],
    data: null,
    bloomberg: [],
  },
  VIEW: {
    summary: "A table built from any data function, like MOST or RV, with your own columns, filters and sort. Ask Gloom writes the spec or you paste the JSON.",
    usage: ["VIEW", "VIEW <spec JSON>"],
    keys: [OPEN, key("t", "eam publish")],
    data: same("As fresh as the function it reads"),
    bloomberg: ["BQL"],
  },

  // Cloud and brokers
  CHAT: {
    summary: "Channels for equities, options, macro, crypto and more, with replies and mentions. Opens the preferred channel or a named one.",
    usage: ["CHAT", "CHAT macro"],
    keys: [key("i", " compose"), key("Enter", "reply"), key("n", "ew channel")],
    data: null,
    bloomberg: ["IB"],
  },
  DM: {
    summary: "Opens an existing direct message or starts a direct or group conversation by username.",
    usage: ["DM @user"],
    keys: [],
    data: null,
    bloomberg: ["MSG"],
  },
  TEAM: {
    summary: "Members, invites, channels and settings for your teams, which share layouts, lists, notes, theses, views and chat. TEAM new creates one; TEAM invite @user adds people.",
    usage: ["TEAM", "TEAM new", "TEAM invite @user"],
    keys: [key("n", "ew team"), key("i", "nvite"), key("c", "hat")],
    data: null,
    bloomberg: [],
  },
  FOCUS: {
    summary: "Narrows the workspace to one team, personal only, or everything: other tabs fold away and new notes and lists default to the focus.",
    usage: ["FOCUS personal", "FOCUS all"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  TBO: {
    summary: "Data center and semiconductor supply chain intelligence: company lists, sites and intel, with limited free data and full access with a TheBuildout subscription.",
    usage: ["TBO"],
    keys: [TABS, OPEN, key("s", "tar")],
    data: same("Intel 72 hours delayed without a TheBuildout plan"),
    bloomberg: [],
  },
  ACM: {
    summary: "Profile, emails, Pro plan, teams and password settings for your Gloom Cloud account.",
    usage: ["ACM"],
    keys: [TABS, key("Ctrl+S", "save")],
    data: null,
    bloomberg: [],
  },
  UPGRADE: {
    summary: "Opens Pro checkout, or the billing portal during a trial; signs you up first when signed out.",
    usage: ["UPGRADE"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  MCP: {
    summary: "Connects Claude Code, Codex, Cursor or any MCP client to Gloom's research tools: the command to copy, or a key to create.",
    usage: ["MCP"],
    keys: [key("c", "opy"), key("←/→", " client"), key("k", "ey")],
    data: null,
    bloomberg: [],
    docs: "https://gloom.sh/docs/mcp",
  },
  BR: {
    summary: "Broker profiles, account sync and connection status. Every broker is a plugin you install first.",
    usage: ["BR"],
    keys: [key("a", "dd"), key("c", "onnect"), key("s", "ync"), key("e", "dit")],
    data: null,
    bloomberg: [],
  },

  // Layouts and settings
  GL: {
    summary: "Arranges every open window into one tiled layout.",
    usage: ["GL"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  LAY: {
    summary: "Browse saved and published layouts, switch between them, or add one to your workspace.",
    usage: ["LAY"],
    keys: [key("o", "pen"), key("a", "dd layout"), key("n", "ew"), SEARCH],
    data: null,
    bloomberg: ["BLP"],
  },
  DESK: {
    summary: "Adds a ready-made desk as a new layout tab: equities, options, futures and commodities, rates and credit, FX and macro, or active trading.",
    usage: ["DESK", "DESK options"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  LMA: {
    summary: "Float, dock, swap, remove and save panes and layouts.",
    usage: ["LMA", "LMA float"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  WIN: {
    summary: "Moves or resizes the focused window from the keyboard, for terminals where the mouse is not an option.",
    usage: ["WIN move", "WIN resize"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  PS: {
    summary: "Opens the settings form for whatever pane is focused.",
    usage: ["PS"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  PL: {
    summary: "What Gloomberb is made of: switch built-ins on and off, one by one or with a starter pack, and install plugins from GitHub.",
    usage: ["PL"],
    keys: [key("e", "nable"), key("a", " packs"), key("i", "nstall"), SEARCH],
    data: null,
    bloomberg: [],
  },
  TH: {
    summary: "Switches between the bundled themes, light and dark, with a live preview.",
    usage: ["TH", "TH amber"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  LANG: {
    summary: "Switches the interface language.",
    usage: ["LANG ja", "LANG auto"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  "FONT+": {
    summary: "Increases the app-wide font size. FONT- decreases it.",
    usage: ["FONT+"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  "FONT-": {
    summary: "Decreases the app-wide font size. FONT+ increases it.",
    usage: ["FONT-"],
    keys: [],
    data: null,
    bloomberg: [],
    docs: "FONT+",
  },
  SB: {
    summary: "Shows or hides the keyboard shortcuts bar at the bottom.",
    usage: ["SB"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  VF: {
    summary: "Turns the flash on quote updates on or off.",
    usage: ["VF"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  CR: {
    summary: "Cycles terminal chart rendering between Auto, Kitty graphics and Braille.",
    usage: ["CR"],
    keys: [],
    data: null,
    bloomberg: [],
  },
  CONN: {
    summary: "Live request and socket health for every connection the app keeps.",
    usage: ["CONN"],
    keys: [key("s", "ort"), OPEN],
    data: null,
    bloomberg: [],
  },
  CHG: {
    summary: "Version history and release notes inside the app.",
    usage: ["CHG"],
    keys: [OPEN],
    data: null,
    bloomberg: [],
  },
  HELP: {
    summary: "Help and the function reference. HELP with a function opens its card, F1 opens the focused pane's, and HELP HELP reaches support.",
    usage: ["HELP", "HELP OMON", "HELP HELP"],
    keys: [TABS, key("s", "end feedback")],
    data: null,
    bloomberg: ["HELP"],
  },
  FB: {
    summary: "A message and an optional screenshot, sent with scrubbed logs and app details; works signed out. FEEDBACK and BUG open it too.",
    usage: ["FB"],
    keys: [],
    data: null,
    bloomberg: [],
  },
};
