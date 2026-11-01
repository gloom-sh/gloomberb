import type { OptionsChain } from "../../../types/financials";
import { formatCalendarDay } from "./model-spot";
import { loadOpenInterest, type OpenInterestPayload, type OptionsPositioningApi } from "../options-positioning/client";
import { logFailure } from "../../../utils/log-failure";

/**
 * The session a chain's open interest is counted at
 * (docs/research-data.md#greeks-spot-and-time). Gloom Cloud states it on the
 * chain (`openInterestAsOf`). A chain that does not say, from an older server,
 * borrows OPX's listed date, the session whose close its counts are, only when
 * the chain's counts are OPX's: every contract with a count in both agrees.
 * Otherwise the date is not stated.
 */
export interface OpenInterestAsOf {
  /** The session the chain's counts are as of, YYYY-MM-DD; null when it cannot be established. */
  date: string | null;
  /** The session OPX's counts are as of. */
  listedDate: string | null;
  /** Contracts with a count in both the chain and OPX's listing. */
  compared: number;
  /** Of those, the ones whose counts agree. */
  matched: number;
}

/**
 * The date the chain states for its counts: a session, or null when none of
 * its counts is dated. Undefined when the chain does not say, and only then is
 * OPX's listing compared.
 */
export function statedOpenInterestAsOf(chain: Pick<OptionsChain, "openInterestAsOf">): OpenInterestAsOf | undefined {
  const stated = chain.openInterestAsOf;
  if (stated !== null && (typeof stated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(stated))) return undefined;
  return { date: stated, listedDate: null, compared: 0, matched: 0 };
}

export function chainOpenInterestAsOf(
  chain: Pick<OptionsChain, "calls" | "puts">,
  listed: Pick<OpenInterestPayload, "oiDate" | "strikes">,
): OpenInterestAsOf {
  const byStrike = new Map(listed.strikes.map((row) => [row.strike, row]));
  let compared = 0;
  let matched = 0;
  for (const [side, contracts] of [["callOI", chain.calls], ["putOI", chain.puts]] as const) {
    for (const contract of contracts) {
      const count = byStrike.get(contract.strike)?.[side];
      if (contract.openInterest == null || count == null) continue;
      compared += 1;
      if (count === contract.openInterest) matched += 1;
    }
  }
  return { date: listed.oiDate && compared > 0 && matched === compared ? listed.oiDate : null,
    listedDate: listed.oiDate, compared, matched };
}

/** How long a chain waits for OPX's listing before it leaves the open-interest date unstated. */
const LISTED_TIMEOUT_MS = 8_000;

/** OPX's listed open interest for one expiry; null when it cannot be read in time or names another expiry. */
export async function loadListedOpenInterest(
  symbol: string,
  expiry: string,
  options: { signal?: AbortSignal; api?: OptionsPositioningApi } = {},
): Promise<OpenInterestPayload | null> {
  try {
    const listed = await loadOpenInterest(symbol, expiry, { signal: options.signal ?? AbortSignal.timeout(LISTED_TIMEOUT_MS) }, options.api);
    return listed.expiry === expiry ? listed : null;
  } catch (error) {
    logFailure("options.open-interest-as-of", "Load listed open interest failed")(error);
    return null;
  }
}

/** `OI as of Fri 9 Oct`, or `OI date not published` when the date cannot be established. */
export function openInterestAsOfLabel(asOf: Pick<OpenInterestAsOf, "date"> | null): string {
  return asOf?.date ? `OI as of ${formatCalendarDay(asOf.date)}` : "OI date not published";
}
