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
  footnoteIds?: string[];
}

export interface InsiderFilingDisclosure {
  form: string;
  originalFilingDate: string | null;
  reportingOwners: Array<{ name: string; cik: string; title: string }>;
  footnotes: Array<{ id: string; text: string }>;
  remarks: string | null;
  /** False for a filing with no transaction lines, e.g. one reporting only that the owner left Section 16. */
  hasTransactionLines: boolean;
}

export function isInsiderForm(form: string): boolean {
  return /^4(?:\/A)?$/i.test(form.trim());
}

export function isInsiderAmendment(form: string): boolean {
  return /^4\/A$/i.test(form.trim());
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

function isFlagSet(xml: string, tag: string): boolean {
  return /^(?:1|true)$/i.test(tagText(xml, tag));
}

/** The officer title, else the relationship boxes checked on the form (directors have no officer title). */
function ownerTitle(owner: string): string {
  const officerTitle = tagText(owner, "officerTitle");
  if (officerTitle) return officerTitle;
  return [
    isFlagSet(owner, "isDirector") ? "Director" : "",
    isFlagSet(owner, "isOfficer") ? "Officer" : "",
    isFlagSet(owner, "isTenPercentOwner") ? "10% Owner" : "",
    isFlagSet(owner, "isOther") ? tagText(owner, "otherText") || "Other" : "",
  ].filter(Boolean).join(", ");
}

function reportingOwners(xml: string): InsiderFilingDisclosure["reportingOwners"] {
  return [...xml.matchAll(/<(?:[\w.-]+:)?reportingOwner(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w.-]+:)?reportingOwner\s*>/gi)]
    .map((match) => ({ name: tagText(match[1]!, "rptOwnerName"), cik: tagText(match[1]!, "rptOwnerCik"), title: ownerTitle(match[1]!) }));
}

function disclosureText(xml: string): string {
  return decodeHtmlEntities(xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

export function parseForm4Disclosure(xml: string): InsiderFilingDisclosure | null {
  if (!/<(?:[\w.-]+:)?ownershipDocument(?:\s|>)/i.test(xml)) return null;
  const original = tagText(xml, "dateOfOriginalSubmission");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(original) ? new Date(`${original}T00:00:00Z`) : null;
  return {
    form: tagText(xml, "documentType") || "4",
    originalFilingDate: date && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === original ? original : null,
    reportingOwners: reportingOwners(xml),
    footnotes: [...xml.matchAll(/<(?:[\w.-]+:)?footnote\s[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?footnote\s*>/gi)]
      .map((match) => ({ id: match[1]!, text: disclosureText(match[2]!) })),
    remarks: disclosureText(tagContent(xml, "remarks") ?? "") || null,
    hasTransactionLines: /<(?:[\w.-]+:)?(?:nonDerivative|derivative)Transaction(?:\s|>)/i.test(xml),
  };
}

export function parseForm4Xml(xml: string): InsiderTransaction[] {
  const owners = reportingOwners(xml).filter((owner) => owner.name);
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
      footnoteIds: [...new Set([...block.matchAll(/<(?:[\w.-]+:)?footnoteId\s[^>]*\bid\s*=\s*["']([^"']+)["']/gi)].map((note) => note[1]!))],
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
