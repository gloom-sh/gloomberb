import { decodeHtmlEntities } from "../../../utils/html-entities";

export interface InsiderTransaction {
  /** Transaction date, distinct from the enclosing SEC filing date. */
  filingDate: Date | null;
  reportedName: string;
  title: string;
  transactionType: string;
  shares: number | null;
  pricePerShare: number | null;
  totalValue: number | null;
  sharesOwned: number | null;
  form: string;
  transactionIndex?: number;
  securityTitle?: string;
  isDerivative?: boolean;
  acquiredDisposed?: string;
  ownershipType?: string;
  ownershipNature?: string;
  reportingOwners?: Array<{ name: string; cik: string; title: string }>;
}

function tagContent(xml: string, tag: string): string | undefined {
  return xml.match(new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, "i"))?.[1];
}

function tagText(xml: string, tag: string): string {
  return decodeHtmlEntities((tagContent(xml, tag) ?? "").replace(/<[^>]*>/g, "").trim());
}

function numberValue(xml: string, tag: string): number | null {
  const raw = tagText(tagContent(xml, tag) ?? "", "value");
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function parseForm4Xml(xml: string): InsiderTransaction[] {
  const owners = [...xml.matchAll(/<(?:[\w.-]+:)?reportingOwner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?reportingOwner\s*>/gi)]
    .map((match) => ({ name: tagText(match[1]!, "rptOwnerName"), cik: tagText(match[1]!, "rptOwnerCik"), title: tagText(match[1]!, "officerTitle") }))
    .filter((owner) => owner.name);
  if (!owners.length) return [];
  const blocks = [...xml.matchAll(/<(?:[\w.-]+:)?(nonDerivativeTransaction|derivativeTransaction)(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?\1\s*>/gi)];
  return blocks.map((match, transactionIndex) => {
    const block = match[2]!;
    const amounts = tagContent(block, "transactionAmounts") ?? "";
    const shares = numberValue(amounts, "transactionShares");
    const price = numberValue(amounts, "transactionPricePerShare");
    const dateText = tagText(tagContent(block, "transactionDate") ?? "", "value");
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateText) ? new Date(`${dateText}T00:00:00Z`) : null;
    return {
      filingDate: date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateText ? date : null,
      reportedName: owners.map(({ name }) => name).join("; "),
      title: [...new Set(owners.map(({ title }) => title).filter(Boolean))].join("; "),
      reportingOwners: owners,
      transactionType: tagText(tagContent(block, "transactionCoding") ?? "", "transactionCode"),
      securityTitle: tagText(tagContent(block, "securityTitle") ?? "", "value"),
      isDerivative: match[1]!.toLowerCase() === "derivativetransaction",
      transactionIndex,
      shares,
      pricePerShare: price,
      totalValue: shares != null && price != null ? shares * price : null,
      sharesOwned: numberValue(tagContent(block, "postTransactionAmounts") ?? "", "sharesOwnedFollowingTransaction"),
      acquiredDisposed: tagText(tagContent(amounts, "transactionAcquiredDisposedCode") ?? "", "value"),
      ownershipType: tagText(tagContent(tagContent(block, "ownershipNature") ?? "", "directOrIndirectOwnership") ?? "", "value"),
      ownershipNature: tagText(tagContent(tagContent(block, "ownershipNature") ?? "", "natureOfOwnership") ?? "", "value"),
      form: tagText(xml, "documentType") || "4",
    };
  });
}

export function transactionTypeLabel(type: InsiderTransaction["transactionType"]): string {
  const labels: Record<string, string> = {
    P: "BUY", S: "SELL", A: "AWARD", D: "DISPOSE", M: "EXERCISE", C: "CONVERT",
    F: "TAX/EXERCISE PAYMENT", G: "GIFT", X: "EXERCISE", O: "OUT-OF-MONEY EXERCISE",
    E: "EXPIRATION", H: "CANCELLATION", I: "DISCRETIONARY", J: "OTHER", K: "SWAP",
    L: "SMALL ACQUISITION", U: "TENDER", W: "INHERITANCE", Z: "TRUST TRANSFER",
  };
  return labels[type] ?? (type || "—");
}
