/**
 * Companies ranked by recent open-market insider buying or selling, as
 * `GET /cloud/sec/insider-signals` returns them. Buying counts Form 4
 * purchases (code P), selling the sales (code S) an insider chose to make: a
 * Rule 10b5-1 plan's, a sell-to-cover's, an option exercise's and an
 * offering's are left out. Only officers, directors and 10% owners count.
 * Dates are `YYYY-MM-DD`, values USD.
 */

export type InsiderSignalRole =
  | "CEO"
  | "CFO"
  | "COO"
  | "President"
  | "Chair"
  | "Officer"
  | "Director"
  | "10% owner";

/** Purchases or sales. */
export type InsiderSignalSide = "buy" | "sell";
/** Whose trades a ranking reads: everyone, chief officers and other officers, directors, or 10% owners. */
export type InsiderSignalRoleGroup = "all" | "officers" | "directors" | "owners";
/** Market value: micro under $300M, small to $2B, mid to $10B, large above. */
export type InsiderSignalCap = "micro" | "small" | "mid" | "large";

/**
 * One insider in a row: what they traded in the window. On the sell side
 * `buys` and `lastBuy` are the days they sold and the last of them.
 */
export interface InsiderSignalBuyer {
  name: string;
  role: InsiderSignalRole;
  value: number;
  /** Days the insider traded in the window. */
  buys: number;
  lastBuy: string;
  /** Left out by servers that predate selling. */
  shares?: number;
  /** The holding's change in the window, percent: positive bought, negative sold; null without balances. */
  stakeChangePct?: number | null;
  newPosition?: boolean;
  /** Sold every share and unit the forms report. */
  exited?: boolean;
}

/** One fact behind a row, structured, strongest first. */
interface InsiderWhySignal {
  kind: "cluster" | "repeat" | "usual" | "stake" | "new" | "exited" | "size";
  /** cluster: insiders; repeat: the ordinal; usual: the multiple; stake: percent, negative sold; new, exited: 1; size: dollars. */
  value: number;
  /** A few characters: "3 insiders", "4th buy", "5x usual", "+56%", "NEW". */
  text: string;
  /** The insider it is about; null for the company's (a cluster). */
  insider: { name: string; role: InsiderSignalRole } | null;
}

export interface InsiderSignalRow {
  ticker: string;
  issuerCik: string;
  company: string;
  /** 0 to 100. */
  score: number;
  /** Why the company ranks, strongest first, in plain words. */
  reasons: string[];
  /** Distinct insiders who traded in the window. */
  insiders: number;
  /** Insider trade days in the window. */
  buys: number;
  value: number;
  shares: number;
  firstBuy: string;
  lastBuy: string;
  lastFiled: string;
  signals: {
    clusterInsiders: number;
    repeatBuys: number;
    usualRatio: number | null;
    stakeIncreasePct: number | null;
    newPosition: boolean;
    /** Left out by servers that predate selling. */
    stakeChangePct?: number | null;
    exited?: boolean;
  };
  /** The reasons' facts, structured; left out by servers that predate them. */
  whySignals?: InsiderWhySignal[];
  /** The insiders who traded, largest first, up to ten. */
  buyers: InsiderSignalBuyer[];
  /** Stored market value, USD; null when the server has none for it. */
  marketCap?: number | null;
}

interface InsiderSignalsFilters {
  role: InsiderSignalRoleGroup;
  minValue: number;
  cluster: boolean;
  position: "new" | "exited" | null;
  cap: InsiderSignalCap | null;
}

export interface InsiderSignalsPayload {
  /** Left out by servers that predate selling: buying. */
  side?: InsiderSignalSide;
  /** Days of trading each row covers, ending `through`. */
  window: number;
  filters?: InsiderSignalsFilters;
  /** Whether rows carry market values, so the cap filter can work. */
  marketCaps?: "stored" | "unavailable";
  through: string;
  /** The newest filing day read. */
  asOf: string | null;
  /**
   * Days whose filings have all been read. `missingDays`: weekdays since
   * `from` the server no longer reads on its own and has not read whole, a gap
   * an outage left (left out by servers that predate it).
   */
  coverage: { from: string | null; through: string | null; missingDays?: string[] };
  rows: InsiderSignalRow[];
}

export interface CloudInsiderSignalsParams {
  /** Buying unless told. */
  side?: InsiderSignalSide;
  /** Days, 1 to 90; the server reads 30 when left out. */
  window?: number;
  /** Rows, 1 to 200; the server reads 50 when left out. */
  limit?: number;
  role?: InsiderSignalRoleGroup;
  /** USD the insiders traded in the window, at least. */
  minValue?: number;
  /** Only companies where two insiders or more traded within a span. */
  cluster?: boolean;
  /** "new" on the buy side, "exited" on the sell side. */
  position?: "new" | "exited";
  cap?: InsiderSignalCap;
}
