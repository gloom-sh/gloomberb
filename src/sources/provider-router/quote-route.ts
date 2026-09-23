import type { QuoteSubscriptionTarget } from "../../types/data-provider";
import { canonicalExchange } from "../../utils/exchanges";
import type { BrokerCandidate } from "./brokers";

/** US listings the cloud streams from the consolidated tape. OTC is not on it. */
const US_TAPE_LISTINGS = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "IEX"]);
const EQUITY_SECURITY_TYPES = new Set(["", "STK", "ETF", "EQUITY", "ADR", "COMMONSTOCK", "DEPOSITARYRECEIPT"]);
/** The cloud identifies listed options by their compact OCC symbol only. */
const OCC_OPTION_SYMBOL = /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/;

function normalizeCode(value?: string): string {
  return (value ?? "").trim().toUpperCase().replace(/[\s_-]/g, "");
}

/**
 * Whether the cloud streams this target in real time to an entitled account:
 * a US-listed equity or ETF, an OPRA option under its OCC symbol, or a crypto
 * pair. Other listings, futures, FX, bonds and broker-local option symbols
 * only stream live through the broker that holds them.
 */
export function isCloudRealtimeInstrument(target: QuoteSubscriptionTarget): boolean {
  const contract = target.context?.instrument;
  const currency = normalizeCode(contract?.currency);
  if (currency && currency !== "USD") return false;
  const listing = canonicalExchange(target.exchange || contract?.primaryExchange);
  if (listing === "CCC") return true;
  const securityType = normalizeCode(contract?.secType);
  if (securityType === "OPT" || listing === "OPTIONS") {
    return OCC_OPTION_SYMBOL.test(target.symbol.trim().toUpperCase());
  }
  if (!EQUITY_SECURITY_TYPES.has(securityType)) return false;
  const primary = contract?.primaryExchange ? canonicalExchange(contract.primaryExchange) : "";
  return US_TAPE_LISTINGS.has(listing) && (!primary || US_TAPE_LISTINGS.has(primary));
}

/**
 * What a broker profile can stream right now:
 * - "unsupported": no quote stream for this profile (statement-only modes).
 * - "offline": the broker reports it is not connected.
 * - "delayed": connected, but the session serves delayed quotes.
 * - "live": connected and not known to be delayed. A broker without a
 *   status is taken at its word.
 */
export type BrokerQuoteStreamState = "live" | "delayed" | "offline" | "unsupported";

export function resolveBrokerQuoteStreamState(
  candidate: BrokerCandidate,
  observedDelayed: boolean,
): BrokerQuoteStreamState {
  const { broker, instance } = candidate;
  if (typeof broker.subscribeQuotes !== "function") return "unsupported";
  try {
    if (broker.canStreamQuotes?.(instance) === false) return "unsupported";
    const status = broker.getStatus?.(instance);
    if (status && status.state !== "connected") return "offline";
    return status?.quoteData === "delayed" || observedDelayed ? "delayed" : "live";
  } catch {
    return "unsupported";
  }
}

/**
 * A live broker keeps the targets routed to it. A delayed one keeps only the
 * targets the cloud cannot serve in real time to this account.
 */
export function canBrokerServeTarget(state: BrokerQuoteStreamState, cloudRealtime: boolean): boolean {
  return state === "live" || (state === "delayed" && !cloudRealtime);
}
