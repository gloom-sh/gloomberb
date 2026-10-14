import { cliStyles, cliTerminalWidth, renderDefinitions, renderSection, wrapText } from "../utils/cli-output";

/**
 * Plain-words meanings of the rates, auction, energy, perpetual-futures, portfolio,
 * fund, short interest, quote-board, futures and economic-calendar terms the functions
 * show in their rows, headers and footers.
 * `catalog glossary` lists them, `catalog explain <term>` prints one, and
 * `fn <function> --explain` and `portfolio show --explain` follow a report with
 * the ones it shows. Only terms a pane or report actually prints belong here.
 */
export interface GlossaryEntry {
  term: string;
  /** The abbreviation a table heads the column with, printed beside the term: `B/C`. */
  short?: string;
  /** Other names a reader may look it up by: `stop-out` for the high yield. */
  aliases: readonly string[];
  /** The functions that show it, by the token `fn` takes. */
  functions: readonly string[];
  /**
   * The labels a report prints when it shows the term, matched whole and
   * case-sensitively by `--explain`; the term and its abbreviation by default.
   * A row type can stand for it: an AUCT Note row's rate is a high yield.
   */
  shown?: readonly string[];
  /** One or two plain sentences. */
  definition: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  // Treasury auctions (AUCT).
  {
    term: "Bid-to-cover", short: "B/C", aliases: ["btc", "cover ratio"], functions: ["AUCT"],
    definition: "Dollars bid for every dollar of securities the Treasury sold. A higher ratio means more demand.",
  },
  {
    term: "Indirect", aliases: ["indirect bidders", "indirect bid", "indirect share"], functions: ["AUCT"],
    definition: "The share of the competitive award won by indirect bidders, who bid through a dealer or broker. "
      + "They include foreign central banks, so a high share reads as strong outside demand.",
  },
  {
    term: "Direct", aliases: ["direct bidders", "direct bid", "direct share"], functions: ["AUCT"],
    definition: "The share of the competitive award won by direct bidders, who bid for their own account straight to the Treasury.",
  },
  {
    term: "Dealer", aliases: ["primary dealer", "primary dealers", "dealers", "dealer share", "dealer takedown", "takedown"],
    functions: ["AUCT"], shown: ["Dealer", "Primary dealer"],
    definition: "The share of the competitive award left to the primary dealers, the banks that must bid at every auction. "
      + "Indirect, direct and dealer add up to 100%, so a high dealer share reads as weak demand.",
  },
  {
    term: "Competitive", aliases: ["competitive bids", "noncompetitive"], functions: ["AUCT"],
    definition: "Bids that name the yield the bidder will accept; they set the auction result. Noncompetitive bids take whatever that result is.",
  },
  {
    term: "High yield", aliases: ["stop-out", "stop-out yield", "stop-out rate", "high rate"], functions: ["AUCT"],
    shown: ["High yield", "Note", "Bond", "TIPS"],
    definition: "The highest yield the Treasury accepted at a note, bond or TIPS auction, also called the stop-out yield. "
      + "Every winning bid is filled at it; for TIPS it is a real yield.",
  },
  {
    term: "Stop-out vs average", aliases: ["stop-out vs avg", "vs avg", "stop-out vs median"], functions: ["AUCT"],
    shown: ["Stop-out vs avg", "Stop-out vs average"],
    definition: "The high (stop-out) yield minus the auction's average/median yield, in basis points; bills compare discount rates. "
      + "A wider gap means the last accepted bids cleared well above where most of the auction priced.",
  },
  {
    term: "Tail", aliases: ["tailed", "tailing", "auction tail"], functions: ["AUCT"], shown: ["tail"],
    definition: "How far an auction's high yield cleared above the when-issued yield at the 1 pm bid deadline; a tail reads as weak demand. "
      + "AUCT cannot show one, as its source has no when-issued yields, so it shows stop-out vs average instead.",
  },
  {
    term: "When-issued", short: "WI", aliases: ["when issued", "wi yield", "when-issued yield"], functions: ["AUCT"],
    shown: ["when-issued", "When-issued"],
    definition: "Trading in a Treasury security between its announcement and its issue. The when-issued yield at the auction deadline is what a tail is measured against.",
  },
  {
    term: "Investment rate", aliases: ["bill rate", "coupon equivalent", "bond-equivalent yield"], functions: ["AUCT"],
    shown: ["Investment rate", "Bill", "CMB"],
    definition: "A bill's yield at the highest accepted (stop-out) rate, restated as a bond-equivalent yield so it compares with "
      + "note yields. It reads higher than the bill's discount rate.",
  },
  {
    term: "High discount margin", aliases: ["discount margin", "frn margin"], functions: ["AUCT"],
    shown: ["High discount margin", "FRN"],
    definition: "For a floating rate note, the highest spread over the 13-week bill rate the Treasury accepted, in basis points.",
  },
  {
    term: "Median yield", aliases: ["avg/median yield", "average/median yield", "average yield"], functions: ["AUCT"],
    definition: "Half the accepted competitive bids were at or below this yield. Close to the high yield means the bids were tightly bunched.",
  },
  {
    term: "Term", aliases: ["reopening", "reopened", "security term"], functions: ["AUCT"],
    definition: "How long the security runs from issue to maturity. A reopening sells more of an older issue, so its term "
      + "reads short of a round number: 29-Year 10-Month is a reopened 30-year bond.",
  },
  {
    term: "CUSIP", aliases: ["cusip number"], functions: ["AUCT"],
    definition: "The nine-character code that identifies a US security. A reopening repeats the original issue's CUSIP.",
  },
  {
    term: "Bill", aliases: ["t-bill", "treasury bill", "bills"], functions: ["AUCT", "BTMM"], shown: ["Bill", "bill"],
    definition: "Treasury debt of a year or less, sold below face value with no coupon; the climb back to face value is the interest.",
  },
  {
    term: "Note", aliases: ["treasury note", "notes"], functions: ["AUCT"],
    definition: "Treasury debt that runs 2 to 10 years and pays a fixed coupon every six months.",
  },
  {
    term: "Bond", aliases: ["treasury bond", "bonds", "long bond"], functions: ["AUCT"],
    definition: "Treasury debt that runs 20 or 30 years and pays a fixed coupon every six months.",
  },
  {
    term: "TIPS", aliases: ["treasury inflation-protected securities", "inflation-protected", "linkers"], functions: ["AUCT", "GC"],
    definition: "Treasury Inflation-Protected Securities. Their principal follows US consumer prices, so their yield is a real yield, after inflation.",
  },
  {
    term: "FRN", aliases: ["floating rate note", "floater"], functions: ["AUCT"],
    definition: "A two-year Treasury floating rate note: it pays the 13-week bill rate, reset every week, plus a spread fixed when it is first sold.",
  },
  {
    term: "CMB", aliases: ["cash management bill"], functions: ["AUCT"],
    definition: "Cash management bill: an off-schedule bill the Treasury sells to cover a short-term cash need.",
  },
  // Yield curves (GC).
  {
    term: "Basis point", short: "bp", aliases: ["bps", "basis points"], functions: ["GC", "AUCT", "BTMM", "WIRP"],
    definition: "One hundredth of a percentage point. A yield going from 4.00% to 4.25% has risen 25bp.",
  },
  {
    term: "2s10s", aliases: ["2s10s spread", "twos tens", "curve slope", "inversion", "inverted curve"], functions: ["GC"],
    definition: "The 10-year yield minus the 2-year yield, in basis points. Below zero the curve is inverted: short-term debt pays more than long-term.",
  },
  {
    term: "UST", aliases: ["treasury curve", "us treasury curve", "par yield", "par curve"], functions: ["GC"],
    definition: "The US Treasury par yield curve: for each maturity, the coupon a Treasury priced at face value would pay.",
  },
  {
    term: "Real yield", aliases: ["tips real", "real rate"], functions: ["GC"], shown: ["Real yield", "TIPS real"],
    definition: "A yield after inflation, read from TIPS prices.",
  },
  {
    term: "Breakeven", aliases: ["breakeven inflation", "breakevens", "bei"], functions: ["GC"],
    definition: "The nominal Treasury yield minus the TIPS real yield at the same maturity: the inflation rate at which both pay the same. "
      + "It carries risk and liquidity premia, so it is not a forecast.",
  },
  {
    term: "1Y fwd", aliases: ["forward curve", "forward rate", "one-year forward", "forward"], functions: ["GC"],
    definition: "The curve today's yields price for one year from now. It includes term premia, so it is not a forecast.",
  },
  {
    term: "Zero-coupon yield", aliases: ["zero curve", "spot rate", "spot curve"], functions: ["GC"],
    definition: "The yield of a single payment at that maturity, with no coupons in between. The Gilt curve is a zero-coupon curve.",
  },
  {
    term: "Euro AAA", aliases: ["euro area curve", "aaa curve", "ecb curve"], functions: ["GC"],
    definition: "The ECB's euro area yield curve, built from the bonds of AAA-rated euro area governments.",
  },
  {
    term: "Bund", aliases: ["bunds", "german bund", "german government bond"], functions: ["GC"],
    definition: "A German federal government bond, the benchmark for euro area rates.",
  },
  {
    term: "Gilt", aliases: ["gilts", "uk gilt"], functions: ["GC"],
    definition: "A UK government bond.",
  },
  {
    term: "JGB", aliases: ["jgbs", "japanese government bond"], functions: ["GC"],
    definition: "A Japanese government bond.",
  },
  // Money markets (BTMM).
  {
    term: "SOFR", aliases: ["secured overnight financing rate", "repo rate"], functions: ["BTMM", "WIRP"],
    definition: "Secured Overnight Financing Rate: the cost of borrowing cash overnight against Treasuries (repo). The main US dollar benchmark rate.",
  },
  {
    term: "EFFR", aliases: ["effective fed funds rate", "effective federal funds rate", "fed funds rate", "fed funds"], functions: ["BTMM", "WIRP"],
    shown: ["EFFR", "effr"],
    definition: "Effective federal funds rate: the typical rate banks pay each other for unsecured overnight loans. The Fed steers it inside its target range.",
  },
  {
    term: "IORB", aliases: ["interest on reserve balances", "interest on reserves"], functions: ["BTMM"],
    definition: "Interest on reserve balances: the rate the Fed pays banks on money they keep at the Fed. It holds fed funds below the top of the target range.",
  },
  {
    term: "OBFR", aliases: ["overnight bank funding rate"], functions: ["BTMM"],
    definition: "Overnight bank funding rate: like EFFR, but also counting the overnight eurodollar borrowing of US banks.",
  },
  {
    term: "Overnight RRP", aliases: ["rrp", "on rrp", "reverse repo", "reverse repurchase"], functions: ["BTMM"],
    definition: "Cash that money funds and others lend the Fed overnight through its reverse repo facility. Falling usage means that cash went elsewhere, often into bills.",
  },
  {
    term: "Treasury account", aliases: ["tga", "treasury general account"], functions: ["BTMM"],
    definition: "The US government's cash account at the Fed. When it grows, money leaves bank reserves.",
  },
  {
    term: "Bank reserves", aliases: ["reserves", "reserve balances"], functions: ["BTMM"],
    definition: "Money banks hold in their accounts at the Fed, as a weekly average.",
  },
  {
    term: "Fed assets", aliases: ["fed balance sheet", "balance sheet", "walcl"], functions: ["BTMM"],
    definition: "Everything the Fed owns, mostly Treasuries and mortgage bonds bought to support the economy.",
  },
  {
    term: "Net liquidity", aliases: ["liquidity"], functions: ["BTMM"],
    definition: "Fed assets minus the Treasury account minus overnight RRP: a rough gauge of the dollars the Fed leaves in markets, not a forecast.",
  },
  // Central bank rates (CBR), in the order its columns run. Pctl 1Y sits between them, shared with BTMM and WIRP.
  {
    term: "Last move", aliases: ["latest move"], functions: ["CBR"],
    definition: "The latest change in the policy rate, in basis points: up for a hike, down for a cut. The US figure is the move in the midpoint of the target range.",
  },
  {
    term: "Change observed", aliases: ["last change", "change date"], functions: ["CBR"],
    definition: "The first date the new rate level appears in the data, not necessarily the announcement or effective date.",
  },
  {
    term: "Pctl 1Y", aliases: ["percentile", "1y percentile", "pctl"], functions: ["BTMM", "WIRP", "CBR"],
    definition: "Where today's value ranks against the past year of the same series: 100 is the highest, 0 the lowest.",
  },
  {
    term: "Status", aliases: ["stale"], functions: ["CBR"],
    definition: "Whether the latest observation is current. Stale means the source observation is delayed or comes from an expired cache, so the rate may have changed since its date; unavailable means the source has none.",
  },
  // US rate path (WIRP).
  {
    term: "FOMC", aliases: ["federal open market committee", "fed meeting", "fomc meeting"], functions: ["WIRP"],
    definition: "The Federal Open Market Committee, which sets the fed funds target range at eight scheduled meetings a year.",
  },
  {
    term: "Target midpoint", aliases: ["target range", "fed funds target", "midpoint"], functions: ["WIRP"],
    shown: ["Target midpoint", "targetLower", "targetUpper"],
    definition: "The middle of the Fed's fed funds target range, the policy rate a meeting decides.",
  },
  {
    term: "Implied rate", aliases: ["implied", "futures implied rate"], functions: ["WIRP"],
    definition: "100 minus a futures price: the rate the contract is priced to settle on. For fed funds futures that is the month's average EFFR.",
  },
  {
    term: "Moves", aliases: ["priced moves", "hikes", "cuts"], functions: ["WIRP"],
    definition: "How many 25bp rate moves are priced by that meeting, counted from today: +1.00 is one hike, -0.50 half a cut.",
  },
  {
    term: "P(move)", aliases: ["move probability", "probability", "odds"], functions: ["WIRP"],
    definition: "The odds of a 25bp move at that meeting alone, read from the step in the implied rate since the meeting before. Above 100% means more than one move is priced.",
  },
  {
    term: "Fed funds futures", short: "ZQ", aliases: ["fed funds contracts", "30-day fed funds"], functions: ["WIRP"],
    shown: ["Fed funds contracts"],
    definition: "CME futures that settle on a month's average EFFR. The meeting path is read from them.",
  },
  {
    term: "SOFR futures", short: "SR3", aliases: ["sofr contracts", "three-month sofr"], functions: ["WIRP"],
    shown: ["SOFR contracts"],
    definition: "CME three-month SOFR futures, settled on SOFR compounded over a quarter. They price rates further out but give no meeting odds.",
  },
  {
    term: "Following-month", aliases: ["following-month method"], functions: ["WIRP"],
    shown: ["following-month"],
    definition: "A meeting's rate read from the next month's fed funds contract, when that month holds no other meeting.",
  },
  {
    term: "Monthly-weighted", aliases: ["monthly-weighted method", "calendar weighting"], functions: ["WIRP"],
    shown: ["monthly-weighted"],
    definition: "A meeting's rate read from its own month's contract by weighting the days before and after it, when the next month holds another meeting.",
  },
  // Energy futures (FUT, CTM).
  {
    term: "TTF", aliases: ["title transfer facility", "dutch ttf", "dutch gas", "european gas", "eu gas"], functions: ["FUT", "CTM"],
    shown: ["TTF", "Dutch TTF Gas"],
    definition: "Title Transfer Facility, the Dutch gas hub whose price is Europe's gas benchmark. Its futures quote in euros per MWh.",
  },
  {
    term: "Henry Hub", aliases: ["henry hub gas", "us gas", "nymex natural gas"], functions: ["FUT", "CTM"],
    definition: "The Louisiana gas hub NYMEX natural gas (NG) delivers at, the US gas benchmark. It quotes in dollars per MMBtu.",
  },
  {
    term: "MWh", aliases: ["megawatt-hour", "megawatt hour", "eur/mwh", "mwh vs mmbtu"], functions: ["FUT", "CTM"],
    definition: "Megawatt-hour, the energy unit European gas and power are priced in. 1 MWh is about 3.412 MMBtu.",
  },
  {
    term: "MMBtu", aliases: ["million btu", "million british thermal units", "usd/mmbtu", "mmbtu vs mwh"], functions: ["FUT", "CTM"],
    definition: "Million British thermal units, the unit US gas is priced in. A TTF price in EUR/MWh divided by 3.412 is EUR/MMBtu, comparable to NG once in dollars.",
  },
  {
    term: "EUA", aliases: ["eu allowance", "eu allowances", "eu ets", "carbon allowance", "carbon allowances", "eu carbon"], functions: ["EPWR"],
    definition: "EU Allowance: the right to emit one tonne of CO2 under the EU Emissions Trading System, priced in euros per tonne.",
  },
  {
    term: "Front month", aliases: ["front-month", "front contract", "continuous contract", "front-month contract"], functions: ["FUT", "CTM"],
    definition: "The nearest contract still trading. FUT quotes each root's front month by its continuous symbol (TTF=F), which rolls to the next contract as one expires.",
  },
  // Perpetual futures (PERP).
  {
    term: "Perpetual", short: "perp", aliases: ["perps", "perpetual future", "perpetual futures", "perpetual swap", "perpetual contract", "perpetual market"],
    functions: ["PERP"],
    definition: "A futures contract with no expiry date, so a position can be held for as long as its margin lasts. "
      + "The funding rate keeps its price close to the asset it tracks.",
  },
  {
    term: "Funding rate", aliases: ["funding", "funding payment", "funding fee", "funding 8h"], functions: ["PERP"],
    shown: ["Funding %/int", "Funding 8h", "Paid %/int"],
    definition: "A regular payment between the two sides of a perpetual contract, set to pull its price toward the asset's. "
      + "Positive means longs pay shorts, negative means shorts pay longs.",
  },
  {
    term: "Open interest", short: "OI", aliases: ["open interest usd"], functions: ["PERP"],
    definition: "The total value of contracts that are open and not yet closed, counting each buyer and seller pair once, usually in dollars. "
      + "It rises as new positions open and falls as they close.",
  },
  {
    term: "Premium", aliases: ["mark premium"], functions: ["PERP"],
    definition: "How far a perpetual's price sits above or below the reference price it tracks, as a percent. "
      + "Positive means buyers are paying up for the contract; funding pulls it back toward zero.",
  },
  // Portfolio weights and rebalancing (PF, portfolio show).
  {
    term: "Weight", aliases: ["weights", "portfolio weight", "allocation weight"], functions: ["PF"],
    definition: "A holding's share of the portfolio's total value, cash included, in percent. A holding without a price is left out of the total.",
  },
  {
    term: "Target", aliases: ["target weight", "target weights", "targets", "target allocation"], functions: ["PF"],
    definition: "The weight you want a holding to have, set with portfolio target set. Targets need not add up to 100%; the report says what is unallocated.",
  },
  {
    term: "Drift", aliases: ["allocation drift", "weight drift", "overweight", "underweight"], functions: ["PF"],
    definition: "A holding's weight minus its target, in percentage points: +2.3pp is 2.3 points over its target, -2.3pp under it.",
  },
  {
    term: "Trade", aliases: ["trades", "trade value", "rebalance", "rebalancing", "rebalance trade"], functions: ["PF"],
    definition: "The units to buy (+) or sell (-) to bring a holding to its target at the current price; Trade Value is the same in money. "
      + "Making these trades is rebalancing; they leave out fees, taxes and lot sizes.",
  },
  {
    // Drift prints it after each figure (+2.3pp), never as a word of its own.
    term: "Percentage point", short: "pp", aliases: ["percentage points", "percent points", "ppt"], functions: ["PF"],
    shown: ["Drift"],
    definition: "The plain difference between two percentages. A 22% weight against a 20% target is 2pp over it, not 10%.",
  },
  // Financial statements and ratios (FA).
  {
    term: "EBITDA", aliases: ["earnings before interest taxes depreciation and amortization", "ebitda ttm"], functions: ["FA"],
    definition: "Earnings before interest, taxes, depreciation and amortization: operating income with depreciation and amortization "
      + "added back, a rough measure of the cash a business earns before paying for its capital and its debt.",
  },
  {
    term: "Net debt", aliases: ["net debt/ebitda", "net debt to ebitda", "net leverage"], functions: ["FA"], shown: ["Net Debt"],
    definition: "Total debt less cash and short-term investments. Negative means more cash than debt. "
      + "Net debt / EBITDA is how many years of EBITDA would repay it; FA divides by a year of EBITDA, the trailing four quarters in a quarterly column.",
  },
  {
    term: "TTM", aliases: ["trailing twelve months", "trailing 12 months", "trailing four quarters", "ltm", "last twelve months"],
    functions: ["FA"],
    definition: "Trailing twelve months: the four latest quarters added up, a year that ends with the latest quarter rather than the fiscal year. "
      + "FA's quarterly leverage and valuation ratios (P/E, EV / EBITDA, P/S, FCF yield) read their flows over it, and show < 4 quarters when fewer are on file.",
  },
  // Funds (ETF). Named in what ETF says it cannot show yet.
  {
    term: "NAV", aliases: ["net asset value", "nav per share", "net asset value per share"], functions: ["ETF"],
    definition: "Net asset value: what a fund's holdings are worth, less what it owes, per share, struck once a trading day. "
      + "An ETF's market price trades close to it.",
  },
  {
    term: "Premium/discount", aliases: ["etf premium", "etf discount", "fund premium", "premium to nav", "discount to nav", "nav premium"],
    functions: ["ETF"], shown: ["Premium/discount", "premium", "Premium", "discount", "Discount"],
    definition: "How far an ETF's market price sits above (a premium) or below (a discount) its NAV, as a percent. "
      + "It is usually a fraction of a percent, and widens when the fund's holdings are hard to trade or their market is shut.",
  },
  {
    term: "Tracking error", aliases: ["index tracking error"], functions: ["ETF"], shown: ["Tracking error", "tracking error"],
    definition: "How loosely a fund follows its index: how much the gap between the fund's return and the index's swings, usually over a year. "
      + "Fees, cash and holdings that differ from the index widen it.",
  },
  // Short interest (SI, SIW) and daily short volume (SIV).
  {
    term: "Short interest", short: "SI", aliases: ["shares short", "short position", "short positions", "short shares"],
    functions: ["SI", "SIW"], shown: ["Shares Short", "Short interest"],
    definition: "The number of shares sold short and not yet bought back, counted across US broker-dealers on each settlement date. "
      + "It is a position, not trading volume, and it is published seven business days after the date it counts.",
  },
  {
    term: "Settlement", aliases: ["settlement date", "settlement dates", "settled", "reporting settlement date"],
    functions: ["SI", "SIW"], shown: ["Date", "Settled", "settlement"],
    definition: "The date short positions are counted, twice a month: the 15th (the business day before when it is not one) and the month's last business day. "
      + "FINRA publishes each count seven business days later, and the report's source line gives that date and the next settlement's.",
  },
  {
    term: "Days to cover", aliases: ["short ratio", "short interest ratio", "days-to-cover", "dtc"], functions: ["SI", "SIW"],
    shown: ["Days to cover"],
    definition: "Shares short divided by the average daily volume FINRA reports with the settlement: how many days of normal trading it would take "
      + "the shorts to buy their shares back. The overview, fundamentals, SI, SIW and EQS all give FINRA's figure. "
      + "A higher number means a squeeze would take longer to unwind.",
  },
  {
    term: "Average daily volume", short: "ADV", aliases: ["avg daily vol", "avg daily volume", "average daily share volume", "avg volume"], functions: ["SI"],
    shown: ["Avg Daily Vol"],
    definition: "The shares traded per day on average, as FINRA reports it with each settlement. Days to cover divides shares short by it.",
  },
  {
    term: "Float", aliases: ["free float", "public float", "float shares", "floating stock", "% float", "percent of float"],
    functions: ["SI", "SIW"], shown: ["Float"],
    definition: "The shares open to public trading: those outstanding less shares held by insiders and strategic holders, never more than the shares outstanding. "
      + "% Float is shares short over today's float, so a settlement is measured against the float as it is now, not as it was then; "
      + "SI gives it for the latest settlement only.",
  },
  {
    // SIW's Setup column prints these two words.
    term: "Crowded", aliases: ["crowded short", "crowded shorts", "crowded trade", "crowded, rising", "crowded rising", "setup"], functions: ["SIW"],
    shown: ["Crowded", "Crowded, rising"],
    definition: "SIW's flag for a heavily shorted name: at least 10% of the float short, or five or more days to cover with at least 5% of the float short "
      + "(days to cover alone when the float is unknown). Crowded, rising adds a price up over the month. A fixed threshold, not a squeeze forecast.",
  },
  {
    term: "Squeeze", aliases: ["short squeeze", "squeezes", "short covering"], functions: ["SIW"], shown: ["Short squeeze watch"],
    definition: "A price rise that forces short sellers to buy shares back to limit their losses, which lifts the price further. "
      + "It needs a crowded short and little trading to absorb the buying; SIW lists the names where that could happen and does not predict one.",
  },
  {
    term: "SI change", aliases: ["si chg", "short interest change"], functions: ["SIW"], shown: ["SI Chg %"],
    definition: "The change in shares short from the settlement before, in percent. A split between the two settlements is not adjusted.",
  },
  {
    term: "1M return", aliases: ["1m", "one month return", "month move"], functions: ["SIW"], shown: ["1M %"],
    definition: "The price change over one calendar month, from the latest daily close to the last close on or before the same day a month earlier.",
  },
  {
    term: "Short volume", aliases: ["daily short volume", "short sale volume", "exempt volume"], functions: ["SIV"],
    shown: ["Short volume", "Short %", "Exempt volume"],
    definition: "Shares sold short in a day's off-exchange trading, which FINRA publishes daily; Short % is its share of the day's volume there. "
      + "It is a flow of trades, not the open position short interest counts, and it includes exempt volume.",
  },
  // Quote boards (QQ). The words a beginner meets in a quote's rows and its status line.
  {
    term: "Ticker", aliases: ["tickers", "ticker symbol", "symbol", "stock symbol"], functions: ["QQ"], shown: ["Ticker", "Symbol"],
    definition: "The short code a security trades under, such as AAPL for Apple or ^GSPC for the S&P 500. Type it after a function: fn QQ AAPL.",
  },
  {
    term: "Pre-market", aliases: ["pre-mkt", "pre-market session", "pre-market trading", "pre-market price"], functions: ["QQ"],
    shown: ["Pre-Market", "pre-market", "PRE-MKT"],
    definition: "Trading in a US stock before the regular session opens, from 4:00 to 9:30 am New York time, when fewer trades happen and prices can jump. "
      + "An index does not trade then: its pre-market status means it has not opened, and its level is still the last close.",
  },
  {
    term: "After hours", aliases: ["after-hrs", "post-market", "extended hours", "after-hours trading"], functions: ["QQ"],
    shown: ["After Hours", "after hours", "AFTER-HRS"],
    definition: "Trading in a US stock after the regular session closes, from 4:00 to 8:00 pm New York time. "
      + "Like the pre-market it is thin, so a price there can move more than the regular close suggests.",
  },
  {
    term: "Regular close", aliases: ["close", "closing price", "last close", "prior close", "regular session", "regular session close"],
    functions: ["QQ"], shown: ["close", "Close"],
    definition: "The last price of the regular session, 9:30 am to 4:00 pm New York time for US stocks. "
      + "From the close until the next open a quote's Last and change stay at it, and pre-market and after-hours prices are shown beside it.",
  },
  {
    term: "Delayed", aliases: ["delayed quote", "delayed quotes", "delay", "15 min delayed", "live", "real-time"], functions: ["QQ", "FUT"],
    shown: ["delayed", "Delayed"],
    definition: "A price that reaches you some minutes after it traded; the status line gives the lag, such as 15 min delayed. A live (real-time) price has no lag.",
  },
  // Futures (FUT, CTM).
  {
    term: "Futures contract", aliases: ["futures", "future", "futures contracts", "contract", "contract month", "expiry", "expiration"],
    functions: ["FUT", "CTM"], shown: ["CONTRACT", "Contract"],
    definition: "An agreement to buy or sell something, such as oil, gold or the S&P 500, at a set price on a set date. Each contract has a month (Dec 26) and expires, "
      + "and most traders close out before then. A contract's own Settlement line says how it ends: in cash or by physical delivery.",
  },
  {
    term: "Settle (futures)", aliases: ["settle", "settle price", "settlement price", "futures settle", "daily settlement price"],
    functions: ["FUT", "CTM"], shown: ["Settle", "PREV"],
    definition: "A futures contract's official price for the day, set by its exchange from trading near the close. "
      + "The day's change and margin are measured from it, and it can differ from the last trade. FUT's PREV is the previous one.",
  },
  // The economic calendar (ECO).
  {
    term: "Actual", aliases: ["actual release", "actual value"], functions: ["ECO"], shown: ["ACTUAL", "Actual"],
    definition: "The figure a release came in at, filled in once it is published. A dash means it is still to come.",
  },
  {
    term: "Forecast", aliases: ["forecasts", "consensus", "expected"], functions: ["ECO"], shown: ["FORECAST", "Forecast"],
    definition: "What economists expected the release to show, the consensus before it comes out. Markets move on the gap between Actual and Forecast more than on the number alone.",
  },
  {
    term: "Prior", aliases: ["previous", "prior value", "previous release"], functions: ["ECO"], shown: ["PRIOR", "Prior"],
    definition: "The previous release's figure, the one Actual and Forecast are compared with.",
  },
  {
    term: "Impact", short: "IMP", aliases: ["importance", "event impact", "high impact"], functions: ["ECO"],
    definition: "How much a release usually moves markets: HIGH for the big ones (CPI, jobs, rate decisions), MED and LOW for speeches and smaller data.",
  },
];

