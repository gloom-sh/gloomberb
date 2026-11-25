/** One venue's part of a day's repurchases, as the company's return states it. */
interface BuybackVenue {
  /** `HKEX` for on-Exchange purchases; another exchange by its short name (`LSE`, `Nasdaq`, `SSE`), `Private` for an off-market arrangement. */
  venue: string;
  shares: number;
  paid: number | null;
  currency: string | null;
  high: number | null;
  low: number | null;
}

/** A session the company bought its shares on, from its latest return for that day. */
export interface BuybackDay {
  date: string;
  /** Every venue, the class the listing trades. */
  shares: number;
  /** On the Exchange only: the shares that count against the day's volume. */
  sharesOnExchange: number;
  paidOnExchange: number | null;
  currency: string | null;
  /** Paid over shares on the Exchange. */
  average: number | null;
  high: number | null;
  low: number | null;
  /** The session's volume on the Exchange. */
  volume: number | null;
  /** Shares bought on the Exchange as a percent of the session's volume. */
  percentOfVolume: number | null;
  venues: BuybackVenue[];
  /** Where the return says the shares went. */
  destination: "cancel" | "treasury" | "mixed" | null;
  /** Shares bought under the mandate so far, as of this return. */
  mandateUsed: number | null;
  /** The results period whose blackout window the day falls in. */
  inBlackout: string | null;
  filing: { url: string; publishedAt: string; revised: boolean; multiDay: boolean };
}

/** The 30 days before a results board meeting, through the results announcement, when a company may not buy back on the Exchange. */
export interface BuybackBlackoutWindow {
  start: string;
  end: string;
  results: string;
  period: string;
  /** `FY 2026`, `Q3 2026`. */
  label: string;
  /** The last day the Listing Rules allow for the annual or interim results, when it bounds the window. */
  deadline: string | null;
  /** `results`: held; `confirmed`: a notified board meeting; `estimate`: a projected date; `deadline`: no date yet, the Listing Rules' last day bounds it. */
  basis: "results" | "confirmed" | "estimate" | "deadline";
}

interface BuybackWindowSum {
  shares: number;
  sharesOnExchange: number;
  paidOnExchange: number;
  percentOfVolume: number | null;
  /** Sessions with a repurchase. */
  days: number;
  sessions: number;
}

export interface BuybacksPayload {
  symbol: string;
  name: string | null;
  status: "available" | "unavailable";
  /** When the newest return was published. */
  asOf: string | null;
  /** The newest session all returns are in for (08:30 the next business day), or the newest bought on when later. */
  asOfSession: string | null;
  /** The first session served: 11 June 2024, or later for a company whose returns are held from later. */
  heldFrom?: string | null;
  access: "full" | "preview";
  totalDays: number;
  previewDays: number | null;
  lockedDays: number;
  truncated: boolean;
  currency: string;
  mandate: {
    resolutionDate: string | null;
    authorised: number | null;
    repurchased: number;
    left: number | null;
    usedPercent: number | null;
    percentOfIssued: number | null;
    asOf: string;
    filing: string;
  } | null;
  shares: { issued: number | null; treasury: number | null; asOf: string; filing: string } | null;
  summary: {
    last5: BuybackWindowSum;
    last20: BuybackWindowSum;
    ytd: BuybackWindowSum;
    lastBuy: string | null;
    state: "buying" | "paused" | "blackout" | "none";
  };
  blackout: {
    current: BuybackBlackoutWindow | null;
    next: BuybackBlackoutWindow | null;
    windows: BuybackBlackoutWindow[];
    daysToNext: number | null;
  };
  /** Repurchases of another class the company has listed elsewhere (A shares), which do not trade on this line. */
  otherClasses: Array<{ stockCode: string; shareType: string | null; shares: number; days: number; venue: string | null; currency: string | null; lastBuy: string | null }>;
  /** The line's daily closes and volumes over the window, for the chart. */
  history: Array<{ date: string; close: number; volume: number | null }>;
  days: BuybackDay[];
}
