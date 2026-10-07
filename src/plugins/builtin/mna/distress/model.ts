import type { CloudFilingEventPayload } from "../../../../api-client";
import type {
  DesignationDateBasis,
  DistressDesignation,
  DistressFilingKind,
  GoingConcernDisclosure,
  GoingConcernVerdict,
  InsolvencyNotice,
} from "../../../../api-client/distress";
import type { DataTableColumn } from "../../../../components";
import { isUsListingExchange, parsePublicTickerKey, publicTickerKey } from "../../../../utils/exchanges";

export type DistressViewId = "filings" | "going-concern" | "listings" | "insolvency";

export const DISTRESS_VIEWS: { value: DistressViewId; label: string }[] = [
  { value: "filings", label: "8-K" },
  { value: "going-concern", label: "Going concern" },
  { value: "listings", label: "Listings" },
  { value: "insolvency", label: "Insolvency" },
];

export const DEFAULT_DISTRESS_VIEW: DistressViewId = "filings";

export function distressView(value: unknown): DistressViewId {
  return DISTRESS_VIEWS.some((view) => view.value === value) ? value as DistressViewId : DEFAULT_DISTRESS_VIEW;
}

export const MISSING = "--";

/** Every C0 and C1 control except the line break: source text is drawn as plain text, never as markup or escapes. */
const CONTROL_CHARACTERS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

export function plainText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, " ");
}

/** One line for a table cell. */
export function cellText(value: string): string {
  return plainText(value).replace(/\s+/g, " ").trim();
}

/** `2026-10-05` from a calendar date or an ISO instant; `--` when it is neither. */
export function isoDay(value: string | null | undefined): string {
  if (!value) return MISSING;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ? day : MISSING;
}

// --- 8-K filings ---------------------------------------------------------

export const FILING_KIND_OPTIONS: { value: DistressFilingKind; label: string }[] = [
  { value: "distress", label: "Bankruptcy & obligations" },
  { value: "listing", label: "Listing notices" },
];

/** The 8-K items this view is about, as the SEC titles them, shortened for a cell. */
const ITEM_LABELS: Record<string, { short: string; full: string }> = {
  "1.03": { short: "Bankruptcy/receivership", full: "Bankruptcy or receivership" },
  "2.04": { short: "Obligation trigger", full: "Triggering event that accelerates or increases a financial obligation" },
  "3.01": { short: "Listing notice", full: "Notice of delisting or failure to meet a listing standard" },
};

/** The cell names the first watched item in this order, and counts the rest. */
const ITEM_ORDER = ["1.03", "2.04", "3.01"];

export function filingEventLabel(event: CloudFilingEventPayload): string {
  const watched = ITEM_ORDER.filter((item) => event.items.includes(item));
  const first = watched[0];
  const text = first ? `${ITEM_LABELS[first]!.short}${watched.length > 1 ? ` +${watched.length - 1}` : ""}` : MISSING;
  return event.form?.trim().toUpperCase() === "8-K/A" ? `${text} (8-K/A)` : text;
}

/** Every item the filing reports under, the watched ones in the SEC's words. */
export function filingItemLines(event: CloudFilingEventPayload): string[] {
  return event.items.map((item, index) => {
    const known = ITEM_LABELS[item];
    return `${item}  ${known?.full ?? cellText(event.labels[index] ?? "")}`.trimEnd();
  });
}

const CIK_PLACEHOLDER = /^CIK\d+$/i;

/** The trading symbol of the filer, or null for a filer known only by its CIK. */
export function filingTicker(event: CloudFilingEventPayload): string | null {
  const ticker = event.ticker.trim();
  return ticker && !CIK_PLACEHOLDER.test(ticker) ? ticker.toUpperCase() : null;
}

export function cikLabel(cik: string | null | undefined): string | null {
  const digits = cik?.replace(/^0+/, "") ?? "";
  return /^\d+$/.test(digits) ? digits : null;
}

export function filingDate(event: CloudFilingEventPayload): string {
  return isoDay(event.filingDate ?? event.filedAt);
}

// --- Going concern -------------------------------------------------------

export type GoingConcernVerdictFilter = GoingConcernVerdict | "all";

export const VERDICT_LABELS: Record<GoingConcernVerdict, string> = {
  doubt_raised: "Substantial doubt disclosed",
  doubt_alleviated: "Substantial doubt alleviated",
  policy_only: "Policy text only",
  unclear: "Unclear",
};

