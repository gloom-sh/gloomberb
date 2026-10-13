import type { SecFilingItem } from "../../../types/data-provider";
import { decodeHtmlEntities } from "../../../utils/html-entities";
import { formatCompact } from "../../../utils/format";
import { parseForm4Xml, transactionTypeLabel } from "../insider/insider-data";
import { buildInsiderTransactionTitle } from "./filing-display";

/**
 * What a small XML filing's own text says, for its row: who traded and which
 * way on an insider form, how much money came in or went out on a fund's
 * annual notice of securities sold.
 */
export interface RowSummary {
  title: string;
  /** An open-market purchase or sale, or a fund's net creations or redemptions. */
  direction: "buy" | "sell" | null;
}

const OWNERSHIP_FORMS = /^(?:3|4|5|144)(?:\/A)?$/i;
const FUND_FLOW_FORM = /^24F-2NT(?:\/A)?$/i;

const isOwnershipForm = (form: string) => OWNERSHIP_FORMS.test(form.trim());

/**
 * The document a row is read from. Gloom Cloud returns a Form 3, 4 or 5 as
 * its XML; a Form 144 and a 24F-2NT come as the SEC's rendered page unless
 * asked for their XML, which a separate key keeps apart from the page the
 * open filing shows. Other forms are not read for their rows.
 */
export function rowSummaryTarget(filing: SecFilingItem): SecFilingItem | null {
  const form = filing.form.trim();
  if (!isOwnershipForm(form) && !FUND_FLOW_FORM.test(form)) return null;
  if (/^[345](?:\/A)?$/i.test(form)) return filing;
  const url = filing.primaryDocumentUrl?.replace(/\/xsl[^/]+\//, "/");
  if (!url || url === filing.primaryDocumentUrl) return null;
  const document = url.split("/").pop() ?? "primary_doc.xml";
  return { ...filing, accessionNumber: `${filing.accessionNumber}:${document}`, primaryDocument: document, primaryDocumentUrl: url, filingUrl: url };
}

function tagText(xml: string, tag: string): string {
  const match = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}\\s*>`, "i").exec(xml);
  return decodeHtmlEntities((match?.[1] ?? "").replace(/<[^>]*>/g, "").trim());
}

const money = (value: number) => `$${formatCompact(value)}`;

/**
 * A Form 144 is a notice that someone means to sell: who, how many shares
 * and what they were worth when it was filed.
 */
function form144Summary(xml: string): RowSummary | null {
  const name = tagText(xml, "nameOfPersonForWhoseAccountTheSecuritiesAreToBeSold");
  if (!name) return null;
  const shares = Number(tagText(xml, "noOfUnitsSold"));
  const value = Number(tagText(xml, "aggregateMarketValue"));
  const amount = [
    Number.isFinite(shares) && shares > 0 ? `${formatCompact(shares)} shares` : "",
    Number.isFinite(value) && value > 0 ? `(${money(value)})` : "",
  ].filter(Boolean).join(" ");
  return { title: `${name}: proposed sale${amount ? ` of ${amount}` : ""}`, direction: null };
}

/** The reporting owner of a Form 3, which lists holdings and no transactions. */
function initialOwnershipSummary(xml: string): RowSummary | null {
  const name = tagText(xml, "rptOwnerName");
  return name ? { title: `${name}: initial holdings`, direction: null } : null;
}

const signedMoney = (value: number) => `${value < 0 ? "-" : "+"}${money(Math.abs(value))}`;

/**
 * A fund's 24F-2NT: what it sold (created) and redeemed over its fiscal year,
 * and the difference, which is the year's net flow.
 */
function fundFlowSummary(xml: string): RowSummary | null {
  const sold = Number(tagText(xml, "aggregateSalePriceOfSecuritiesSold"));
  const redeemed = Number(tagText(xml, "aggregatePriceOfSecuritiesRedeemedOrRepurchasedInFiscalYear"));
  if (!tagText(xml, "aggregateSalePriceOfSecuritiesSold") || !Number.isFinite(sold) || !Number.isFinite(redeemed)) return null;
  const yearEnd = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(tagText(xml, "lastDayOfFiscalYear"));
  const net = sold - redeemed;
  return {
    title: `${yearEnd ? `Year to ${yearEnd[3]}-${yearEnd[1]}-${yearEnd[2]}: ` : ""}net flow ${signedMoney(net)} (sold ${money(sold)}, redeemed ${money(redeemed)})`,
    direction: net > 0 ? "buy" : net < 0 ? "sell" : null,
  };
}

/**
 * The row text of a filing whose content has been read, or null when it was
 * not read or says nothing a row can use. An insider form with one
 * transaction says it in full; one with several lists their kinds.
 */
export function rowSummary(form: string, content: string | null | undefined): RowSummary | null {
  if (!content) return null;
  if (FUND_FLOW_FORM.test(form.trim())) return fundFlowSummary(content);
  if (!isOwnershipForm(form)) return null;
  const base = form.trim().replace(/\/A$/i, "");
  if (base === "144") return form144Summary(content);
  const transactions = parseForm4Xml(content);
  const first = transactions[0];
  if (!first) return base === "3" ? initialOwnershipSummary(content) : null;
  const codes = new Set(transactions.map((transaction) => transaction.transactionType));
  const direction = codes.has("P") && !codes.has("S") ? "buy" : codes.has("S") && !codes.has("P") ? "sell" : null;
  if (transactions.length === 1) return { title: `${first.reportedName}: ${buildInsiderTransactionTitle(first)}`, direction };
  const kinds = [...new Set(transactions.map((transaction) => transactionTypeLabel(transaction.transactionType)))];
  return { title: `${first.reportedName}: ${transactions.length} transactions, ${kinds.join(", ")}`, direction };
}
