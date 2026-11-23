import { Parser } from "htmlparser2";
import type { SecFilingItem } from "../../types/data-provider";
import { decodeHtmlEntities } from "../../utils/html-entities";

const MAX_CONTENT_CHARS = 16_000;
const TRUNCATION_MARKER = "[truncated]";
const OWNERSHIP_FORMS = new Set(["3", "3/A", "4", "4/A", "5", "5/A"]);
const BLOCK_TAG = /^(?:p|div|section|article|header|footer|li|tr|table|h[1-6]|pre|blockquote)$/;
const HIDDEN_TAG = /^(?:head|title|script|style|svg|template|ix:header|ix:hidden|ix:references|ix:resources)$/;
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i;

export const PDF_FALLBACK_MESSAGE = "This SEC document is a PDF. Inline PDF text extraction is not supported here.";

export function isPdfDocument(body: string, contentType = "", url = ""): boolean {
  return /pdf/i.test(contentType)
    || /\.pdf(?:$|[?#])/i.test(url)
    || /^\s*%PDF-/i.test(body)
    || /^\s*begin 644 [^\n]+\.pdf/im.test(body)
    || /<PDF>/i.test(body);
}

function collapseDocumentLines(text: string): string[] {
  const rawLines = text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const lines: string[] = [];

  for (const line of rawLines) {
    if (lines[lines.length - 1] === line) continue;
    if (/^(xmlns|schemaRef|contextRef|unitRef|xsi:|ix:header|link:schemaRef|xbrli:|xbrldi:|xlink:|ix:|ixt:|ixt-sec:|dei:|ecd:|us-gaap:|iso4217:|srt:|country:|utr:|xl:)/i.test(line)) continue;
    if (/^(?:[a-z]{2,10}:[A-Za-z0-9][\w.-]*)(?:\s+[a-z]{2,10}:[A-Za-z0-9][\w.-]*){2,}$/i.test(line)) continue;
    if (/^LOGO$/i.test(line)) continue;
    lines.push(line);
  }

  return lines;
}

function trimLeadingNoise(lines: string[]): string[] {
  const startIndex = lines.findIndex((line) => /^(UNITED STATES|FORM [0-9A-Z-]+|SCHEDULE 14A|PROXY STATEMENT|NOTICE OF|ANNUAL REPORT|QUARTERLY REPORT|CURRENT REPORT|EXHIBIT\s+\d)/i.test(line));
  if (startIndex <= 0) return lines;

  const prefix = lines.slice(0, startIndex);
  const noiseCount = prefix.filter((line) => (
    /^Table of Contents$/i.test(line)
    || /^EX[-\s]?\d/i.test(line)
    || /\.(?:html?|xml|xsd|txt|pdf)$/i.test(line)
    || /^\d+$/.test(line)
    || line.length < 5
  )).length;
  return noiseCount >= Math.max(1, prefix.length - 1)
    ? lines.slice(startIndex)
    : lines;
}

function getTagInner(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match?.[1] ?? null;
}

function getTagInners(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi"))]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

function cleanXmlText(text: string): string {
  return decodeHtmlEntities(
    text
      .replace(/<footnoteId[^>]*\/>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim(),
  );
}

function extractXmlValue(xml: string, path: string[]): string | null {
  let current: string | null = xml;
  for (const tag of path) {
    current = current ? getTagInner(current, tag) : null;
    if (!current) return null;
  }

  const nestedValue = getTagInner(current, "value");
  const text = cleanXmlText(nestedValue ?? current);
  return text || null;
}

function formatOwnershipCode(value: string | null): string | null {
  if (!value) return null;
  if (value === "D") return "Direct";
  if (value === "I") return "Indirect";
  return value;
}

function formatOwnershipTransaction(section: string): string | null {
  const security = extractXmlValue(section, ["securityTitle"]);
  const date = extractXmlValue(section, ["transactionDate"]);
  const code = extractXmlValue(section, ["transactionCoding", "transactionCode"]);
  const shares = extractXmlValue(section, ["transactionAmounts", "transactionShares"]);
  const action = extractXmlValue(section, ["transactionAmounts", "transactionAcquiredDisposedCode"]);
  const price = extractXmlValue(section, ["transactionAmounts", "transactionPricePerShare"]);
  const owned = extractXmlValue(section, ["postTransactionAmounts", "sharesOwnedFollowingTransaction"]);
  const ownership = formatOwnershipCode(extractXmlValue(section, ["ownershipNature", "directOrIndirectOwnership"]));
  const nature = extractXmlValue(section, ["ownershipNature", "natureOfOwnership"]);

  const segments = [
    security,
    date,
    code ? `Code ${code}` : null,
    shares ? `${shares} shares${action ? ` ${action}` : ""}` : action ? `Action ${action}` : null,
    price ? `@ ${price}` : null,
    owned ? `Owned ${owned}` : null,
    ownership ? `Ownership ${ownership}` : null,
    nature ? `Nature ${nature}` : null,
  ].filter((value): value is string => !!value);

  return segments.length > 0 ? `- ${segments.join(" | ")}` : null;
}

function formatOwnershipHolding(section: string): string | null {
  const security = extractXmlValue(section, ["securityTitle"]);
  const owned = extractXmlValue(section, ["postTransactionAmounts", "sharesOwnedFollowingTransaction"]);
  const ownership = formatOwnershipCode(extractXmlValue(section, ["ownershipNature", "directOrIndirectOwnership"]));
  const nature = extractXmlValue(section, ["ownershipNature", "natureOfOwnership"]);

  const segments = [
    security,
    owned ? `Owned ${owned}` : null,
    ownership ? `Ownership ${ownership}` : null,
    nature ? `Nature ${nature}` : null,
  ].filter((value): value is string => !!value);

  return segments.length > 0 ? `- ${segments.join(" | ")}` : null;
}

function extractOwnershipDocumentSummary(document: string, form: string): string | null {
  if (!/<ownershipDocument[\s>]/i.test(document) || !OWNERSHIP_FORMS.has(form.toUpperCase())) return null;

  const lines: string[] = [];
  const issuerName = extractXmlValue(document, ["issuer", "issuerName"]) ?? extractXmlValue(document, ["issuerName"]);
  const symbol = extractXmlValue(document, ["issuer", "issuerTradingSymbol"]) ?? extractXmlValue(document, ["issuerTradingSymbol"]);
  const reportDate = extractXmlValue(document, ["periodOfReport"]);
  const ownerName = extractXmlValue(document, ["reportingOwner", "reportingOwnerId", "rptOwnerName"])
    ?? extractXmlValue(document, ["rptOwnerName"]);

  lines.push([`Form ${form}`, issuerName, symbol].filter(Boolean).join(" | "));
  if (reportDate) lines.push(`Report date ${reportDate}`);
  if (ownerName) lines.push(`Owner ${ownerName}`);

  const transactionLines = getTagInners(document, "nonDerivativeTransaction")
    .map((section) => formatOwnershipTransaction(section))
    .filter((value): value is string => !!value);

  const holdingLines = getTagInners(document, "nonDerivativeHolding")
    .map((section) => formatOwnershipHolding(section))
    .filter((value): value is string => !!value);

  if (transactionLines.length > 0) {
    lines.push("", "Transactions", ...transactionLines.slice(0, 12));
  } else if (holdingLines.length > 0) {
    lines.push("", "Holdings", ...holdingLines.slice(0, 12));
  }

  const result = lines.filter(Boolean).join("\n");
  return result || null;
}

function edgarTextBody(document: string): string {
  if (!/^\s*<(?:SEC-DOCUMENT|DOCUMENT)\b/i.test(document)) return document;
  const opening = /<TEXT\s*>/i.exec(document);
  if (!opening) return "";
  const start = opening.index + opening[0].length;
  const closing = /<\/(?:TEXT|DOCUMENT)\s*>/gi;
  closing.lastIndex = start;
  return document.slice(start, closing.exec(document)?.index);
}

function markupToText(markup: string): string {
  const chunks: string[] = [];
  let hiddenDepth = 0;
  let preformatted = false;
  new Parser({
    onopentag(tag, attributes) {
      if (hiddenDepth || HIDDEN_TAG.test(tag) || "hidden" in attributes || HIDDEN_STYLE.test(attributes.style ?? "")) {
        hiddenDepth += 1;
        return;
      }
      if (tag === "pre") preformatted = true;
      if (BLOCK_TAG.test(tag) || tag === "br" || tag === "hr") chunks.push("\n");
      if (tag === "td" || tag === "th") chunks.push(" ");
    },
    onclosetag(tag) {
      if (hiddenDepth) hiddenDepth -= 1;
      else {
        if (tag === "pre") preformatted = false;
        if (BLOCK_TAG.test(tag)) chunks.push("\n");
      }
    },
    ontext(text) {
      if (!hiddenDepth) chunks.push(preformatted ? text : text.replace(/\s+/g, " "));
    },
  }, { recognizeSelfClosing: true }).end(markup);
  return chunks.join("");
}

export function extractFilingContent(
  document: string,
  contentType = "",
  options: { form?: string; sourceUrl?: string } = {},
): string | null {
  const raw = document.trimEnd();
  const alreadyTruncated = raw.endsWith(TRUNCATION_MARKER);
  const body = edgarTextBody(alreadyTruncated ? raw.slice(0, -TRUNCATION_MARKER.length) : raw);
  if (isPdfDocument(body, contentType, options.sourceUrl)) return PDF_FALLBACK_MESSAGE;

  const ownershipSummary = options.form ? extractOwnershipDocumentSummary(body, options.form.trim()) : null;
  const looksLikeMarkup = /html|xml/i.test(contentType) || /^\s*<(?:[a-z!?])/i.test(body);
  const result = ownershipSummary ?? trimLeadingNoise(collapseDocumentLines(
    looksLikeMarkup ? markupToText(body) : decodeHtmlEntities(body),
  )).join("\n");
  if (!result) return null;
  return alreadyTruncated || result.length > MAX_CONTENT_CHARS
    ? `${result.slice(0, MAX_CONTENT_CHARS).trimEnd()}\n\n${TRUNCATION_MARKER}`
    : result;
}

export function filingContentPreview(
  raw: string | null | undefined,
  filing: Pick<SecFilingItem, "form" | "primaryDocumentUrl" | "filingUrl">,
): string | null {
  return raw == null ? null : extractFilingContent(raw, "", {
    form: filing.form,
    sourceUrl: filing.primaryDocumentUrl ?? filing.filingUrl,
  });
}
