import { formatFilingDate } from "../../../utils/datetime-format";
import { EmptyState } from "../../../components";
import { MISSING_VALUE, formatCompact, formatCurrency, formatNumber } from "../../../utils/format";
import { transactionTypeLabel, type InsiderTransaction } from "../insider/insider-data";

export function formatFilingShortDate(value: Date | string | number): string {
  return formatFilingDate(value);
}

export function formatFilingFormLabel(form: string, fallback = "FORM 4"): string {
  const value = form.trim();
  return value ? `FORM ${value}` : fallback;
}

export function renderFilingNotice(message: string) {
  return <EmptyState title={message} />;
}

/** The most decimals a filed price is read to: Form 4 prices go to four, a weighted average sometimes further. */
const FILED_PRICE_DIGITS = 6;

/**
 * A price as the form filed it, never fewer than cents: $219.7219 where the
 * filer wrote 219.7219, $212.17, $0.00. Rounded to cents, a weighted average
 * would no longer add up to the form's own total.
 */
function formatFiledPrice(value: number): string {
  return formatCurrency(value, "USD", FILED_PRICE_DIGITS);
}

export function buildInsiderTransactionTitle(transaction: InsiderTransaction): string {
  const type = transactionTypeLabel(transaction.transactionType);
  const price = transaction.pricePerShare != null
    ? ` @ ${formatFiledPrice(transaction.pricePerShare)}`
    : "";
  const value = transaction.totalValue != null
    ? ` | $${formatCompact(transaction.totalValue)}`
    : "";
  const shares = transaction.shares != null ? formatCompact(transaction.shares) : MISSING_VALUE;
  const security = transaction.securityTitle || "shares";
  return `${type} ${shares} ${security}${transaction.isDerivative ? " (derivative)" : ""}${price}${value}`;
}

export function buildInsiderTransactionDetailBody(transaction: InsiderTransaction): string {
  const lines = [
    `Transaction: ${transactionTypeLabel(transaction.transactionType)}${transaction.transactionType ? ` (${transaction.transactionType})` : ""}`,
    `Transaction Date: ${transaction.filingDate ? formatFilingShortDate(transaction.filingDate) : MISSING_VALUE}`,
    `Security: ${transaction.securityTitle || MISSING_VALUE}${transaction.isDerivative ? " (derivative)" : ""}`,
    `Acquired/Disposed: ${transaction.acquiredDisposed === "A" ? "Acquired" : transaction.acquiredDisposed === "D" ? "Disposed" : transaction.acquiredDisposed || MISSING_VALUE}`,
    `Shares: ${transaction.shares != null ? formatNumber(transaction.shares, Number.isInteger(transaction.shares) ? 0 : 4) : MISSING_VALUE}`,
    `Price/Share: ${transaction.pricePerShare != null ? formatFiledPrice(transaction.pricePerShare) : MISSING_VALUE}`,
    `Total Value: ${transaction.totalValue != null ? formatCurrency(transaction.totalValue) : MISSING_VALUE}`,
    `Shares Owned After: ${transaction.sharesOwned != null ? formatNumber(transaction.sharesOwned, Number.isInteger(transaction.sharesOwned) ? 0 : 4) : MISSING_VALUE}`,
    `Ownership: ${transaction.ownershipType === "D" ? "Direct" : transaction.ownershipType === "I" ? "Indirect" : transaction.ownershipType || MISSING_VALUE}${transaction.ownershipNature ? ` — ${transaction.ownershipNature}` : ""}`,
  ];
  return lines.join("\n");
}
