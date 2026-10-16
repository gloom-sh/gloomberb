/**
 * An asset category as brokers and search results spell it, reduced to one
 * key: upper case with spaces, hyphens and underscores removed, so "Common
 * Stock", "COMMON_STOCK" and "common-stock" are all "COMMONSTOCK".
 */
export function normalizeAssetCategory(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[\s_-]+/g, "");
}

/** ADR, ADS, GDR and their long names, in the singular or the plural. */
const DEPOSITARY_RECEIPT = /^(?:ADRS?|ADSS?|GDRS?|(?:AMERICAN|GLOBAL)?DEPOSITARY(?:RECEIPT|SHARE)S?)$/;

/**
 * Whether a category names a depositary receipt: a foreign company's shares
 * traded as a listing of their own ("American Depositary Receipt", "ADR",
 * "ADS", "American Depositary Shares", "Global Depositary Receipt", "GDR").
 */
export function isDepositaryReceiptCategory(value: string | null | undefined): boolean {
  return DEPOSITARY_RECEIPT.test(normalizeAssetCategory(value));
}
