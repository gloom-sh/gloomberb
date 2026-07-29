import { decodeHtmlEntities } from "../../utils/html-entities";

const MAX_CONTENT_CHARS = 16_000;
const OWNERSHIP_FORMS = new Set(["3", "3/A", "4", "4/A", "5", "5/A"]);

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

export function extractFilingContent(
  document: string,
  contentType = "",
  options: { form?: string; sourceUrl?: string } = {},
): string | null {
  if (isPdfDocument(document, contentType, options.sourceUrl)) {
    return PDF_FALLBACK_MESSAGE;
  }

  const ownershipSummary = options.form ? extractOwnershipDocumentSummary(document, options.form) : null;
  if (ownershipSummary) return ownershipSummary;

  const looksLikeMarkup = /html|xml/i.test(contentType) || /^\s*</.test(document);
  let text = document;

  if (looksLikeMarkup) {
    text = text
      .replace(/<head[\s\S]*?<\/head>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<div[^>]*display\s*:\s*none[^>]*>[\s\S]*?<\/div>/gi, " ")
      .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
      .replace(/<ix:hidden[\s\S]*?<\/ix:hidden>/gi, " ")
      .replace(/<ix:references[\s\S]*?<\/ix:references>/gi, " ")
      .replace(/<ix:resources[\s\S]*?<\/ix:resources>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|section|article|header|footer|li|tr|table|h\d|title)>/gi, "\n")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<(p|div|section|article|header|footer|li|tr|table|h\d|title)[^>]*>/gi, "\n")
      .replace(/<td[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }

  const lines = trimLeadingNoise(collapseDocumentLines(decodeHtmlEntities(text)));
  if (lines.length === 0) return null;

  let result = lines.join("\n");
  if (result.length > MAX_CONTENT_CHARS) {
    result = `${result.slice(0, MAX_CONTENT_CHARS).trimEnd()}\n\n[truncated]`;
  }
  return result;
}
