// A word of its own, so a company called "ADS-TEC" is not one.
const DEPOSITARY_NAME = /(?:^|\s)(?:ADRs?|ADSs?|American depositary (?:receipts?|shares?))(?=$|[\s,)])/i;
const DEPOSITARY_TYPES = new Set(["ADR", "ADS", "DEPOSITARYRECEIPT"]);
/** A profile that opens by naming the security: "Toyota Motor Corporation Sponsored ADR is ...". */
const DEPOSITARY_SUBJECT = /^.{0,160}?\s(?:ADRs?|ADSs?|American depositary (?:receipts?|shares?)) is\s/i;

/**
 * Whether a US listing is a depositary receipt, as far as its data says. A
 * quote carries no ADR flag or ratio, so this reads the instrument type, the
 * name, and the security name a profile description opens with. Its share
 * count and market cap are then counted in receipts, not ordinary shares. A
 * listing in another currency is the ordinary line even when its profile
 * mentions the receipts.
 */
export function isDepositaryReceipt(input: {
  instrumentType?: string | null;
  name?: string | null;
  currency?: string | null;
  description?: string | null;
}): boolean {
  const currency = input.currency?.trim().toUpperCase();
  if (currency && currency !== "USD") return false;
  if (DEPOSITARY_TYPES.has((input.instrumentType ?? "").replace(/[\s_-]/g, "").toUpperCase())) return true;
  if (input.name && DEPOSITARY_NAME.test(input.name)) return true;
  return DEPOSITARY_SUBJECT.test(input.description?.trim() ?? "");
}
