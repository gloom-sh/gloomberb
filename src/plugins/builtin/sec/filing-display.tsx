import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import { formatCompact, formatCurrency, formatNumber } from "../../../utils/format";
import { transactionTypeLabel, type InsiderTransaction } from "../insider/insider-data";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function formatFilingShortDate(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return "—";
  return `${MONTH_NAMES[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${date.getUTCFullYear()}`;
}

export function formatFilingMetaDate(value: Date): string {
  return value.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatFilingFormLabel(form: string, fallback = "FORM 4"): string {
  const value = form.trim();
  return value ? `FORM ${value}` : fallback;
}

export function renderFilingNotice(message: string, width: number) {
  const lines = wrapNoticeLines(message, width - 4);
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {lines.map((line, index) => (
        <Box key={index} height={1}>
          <Text fg={colors.textDim}>{line}</Text>
        </Box>
      ))}
    </Box>
  );
}

export function buildInsiderTransactionTitle(transaction: InsiderTransaction): string {
  const type = transactionTypeLabel(transaction.transactionType);
  const price = transaction.pricePerShare != null
    ? ` @ ${formatCurrency(transaction.pricePerShare)}`
    : "";
  const value = transaction.totalValue != null
    ? ` | ${formatCurrency(transaction.totalValue)}`
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

function wrapNoticeLines(text: string, width: number): string[] {
  const maxWidth = Math.max(width, 12);
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= maxWidth) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) lines.push(current);
  return lines;
}
