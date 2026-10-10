import { cliStyles, cliTerminalWidth, renderDefinitions, renderSection, wrapText } from "../utils/cli-output";

/**
 * Plain-words meanings of the rates and auction terms the rates functions
 * show in their rows, headers and footers. `catalog glossary` lists them,
 * `catalog explain <term>` prints one and `fn <function> --explain` follows a
 * report with the ones it shows. Only terms a pane or report actually prints
 * belong here.
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
  {
    term: "Pctl 1Y", aliases: ["percentile", "1y percentile", "pctl"], functions: ["BTMM", "WIRP"],
    definition: "Where today's value ranks against the past year of the same series: 100 is the highest, 0 the lowest.",
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
  /** The others whose names start a word with each word of the query: `stop-out` finds stop-out vs average. */
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
  return { exact, partial };
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
    ...wrapText("gloomberb catalog glossary <term> explains one; fn <function> --explain adds the terms a report shows.", width)
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