const ANSI = /\x1b\[[0-9;]*m/g;

/** Letters and digits only, lower case: `stop-out`, `Stop Out` and `stopout` are one lookup. */
function lookupKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function names(entry: GlossaryEntry): string[] {
  return [entry.term, ...(entry.short ? [entry.short] : []), ...entry.aliases];
}

export interface GlossaryLookup {
  /** The entries the query names: by the term, its abbreviation or an alias. */
  exact: GlossaryEntry[];
  /**
   * The others whose names start a word with each word of the query: `stop-out` finds stop-out vs average.
   * Those that hold the words whole come first.
   */
  partial: GlossaryEntry[];
}

// Shorter words (the `b` and `c` of `B/C`) would find half the glossary.
const MIN_PARTIAL_WORD = 3;

export function lookupGlossary(query: string): GlossaryLookup {
  const key = lookupKey(query);
  if (!key) return { exact: [], partial: [] };
  const exact = GLOSSARY.filter((entry) => names(entry).some((name) => lookupKey(name) === key));
  const wanted = words(query).filter((word) => word.length >= MIN_PARTIAL_WORD);
  const partial = wanted.length === 0 ? [] : GLOSSARY.filter((entry) => {
    if (exact.includes(entry)) return false;
    const have = names(entry).flatMap(words);
    return wanted.every((word) => have.some((name) => name.startsWith(word)));
  });
  // The entries that hold the words whole come before those that only start with them: `float` is the float, not the floating rate note.
  const whole = (entry: GlossaryEntry) => {
    const have = names(entry).flatMap(words);
    return wanted.every((word) => have.includes(word));
  };
  return { exact, partial: partial.sort((left, right) => Number(whole(right)) - Number(whole(left))) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The label as a whole token of the text: `bp` in `Chg bp` but not in `+9bp` or `bps`. */
function showsLabel(text: string, label: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(label)}(?![A-Za-z0-9])`).test(text);
}

/** The glossary entries a function's report shows, in glossary order. */
export function reportGlossary(token: string, reportText: string): GlossaryEntry[] {
  const text = reportText.replace(ANSI, "");
  const upper = token.toUpperCase();
  return GLOSSARY.filter((entry) => entry.functions.includes(upper)
    && (entry.shown ?? [entry.term, ...(entry.short ? [entry.short] : [])]).some((label) => showsLabel(text, label)));
}

function textWidth(): number {
  return Math.min(cliTerminalWidth() ?? 100, 100);
}

function displayTerm(entry: GlossaryEntry): string {
  return entry.short ? `${entry.term} (${entry.short})` : entry.term;
}

/** Each entry's term and meaning, side by side where the width allows. */
export function renderGlossaryEntries(entries: readonly GlossaryEntry[]): string[] {
  return renderDefinitions(entries.map((entry) => [displayTerm(entry), entry.definition] as const), {
    width: textWidth(),
    termStyle: cliStyles.bold,
  });
}

/** What `--explain` adds under a report: the terms it shows, or a note that it shows none. */
export function renderReportGlossary(token: string, entries: readonly GlossaryEntry[]): string {
  if (entries.length === 0) {
    return wrapText(`${token} shows no glossary terms. gloomberb catalog glossary lists every term.`, textWidth())
      .map((line) => cliStyles.muted(line)).join("\n");
  }
  return [renderSection("Terms"), ...renderGlossaryEntries(entries)].join("\n");
}

/** Items joined by commas into lines of `width`, never breaking inside an item. */
function commaLines(items: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const item of items) {
    const next = line ? `${line}, ${item}` : item;
    if (line && next.length + 1 > width) {
      lines.push(`${line},`);
      line = item;
    } else {
      line = next;
    }
  }
  return line ? [...lines, line] : lines;
}

/** `catalog glossary`: every term, under the function that shows it first. */
export function renderGlossaryIndex(): string {
  const groups = new Map<string, string[]>();
  for (const entry of GLOSSARY) {
    const owner = entry.functions[0]!;
    groups.set(owner, [...(groups.get(owner) ?? []), displayTerm(entry)]);
  }
  const width = textWidth();
  const labelWidth = Math.max(...[...groups.keys()].map((owner) => owner.length)) + 4;
  return [
    `${renderSection("Glossary")} ${cliStyles.muted(`(${GLOSSARY.length})`)}`,
    ...[...groups].flatMap(([owner, terms]) => commaLines(terms, Math.max(20, width - labelWidth)).map((line, index) => (
      index === 0 ? `  ${cliStyles.command(owner)}${" ".repeat(labelWidth - 2 - owner.length)}${line}` : `${" ".repeat(labelWidth)}${line}`
    ))),
    "",
    ...wrapText("gloomberb catalog glossary <term> explains one; fn <function> --explain and portfolio show --explain add the terms a report shows.", width)
      .map((line) => cliStyles.muted(line)),
  ].join("\n");
}

/** The JSON form of an entry. */
export function glossaryRecord(entry: GlossaryEntry): Record<string, unknown> {
  return {
    term: entry.term,
    ...(entry.short ? { short: entry.short } : {}),
    aliases: entry.aliases,
    functions: entry.functions,
    definition: entry.definition,
  };
}