export const VERDICT_OPTIONS: { value: GoingConcernVerdictFilter; label: string }[] = [
  { value: "doubt_raised", label: VERDICT_LABELS.doubt_raised },
  { value: "doubt_alleviated", label: VERDICT_LABELS.doubt_alleviated },
  { value: "policy_only", label: VERDICT_LABELS.policy_only },
  { value: "unclear", label: VERDICT_LABELS.unclear },
  { value: "all", label: "All" },
];

export function assessmentHorizonLabel(value: boolean | null): string {
  return value === true ? "One year after the statements are issued" : value === false ? "Not one year" : "Not stated";
}

export interface ListingTicker {
  /** What the app opens: a public ticker key such as `BMRA:XNAS` or `2314:TWSE`. */
  key: string;
  /** What the table shows: the bare symbol on a US exchange, symbol and venue elsewhere. */
  label: string;
}

/**
 * `BMRA:NASDAQ` reads as `BMRA` and opens that listing. An OTC venue is shown
 * but opened by its bare symbol, which ticker search resolves to the
 * over-the-counter quote.
 */
export function venueTicker(value: string | null | undefined): ListingTicker | null {
  const trimmed = value?.trim();
  if (!trimmed || CIK_PLACEHOLDER.test(trimmed)) return null;
  const { symbol, exchange } = parsePublicTickerKey(trimmed);
  if (!symbol) return null;
  if (!exchange) return { key: symbol, label: symbol };
  if (exchange === "OTC") return { key: symbol, label: `${symbol}:OTC` };
  return {
    key: publicTickerKey(symbol, exchange),
    label: isUsListingExchange(exchange) ? symbol : `${symbol}:${exchange}`,
  };
}

// --- Exchange listing designations --------------------------------------

export const DESIGNATION_KIND_LABELS: Record<string, string> = {
  delisted: "Delisted",
  changed_trading_method: "Changed trading method",
  suspended: "Trading suspended",
};

/** Filters whose value is "all" send nothing to the server. */
export const ALL = "all";
export const unlessAll = (value: string): string | undefined => (value && value !== ALL ? value : undefined);

export const DESIGNATION_KIND_OPTIONS = [
  { value: ALL, label: "All" },
  ...Object.entries(DESIGNATION_KIND_LABELS).map(([value, label]) => ({ value, label })),
];

export const EXCHANGE_OPTIONS = [
  { value: ALL, label: "All" },
  { value: "TWSE", label: "TWSE" },
  { value: "TPEX", label: "TPEx" },
];

const EXCHANGE_LABELS: Record<string, string> = { TWSE: "TWSE", TPEX: "TPEx" };

export function exchangeLabel(exchange: string): string {
  return EXCHANGE_LABELS[exchange.toUpperCase()] ?? exchange;
}

/** `changed_trading_method` reads `Changed trading method`, for a value this build does not know. */
function humanize(value: string): string {
  const words = cellText(value.replace(/_/g, " ")).toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : MISSING;
}

export function designationKindLabel(kind: string): string {
  return DESIGNATION_KIND_LABELS[kind] ?? humanize(kind);
}

export const DATE_BASIS_LABELS: Record<DesignationDateBasis, string> = {
  designation: "Designated",
  effective: "Effective",
  first_observed: "First seen",
};

/** The date the list sorts by: the official date when the exchange gives one, else when the row was first seen. */
export function designationDate(row: DistressDesignation): string {
  if (row.date_basis === "designation") return isoDay(row.designated_at);
  if (row.date_basis === "effective") return isoDay(row.effective_at);
  return isoDay(row.first_seen_at);
}

/** Delisted securities no longer trade, so only the other designations open a ticker. */
export function designationTicker(row: DistressDesignation): ListingTicker | null {
  if (row.kind === "delisted" || !row.symbol) return null;
  const ticker = venueTicker(row.symbol);
  return ticker ? { key: ticker.key, label: ticker.key } : null;
}

export function designationName(row: DistressDesignation): string {
  return cellText(row.entity_name_en || row.entity_name);
}

/** The date note the backend appends; the date basis already says it. */
const UNDATED_NOTE = /^official (designation|effective) date not supplied$/i;

/**
 * Source remarks as words: `PeriodicCallAuctionTrading=**` reads
 * `Periodic call auction trading: **`; empty and `none` flags are dropped.
 */
export function designationRemarks(remarks: string): string[] {
  const lines: string[] = [];
  for (const part of plainText(remarks).split(";")) {
    const text = part.trim();
    if (!text || UNDATED_NOTE.test(text)) continue;
    const pair = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(text);
    if (!pair) {
      lines.push(cellText(text));
      continue;
    }
    const value = pair[2]!.trim();
    if (!value || value.toLowerCase() === "none") continue;
    const words = pair[1]!.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    lines.push(`${words[0]!.toUpperCase()}${words.slice(1)}: ${cellText(value)}`);
  }
  return lines;
}

