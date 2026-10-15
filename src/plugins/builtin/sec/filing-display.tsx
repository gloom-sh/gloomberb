import { EmptyState } from "../../../components";
import { formatShortDate } from "../../../utils/datetime-format";
import { formatCompact, formatCurrency, formatNumber } from "../../../utils/format";
import { transactionTypeLabel, type InsiderTransaction } from "../insider/insider-data";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatFilingShortDate(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "—";
  return `${MONTH_NAMES[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${date.getUTCFullYear()}`;
}

export function formatFilingMetaDate(value: Date): string {
  return formatShortDate(value, { utc: true });
}

export function formatFilingFormLabel(form: string, fallback = "FORM 4"): string {
  const value = form.trim();
  return value ? `FORM ${value}` : fallback;
}

export function renderFilingNotice(message: string) {
  return <EmptyState title={message} />;
}

export function buildInsiderTransactionTitle(transaction: InsiderTransaction): string {
  const type = transactionTypeLabel(transaction.transactionType);
  const price = transaction.pricePerShare != null
    ? ` @ ${formatCurrency(transaction.pricePerShare)}`
    : "";
  const value = transaction.totalValue != null
    ? ` | $${formatCompact(transaction.totalValue)}`
    : "";
  const shares = transaction.shares != null ? formatCompact(transaction.shares) : "—";
  const security = transaction.securityTitle || "shares";
  return `${type} ${shares} ${security}${transaction.isDerivative ? " (derivative)" : ""}${price}${value}`;
}

export function buildInsiderTransactionDetailBody(transaction: InsiderTransaction): string {
  const lines = [
    `Transaction: ${transactionTypeLabel(transaction.transactionType)}${transaction.transactionType ? ` (${transaction.transactionType})` : ""}`,
    `Transaction Date: ${transaction.filingDate ? formatFilingShortDate(transaction.filingDate) : "—"}`,
    `Security: ${transaction.securityTitle || "—"}${transaction.isDerivative ? " (derivative)" : ""}`,
    `Acquired/Disposed: ${transaction.acquiredDisposed === "A" ? "Acquired" : transaction.acquiredDisposed === "D" ? "Disposed" : transaction.acquiredDisposed || "—"}`,
    `Shares: ${transaction.shares != null ? formatNumber(transaction.shares, Number.isInteger(transaction.shares) ? 0 : 4) : "—"}`,
    `Price/Share: ${transaction.pricePerShare != null ? formatCurrency(transaction.pricePerShare) : "—"}`,
    `Total Value: ${transaction.totalValue != null ? formatCurrency(transaction.totalValue) : "—"}`,
    `Shares Owned After: ${transaction.sharesOwned != null ? formatNumber(transaction.sharesOwned, Number.isInteger(transaction.sharesOwned) ? 0 : 4) : "—"}`,
    `Ownership: ${transaction.ownershipType === "D" ? "Direct" : transaction.ownershipType === "I" ? "Indirect" : transaction.ownershipType || "—"}${transaction.ownershipNature ? ` — ${transaction.ownershipNature}` : ""}`,
  ];
  return lines.join("\n");
}
