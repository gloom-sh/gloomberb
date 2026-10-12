import { centralBankNamed } from "../utils/central-banks";

/**
 * Central bank acronyms that are also the symbol of a listing people ask
 * about (BOE is a NYSE fund, RBI Raiffeisen Bank in Vienna), so `events BOE`
 * stays that listing's. ECB S.A. in Warsaw is reached as ECB:WSE.
 */
const LISTED_SYMBOLS = new Set(["BOE", "BOC", "RBA", "PBOC", "RBI", "BOK"]);

/**
 * What `events` says for a central bank named on its own ("ECB", "Norges
 * Bank"): its meetings are no company's corporate events, and CBR has its
 * rate and the next decision from the bank's own calendar (China's next LPR
 * fixing; SAMA publishes none). Null for anything else, a symbol with a venue
 * included.
 */
export function centralBankEventsMessage(typed: string): string | null {
  const bank = centralBankNamed(typed);
  if (!bank || LISTED_SYMBOLS.has(typed.trim().replace(/^\$/, "").toUpperCase())) return null;
  const next = bank.id === "US" ? " and the next FOMC date" : bank.id === "CN" ? " and the next LPR fixing"
    : bank.id === "SA" ? "" : " and the next decision";
  return `${bank.id === "US" ? "Fed" : bank.short} meetings are not listed; CBR shows the rate${next} (gloomberb fn CBR).`;
}