// --- Insolvency notices --------------------------------------------------

export const INSOLVENCY_KIND_LABELS: Record<string, string> = {
  safeguard: "Safeguard",
  reorganisation: "Reorganisation",
  liquidation: "Liquidation",
  restructuring_plan: "Restructuring plan",
  closure: "Closure of proceedings",
  claims_notice: "Claims notice",
  administration: "Administration",
  receivership: "Receivership",
  creditors_meeting: "Creditors' meeting",
  winding_up_petition: "Winding-up petition",
  winding_up_order: "Winding-up order",
  other: "Other",
};

/**
 * The Gazette's corporate insolvency notice codes that reach this list, in its
 * own words (thegazette.co.uk/noticecodes). The section matters: a members'
 * voluntary winding up is a solvent company closing.
 */
const GAZETTE_SECTIONS = {
  general: { full: "", short: "" },
  administration: { full: "administration", short: "" },
  receivership: { full: "receivership", short: "" },
  mvl: { full: "members' voluntary winding up", short: "MVL" },
  cvl: { full: "creditors' voluntary winding up", short: "CVL" },
  court: { full: "winding up by the court", short: "court" },
} as const;

const GAZETTE_CODES: Record<string, { title: string; section: keyof typeof GAZETTE_SECTIONS }> = {
  "2406": { title: "Notice of intended dividend", section: "general" },
  "2407": { title: "Notice of dividend", section: "general" },
  "2410": { title: "Appointment of administrators", section: "administration" },
  "2411": { title: "Administration orders", section: "administration" },
  "2412": { title: "Meetings of creditors", section: "administration" },
  "2421": { title: "Appointment of administrative receivers", section: "receivership" },
  "2422": { title: "Meetings of creditors", section: "receivership" },
  "2423": { title: "Appointment of receivers", section: "receivership" },
  "2431": { title: "Resolution for winding up", section: "mvl" },
  "2432": { title: "Appointment of liquidators", section: "mvl" },
  "2433": { title: "Notices to creditors", section: "mvl" },
  "2441": { title: "Resolution for winding up", section: "cvl" },
  "2442": { title: "Meetings of creditors", section: "cvl" },
  "2443": { title: "Appointment of liquidators", section: "cvl" },
  "2446": { title: "Notice to creditors", section: "cvl" },
  "2450": { title: "Petitions to wind up (companies)", section: "court" },
  "2452": { title: "Winding up order (companies)", section: "court" },
  "2454": { title: "Appointment of liquidators", section: "court" },
  "2455": { title: "Meetings of creditors", section: "court" },
  "2460": { title: "Notice to creditors", section: "court" },
  "2461": { title: "Dismissal of winding up petition", section: "court" },
};

/**
 * What the notice is, as its publisher labels it: the French judgment label,
 * or the Gazette notice title with its section, abbreviated for a cell.
 */
export function insolvencyNoticeLabel(row: InsolvencyNotice, form: "full" | "short" = "full"): string {
  const code = row.raw_code.trim();
  if (row.country !== "GB") return cellText(code) || MISSING;
  const known = GAZETTE_CODES[code];
  if (!known) return code ? `Notice code ${cellText(code)}` : MISSING;
  const section = GAZETTE_SECTIONS[known.section][form];
  if (!section) return known.title;
  return form === "full" ? `${known.title}, ${section}` : `${known.title} (${section})`;
}

export function insolvencyKindLabel(kind: string): string {
  return INSOLVENCY_KIND_LABELS[kind] ?? humanize(kind);
}

export const INSOLVENCY_KIND_OPTIONS = [
  { value: ALL, label: "All" },
  ...Object.entries(INSOLVENCY_KIND_LABELS).map(([value, label]) => ({ value, label })),
];

export const COUNTRY_OPTIONS = [
  { value: ALL, label: "All" },
  { value: "FR", label: "France" },
  { value: "GB", label: "United Kingdom" },
];

export function registryLabel(country: string): string {
  return country === "FR" ? "SIREN" : country === "GB" ? "Company number" : "Registry number";
}

const NOTICE_TYPE_LABELS: Record<string, string> = {
  annonce: "Notice",
  rectificatif: "Rectification",
  annulation: "Cancellation",
};

export function noticeTypeLabel(type: string): string {
  return NOTICE_TYPE_LABELS[type] ?? humanize(type);
}

