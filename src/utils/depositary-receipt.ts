import type { Fundamentals, Quote, ShareBasis } from "../types/financials";

// A word of its own, so a company called "ADS-TEC" is not one.
const DEPOSITARY_NAME = /(?:^|\s)(?:ADRs?|ADSs?|American depositary (?:receipts?|shares?))(?=$|[\s,)])/i;
const DEPOSITARY_TYPES = new Set(["ADR", "ADS", "DEPOSITARYRECEIPT"]);
/** A profile that opens by naming the security: "Toyota Motor Corporation Sponsored ADR is ...". */
const DEPOSITARY_SUBJECT = /^.{0,160}?\s(?:ADRs?|ADSs?|American depositary (?:receipts?|shares?)) is\s/i;

interface ListingEvidence {
  /** Gloom Cloud's verdict; absent when it has no evidence either way. */
  isDepositaryReceipt?: boolean | null;
  instrumentType?: string | null;
  name?: string | null;
  currency?: string | null;
  description?: string | null;
}

/**
 * Whether a listing is a depositary receipt. Gloom Cloud's flag decides when
 * it is set. Without it (an older service, or a listing it has no evidence
 * for) this reads the instrument type, the name, and the security name a
 * profile description opens with. A listing in another currency is the
 * ordinary line even when its profile mentions the receipts.
 */
export function isDepositaryReceipt(input: ListingEvidence): boolean {
  if (typeof input.isDepositaryReceipt === "boolean") return input.isDepositaryReceipt;
  const currency = input.currency?.trim().toUpperCase();
  if (currency && currency !== "USD") return false;
  if (DEPOSITARY_TYPES.has((input.instrumentType ?? "").replace(/[\s_-]/g, "").toUpperCase())) return true;
  if (input.name && DEPOSITARY_NAME.test(input.name)) return true;
  return DEPOSITARY_SUBJECT.test(input.description?.trim() ?? "");
}

/**
 * Whether a record's share counts are in receipts. Gloom Cloud says so with
 * `shareBasis`; without it, a receipt's counts are read as receipts, as its
 * market cap is.
 */
function sharesInReceipts(input: ListingEvidence & { shareBasis?: ShareBasis | null }): boolean {
  if (input.shareBasis === "depositary_receipt") return true;
  if (input.shareBasis === "ordinary") return false;
  return isDepositaryReceipt(input);
}

/**
 * Whether a listing's shares outstanding are counted in receipts: the
 * fundamentals' basis, else the listing's flag (the fundamentals' or the
 * quote's), else what the quote and profile say.
 */
export function sharesOutstandingInReceipts(
  quote: Pick<Quote, "isDepositaryReceipt" | "instrumentType" | "name" | "currency"> | null | undefined,
  fundamentals: Pick<Fundamentals, "isDepositaryReceipt" | "shareBasis"> | null | undefined,
  description?: string | null,
): boolean {
  return sharesInReceipts({
    instrumentType: quote?.instrumentType,
    name: quote?.name,
    currency: quote?.currency,
    description,
    isDepositaryReceipt: fundamentals?.isDepositaryReceipt ?? quote?.isDepositaryReceipt,
    shareBasis: fundamentals?.shareBasis,
  });
}

/** "1 ADR = 2 ordinary shares", or null without a usable ratio. */
export function adrRatioText(ratio: number | null | undefined): string | null {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return null;
  const count = Number.isInteger(ratio) ? String(ratio) : String(Number(ratio.toPrecision(6)));
  return `1 ADR = ${count} ordinary share${ratio === 1 ? "" : "s"}`;
}
