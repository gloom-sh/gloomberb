import type { SecFilingDocument, SecFilingItem } from "../../../types/data-provider";

const SEC_EXHIBIT_TYPE_RE = /^EX[-\s]?\d/i;
const SEC_XBRL_EXHIBIT_TYPE_RE = /^EX[-\s]?101(?:\.|$)/i;
const SEC_NON_READABLE_DOCUMENT_RE = /\.(?:cal|def|gif|jpg|jpeg|json|lab|png|pre|sch|xsd|zip)(?:$|[?#])/i;
const SEC_SUPPORT_DOCUMENT_TYPE_RE = /^(?:GRAPHIC|XML|ZIP|EX[-\s]?101(?:\.|$)|EX-FILING FEES)/i;

export function documentContentKey(filing: SecFilingItem, document: SecFilingDocument): string {
  return `${filing.accessionNumber}:${document.document || document.url}`;
}

export function documentContentTarget(filing: SecFilingItem, document: SecFilingDocument): SecFilingItem {
  return {
    ...filing,
    accessionNumber: documentContentKey(filing, document),
    form: document.type || filing.form,
    primaryDocument: document.document,
    primaryDocDescription: document.description,
    primaryDocumentUrl: document.url,
    filingUrl: document.url,
  };
}

export function formatCompactDocumentLabel(document: SecFilingDocument): string {
  const label = document.isPrimary ? "PRIMARY" : document.type || "DOCUMENT";
  const description = document.description
    && document.description !== document.document
    && document.description !== document.type
    ? ` | ${document.description}`
    : "";
  return `${label} ${document.document}${description}`;
}

export function documentHeading(document: SecFilingDocument): string {
  const label = document.type || "DOCUMENT";
  const description = document.description
    && document.description !== document.document
    && document.description !== document.type
    ? ` | ${document.description}`
    : "";
  return `${label} | ${document.document}${description}`;
}

export function isInlineExhibitDocument(document: SecFilingDocument): boolean {
  const type = document.type.trim();
  if (!SEC_EXHIBIT_TYPE_RE.test(type)) return false;
  if (SEC_XBRL_EXHIBIT_TYPE_RE.test(type)) return false;
  return !SEC_NON_READABLE_DOCUMENT_RE.test(document.document) && !SEC_NON_READABLE_DOCUMENT_RE.test(document.url);
}

export function isDefaultVisibleFilingDocument(document: SecFilingDocument): boolean {
  if (document.isPrimary) return true;
  if (isInlineExhibitDocument(document)) return true;
  return !SEC_SUPPORT_DOCUMENT_TYPE_RE.test(document.type.trim());
}

/** A primary preview or a rendered exhibit can independently hit the extraction limit. */
export function filingPreviewTruncated(
  filing: SecFilingItem,
  documents: readonly SecFilingDocument[],
  contentCache: ReadonlyMap<string, string | null>,
): boolean {
  const keys = [filing.accessionNumber, ...documents.filter(isInlineExhibitDocument).map((document) => documentContentKey(filing, document))];
  return keys.some((key) => contentCache.get(key)?.trimEnd().endsWith("[truncated]"));
}