export function noticeStatusLabel(status: string): string {
  return humanize(status);
}

/** The procedure, and a word when the notice was later corrected or withdrawn. */
export function insolvencyProcedureCell(row: InsolvencyNotice): string {
  const kind = insolvencyKindLabel(row.kind);
  return row.status === "active" ? kind : `${kind}, ${noticeStatusLabel(row.status).toLowerCase()}`;
}

export const insolvencyId = (row: InsolvencyNotice) => `${row.source}:${row.notice_id}`;

/** Two characters or more, as the route accepts; anything shorter searches nothing. */
export function namePrefix(query: string): string | undefined {
  const trimmed = query.trim();
  return trimmed.length >= 2 && trimmed.length <= 100 ? trimmed : undefined;
}

// --- Columns -------------------------------------------------------------

type Column = DataTableColumn & { id: string };

/**
 * Columns for `width`: drops from the front of `dropOrder` until the rest fit,
 * then shares the spare cells among the growing columns by their `flexGrow`.
 * The terminal table would hand all of it to the first one.
 */
function fit(columns: Column[], dropOrder: string[], width: number): Column[] {
  let kept = columns;
  // Each column carries a gap, and the table pads both edges.
  const need = (list: Column[]) => list.reduce((sum, column) => sum + column.width + 2, 2);
  for (const id of dropOrder) {
    if (need(kept) <= width) break;
    kept = kept.filter((column) => column.id !== id);
  }
  // One cell more for the scrollbar.
  const spare = width - need(kept) - 1;
  const weight = kept.reduce((sum, column) => sum + (column.flexGrow ?? 0), 0);
  if (spare <= 0 || weight <= 0) return kept;
  let left = spare;
  const growing = kept.filter((column) => (column.flexGrow ?? 0) > 0);
  return kept.map((column) => {
    if (!column.flexGrow) return column;
    const share = column === growing[growing.length - 1] ? left : Math.floor((spare * column.flexGrow) / weight);
    left -= share;
    return { ...column, width: column.width + share };
  });
}

export function filingColumns(width: number): Column[] {
  return fit([
    { id: "filed", label: "Filed", width: 10, align: "left" },
    { id: "company", label: "Company", width: 22, align: "left", flexGrow: 1 },
    { id: "ticker", label: "Ticker", width: 7, align: "left" },
    { id: "event", label: "Items", width: 24, align: "left", flexGrow: 1 },
    { id: "headline", label: "Headline", width: 34, align: "left", flexGrow: 2 },
  ], ["headline", "ticker", "event"], width);
}

export function goingConcernColumns(width: number, verdict: GoingConcernVerdictFilter): Column[] {
  return fit([
    { id: "filed", label: "Filed", width: 10, align: "left" },
    { id: "company", label: "Company", width: 24, align: "left", flexGrow: 1 },
    { id: "ticker", label: "Ticker", width: 10, align: "left" },
    { id: "form", label: "Form", width: 5, align: "left" },
    { id: "period", label: "Period", width: 10, align: "left" },
    // One verdict filtered means one verdict on every row.
    ...(verdict === "all" ? [{ id: "verdict", label: "Disclosure", width: 28, align: "left" as const }] : []),
  ], ["period", "form", "ticker", "verdict"], width);
}

export function designationColumns(width: number): Column[] {
  return fit([
    { id: "date", label: "Date", width: 10, align: "left" },
    { id: "basis", label: "Date basis", width: 10, align: "left" },
    { id: "code", label: "Code", width: 6, align: "left" },
    { id: "name", label: "Company", width: 16, align: "left", flexGrow: 1 },
    { id: "exchange", label: "Exch", width: 5, align: "left" },
    { id: "status", label: "Status", width: 22, align: "left" },
  ], ["exchange", "code"], width);
}

export function insolvencyColumns(width: number): Column[] {
  return fit([
    { id: "published", label: "Published", width: 10, align: "left" },
    { id: "company", label: "Company", width: 22, align: "left", flexGrow: 1 },
    { id: "country", label: "Ctry", width: 4, align: "left" },
    { id: "registry", label: "Registry no.", width: 12, align: "left" },
    { id: "procedure", label: "Procedure", width: 22, align: "left" },
    { id: "notice", label: "Notice", width: 26, align: "left", flexGrow: 1 },
  ], ["registry", "notice", "country"], width);
}

export function goingConcernTitle(row: GoingConcernDisclosure): string {
  return cellText(row.company.name) || `CIK ${cikLabel(row.cik) ?? row.cik}`;
}
