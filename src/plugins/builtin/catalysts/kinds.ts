import type { CatalystEvent, CatalystResponse, CatalystType } from "../../../api-client/catalysts";
import type { DataTableColumn } from "../../../components";
import type { CloudResource } from "../shared/cloud-resource";
import { parsePublicTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { displayWidth, MISSING_VALUE } from "../../../utils/format";
import { catalystAgency, catalystCell, catalystDate, catalystDateBasis, catalystDateWithheld, catalystListedSpan, fitCatalystColumns, shortPartyName, type CatalystDateRead, type FitColumn } from "./model";

/**
 * The calendar's kinds of event, each a view with its own columns: what a
 * date means, and what a status says, differ between a trial's completion, a
 * drug's decision day ahead, a decision made, a company's results and a
 * rule's comment deadline.
 */
export type CatalystKind = "company" | "drugs" | "approvals" | "trials" | "regulation" | "legal";

export const CATALYST_KINDS: readonly { value: CatalystKind; label: string; types: readonly CatalystType[] }[] = [
  { value: "company", label: "Company", types: ["results", "shareholder_meeting", "merger_vote", "deal_closing", "investor_day"] },
  { value: "drugs", label: "Drugs", types: ["pdufa", "advisory"] },
  { value: "approvals", label: "Approvals", types: ["approval"] },
  { value: "trials", label: "Trials", types: ["clinical"] },
  { value: "regulation", label: "Regulation", types: ["rulemaking", "regulatory"] },
  { value: "legal", label: "Legal", types: ["litigation", "antitrust", "recall", "sanctions", "export_control", "tariff"] },
];

export const isCatalystKind = (value: unknown): value is CatalystKind => CATALYST_KINDS.some((kind) => kind.value === value);
/** An event's type as a row names it: the service lists an advisory committee's meeting as `advisory-meeting`. */
const isOfType = (type: string, of: CatalystType) => type === of || type.startsWith(`${of}-`);
export const catalystKindOf = (type: CatalystType): CatalystKind => CATALYST_KINDS.find((kind) => kind.types.some((of) => isOfType(type, of)))?.value ?? "regulation";
export const catalystKindTypes = (kind: CatalystKind): readonly CatalystType[] => CATALYST_KINDS.find((entry) => entry.value === kind)!.types;

const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * The view a calendar opens on: the kind of the type a filter names (an old
 * layout's Type, `fn PDUFA`), else the one chosen, else the first kind in tab
 * order with something coming up in `probe` (the unfiltered calendar's first
 * page), else the first with anything in it. Null while the probe loads.
 */
export function catalystOpeningKind(type: CatalystType | undefined, chosen: unknown, probe: readonly CatalystEvent[] | null, today = utcToday()): CatalystKind | null {
  if (type) return catalystKindOf(type);
  if (isCatalystKind(chosen)) return chosen;
  if (!probe) return null;
  const upcoming = new Set(probe.filter((event) => (catalystListedSpan(event)?.[1] ?? "") >= today).map((event) => catalystKindOf(event.type)));
  const any = new Set(probe.map((event) => catalystKindOf(event.type)));
  return CATALYST_KINDS.find((kind) => upcoming.has(kind.value))?.value ?? CATALYST_KINDS.find((kind) => any.has(kind.value))?.value ?? "company";
}

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The service's calendar order, for rows of several requests read together:
 * dates not over by `today` first, soonest ending first; then past dates,
 * latest first; then undated rows; ties newest id first.
 */
function compareCatalystOrder(a: CatalystEvent, b: CatalystEvent, read: CatalystDateRead, today: string): number {
  const rank = (event: CatalystEvent): { group: number; keys: string[] } => {
    const span = catalystListedSpan(event, read);
    return !span ? { group: 2, keys: [] } : span[1] >= today ? { group: 0, keys: [span[1], span[0]] } : { group: 1, keys: [span[0]] };
  };
  const x = rank(a), y = rank(b);
  if (x.group !== y.group) return x.group - y.group;
  for (let index = 0; index < x.keys.length; index += 1) {
    const by = order(x.keys[index]!, y.keys[index]!);
    if (by) return x.group === 1 ? -by : by;
  }
  return order(b.id, a.id);
}

export type CatalystStreamPage = (type: CatalystType, offset: number, force: boolean, signal: AbortSignal) => Promise<CloudResource<CatalystResponse>>;

export interface CatalystKindPage extends CloudResource<CatalystResponse> {
  rows: CatalystEvent[];
  nextOffset: number;
  hasMore: boolean;
}

/** Rows a page of a kind lists before it stops reading: a screen and more. */
const PAGE_ROWS = 50;

/** Rows each type reads at a time: a kind's types share a page between them. */
export const catalystStreamLimit = (types: readonly CatalystType[]) => (types.length > 1 ? Math.max(25, Math.ceil(100 / types.length)) : 100);

/** One event type's pages, read on demand. */
interface Stream {
  type: CatalystType;
  /** Rows read and not yet listed. */
  buffer: CatalystEvent[];
  /** The last row read: every row still to read sorts after it. */
  last: CatalystEvent | null;
  offset: number;
  done: boolean;
}

/** One reading of a kind from its first page, so a superseded reload cannot touch the next. */
interface Run {
  streams: Stream[];
  listed: number;
  first: CloudResource<CatalystResponse>;
}

const upcomingIn = (rows: readonly CatalystEvent[], read: CatalystDateRead, today: string) =>
  rows.filter((event) => (catalystListedSpan(event, read)?.[1] ?? "") >= today).length;

/**
 * A paged loader for a kind of several event types, which the service filters
 * one at a time: each type is read on its own, and their rows are listed in
 * the calendar's order only as far as every type still being read has a row
 * to compare, so a later page never lands above a row already listed. The
 * first page's payload stands for the kind: totals, held-back and upcoming
 * counts are its types' together. A free preview lists as many rows as one
 * request would, the first of them in calendar order, and counts the rest
 * with the held-back rows.
 */
export function createCatalystKindLoader(types: readonly CatalystType[], readPage: CatalystStreamPage, read: CatalystDateRead, today = utcToday()) {
  let run: Run | null = null;
  const fill = async (stream: Stream, force: boolean, signal: AbortSignal) => {
    const result = await readPage(stream.type, stream.offset, force, signal);
    const data = result.payload;
    stream.buffer.push(...data.events);
    stream.last = data.events.at(-1) ?? stream.last;
    stream.offset = data.offset + data.events.length;
    // A free preview is one page; the service holds the rest back.
    stream.done = data.events.length === 0 || stream.offset >= data.total || data.access?.pro === false;
    return result;
  };
  const take = (streams: readonly Stream[], limit: number): CatalystEvent[] => {
    const rows: CatalystEvent[] = [];
    while (rows.length < limit) {
      let next: Stream | null = null;
      for (const stream of streams) {
        if (stream.buffer.length && (!next || compareCatalystOrder(stream.buffer[0]!, next.buffer[0]!, read, today) < 0)) next = stream;
      }
      if (!next) break;
      const head = next.buffer[0]!;
      // A type with more to read could still have a row before this one.
      if (streams.some((stream) => !stream.buffer.length && !stream.done && stream.last && compareCatalystOrder(head, stream.last, read, today) > 0)) break;
      rows.push(next.buffer.shift()!);
    }
    return rows;
  };
  const start = async (force: boolean, signal: AbortSignal): Promise<{ current: Run; rows: CatalystEvent[] }> => {
    const streams: Stream[] = types.map((type) => ({ type, buffer: [], last: null, offset: 0, done: false }));
    const results = await Promise.all(streams.map((stream) => fill(stream, force, signal)));
    const pages = results.map((result) => result.payload);
    const preview = pages.find((page) => page.access?.pro === false)?.access;
    let rows: CatalystEvent[] = [];
    let held = 0, heldUpcoming = 0;
    if (preview) {
      const all = take(streams, Number.POSITIVE_INFINITY);
      rows = all.slice(0, preview.previewLimit);
      held = all.length - rows.length;
      heldUpcoming = upcomingIn(all.slice(rows.length), read, today);
    }
    const access = pages.every((page) => page.access) ? {
      pro: !preview, previewLimit: preview?.previewLimit ?? pages[0]!.access!.previewLimit,
      lockedRows: pages.reduce((sum, page) => sum + page.access!.lockedRows, held),
      ...(pages.every((page) => page.access!.lockedUpcoming != null) ? { lockedUpcoming: pages.reduce((sum, page) => sum + page.access!.lockedUpcoming!, heldUpcoming) } : {}),
    } : undefined;
    const upcoming = pages.every((page) => page.upcoming != null) ? pages.reduce((sum, page) => sum + page.upcoming!, 0) : null;
    const current: Run = {
      streams, listed: 0,
      first: {
        payload: { ...pages[0]!, events: [], total: pages.reduce((sum, page) => sum + page.total, 0), offset: 0, ...(access ? { access } : {}), upcoming },
        stale: results.some((result) => result.stale),
        refreshError: results.find((result) => result.refreshError)?.refreshError ?? null,
      },
    };
    return { current, rows };
  };
  return async ({ offset, force, signal }: { offset: number; force: boolean; signal: AbortSignal }): Promise<CatalystKindPage> => {
    let current: Run;
    let rows: CatalystEvent[] = [];
    if (offset === 0) {
      ({ current, rows } = await start(force, signal));
      run = current;
    } else if (run && run.listed === offset) current = run;
    else throw new Error("Reload the calendar to read more events.");
    const preview = current.first.payload.access?.pro === false;
    if (!preview) {
      rows = take(current.streams, PAGE_ROWS);
      // Read on until the page lists a screen of rows or every type is read out.
      while (rows.length < PAGE_ROWS) {
        const waiting = current.streams.filter((stream) => !stream.buffer.length && !stream.done);
        if (!waiting.length) break;
        await Promise.all(waiting.map((stream) => fill(stream, false, signal)));
        rows.push(...take(current.streams, PAGE_ROWS - rows.length));
      }
    }
    current.listed += rows.length;
    const hasMore = !preview && current.streams.some((stream) => stream.buffer.length > 0 || !stream.done);
    return { ...current.first, payload: { ...current.first.payload, events: rows }, rows, nextOffset: current.listed, hasMore };
  };
}

/**
 * Whom a company's own calendar names besides the company: its co-sponsors,
 * the other side of a case. The company is its listing's parties, matched by
 * symbol, and any party under one of their names elsewhere.
 */
export interface CatalystSelf {
  symbol: string;
  names: ReadonlySet<string>;
}

const partyName = (name: string) => shortPartyName(name).toLowerCase();

export function catalystSelf(events: readonly CatalystEvent[], symbol: string): CatalystSelf {
  const bare = parsePublicTickerKey(symbol).symbol.toUpperCase();
  const names = new Set(events.flatMap((event) => event.parties.filter((party) => party.ticker?.toUpperCase() === bare).map((party) => partyName(party.name))));
  return { symbol: bare, names };
}

const isSelf = (party: CatalystEvent["parties"][number], self: CatalystSelf) =>
  party.ticker?.toUpperCase() === self.symbol || self.names.has(partyName(party.name));

/** The parties besides the company, a listed one first: `MRK:XNYS`, `BioNTech +1`; empty when the company is the only one. */
export function catalystWith(event: Pick<CatalystEvent, "parties">, self: CatalystSelf): string {
  const others = event.parties.filter((party) => !isSelf(party, self)).sort((a, b) => Number(!a.ticker) - Number(!b.ticker));
  const names = [...new Set(others.map((party) => (party.ticker ? publicTickerKey(party.ticker, party.exchange ?? undefined) : shortPartyName(party.name))))];
  if (!names.length) return "";
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!;
}

/** A trial's phase as the registry lists it: `3`, `1/2`, `Early 1`; `—` for a study with none (observational). */
export function trialPhase(event: Pick<CatalystEvent, "metadata">): string {
  const phases = Array.isArray(event.metadata?.phases) ? event.metadata.phases : [];
  const shown = phases.flatMap((phase) => {
    const match = typeof phase === "string" ? /^(EARLY_)?PHASE(\d)$/i.exec(phase) : null;
    return match ? [match[1] ? `Early ${match[2]}` : match[2]!] : [];
  });
  return shown.length ? shown.join("/") : MISSING_VALUE;
}

/** A trial's date basis in the fewest words: its primary completion, estimated or reached, or the registry's last update. */
function trialDateBasis(event: CatalystEvent, read: CatalystDateRead): string {
  const basis = catalystDateBasis(event, read);
  return basis === "Primary completion (est.)" ? "Est. completion" : basis === "Primary completion (actual)" ? "Completed" : basis === "Primary completion" ? "Completion" : basis;
}

export type CatalystKindColumn = "date" | "basis" | "ticker" | "with" | "parties" | "title" | "phase" | "type" | "status" | "agency" | "country";

const KIND_COLUMNS: Record<CatalystKind, readonly CatalystKindColumn[]> = {
  company: ["date", "ticker", "parties", "title", "type", "status", "agency"],
  drugs: ["date", "basis", "ticker", "parties", "title", "type", "status", "agency"],
  approvals: ["date", "basis", "ticker", "parties", "title", "status", "agency", "country"],
  trials: ["date", "basis", "ticker", "parties", "title", "phase", "status"],
  regulation: ["date", "basis", "agency", "parties", "title", "type", "status", "country"],
  legal: ["date", "basis", "ticker", "parties", "title", "type", "status", "agency", "country"],
};

const PARTY_LABELS: Record<CatalystKind, string> = { company: "Company", drugs: "Company", approvals: "Company", trials: "Sponsor", regulation: "Filer", legal: "Parties" };
const TITLE_LABELS: Record<CatalystKind, string> = { company: "Event", drugs: "Event", approvals: "Product", trials: "Trial", regulation: "Rule or notice", legal: "Case or action" };

/** The columns that describe a row besides who it is about, what it is and when: each shown only where it tells rows apart. */
const FOLDABLE: ReadonlySet<CatalystKindColumn> = new Set(["basis", "type", "status", "agency", "country", "phase"]);

/**
 * What a kind's rows say alike, so its table leaves it out (catalystKindFold).
 * `basis` is the date basis every dated row shares, said once as the Date
 * column's heading.
 */
export interface CatalystKindFold {
  hidden: ReadonlySet<CatalystKindColumn>;
  basis: string | null;
}

/**
 * The columns a kind's rows would repeat: one with the same value on every
 * row, or with one value for each type (a PDUFA date is always a company's
 * target, an advisory meeting always the FDA's), says nothing the tab or the
 * Type column does not. Type goes when every row is one type. Read over the
 * rows listed, so a later page that differs brings its column back. A
 * withheld date has no basis to share; its Date cell says so.
 */
export function catalystKindFold(events: readonly CatalystEvent[], read: CatalystDateRead, kind: CatalystKind): CatalystKindFold {
  if (!events.length) return { hidden: new Set(catalystKindTypes(kind).length === 1 ? ["type"] : []), basis: null };
  const text = (event: CatalystEvent, column: CatalystKindColumn) => catalystKindCell(event, column, read, kind, null);
  const alike = (rows: readonly CatalystEvent[], column: CatalystKindColumn) => rows.every((event) => text(event, column) === text(rows[0]!, column));
  const dated = events.filter((event) => !catalystDateWithheld(event, typeof read === "string" ? read : read?.dateField));
  const byType = (rows: readonly CatalystEvent[]) => {
    const groups = new Map<string, CatalystEvent[]>();
    for (const event of rows) groups.set(event.type, [...groups.get(event.type) ?? [], event]);
    return [...groups.values()];
  };
  const hidden = new Set(KIND_COLUMNS[kind].filter((column) => FOLDABLE.has(column)
    && (column === "type" ? alike(events, column) : byType(column === "basis" ? dated : events).every((rows) => alike(rows, column)))));
  return { hidden, basis: hidden.has("basis") && dated.length && alike(dated, "basis") ? text(dated[0]!, "basis") : null };
}

export interface CatalystKindLayout {
  kind: CatalystKind;
  /** A company's own calendar: one With column for the other parties, or none when no row has any. */
  self?: { hasOthers: boolean } | null;
  /** What the rows say alike (catalystKindFold): those columns go, and a shared basis heads the date. */
  fold?: CatalystKindFold | null;
}

/** A shared basis as the date's heading: "Est. completion", "Deadline", "Comments due". */
const basisHeading = (basis: string) => (basis === "Comments" ? "Comments due" : basis);

/**
 * A kind's columns and their headings: a trial's phase and sponsor, a rule's
 * agency first and its filer. On a company's own calendar its ticker and name
 * are the pane's, so one With column names the other parties, and goes when
 * there are none. A column the rows say alike goes (catalystKindFold).
 */
export function catalystKindFields({ kind, self = null, fold = null }: CatalystKindLayout): Array<{ id: CatalystKindColumn; label: string }> {
  const label = (id: CatalystKindColumn) => ({
    date: fold?.basis ? basisHeading(fold.basis) : "Date", basis: "Date basis", ticker: "Ticker", with: "With", parties: PARTY_LABELS[kind], title: TITLE_LABELS[kind],
    phase: "Phase", type: "Type", status: "Status", agency: kind === "company" ? "Filed with" : "Agency", country: "Country",
  })[id];
  return KIND_COLUMNS[kind].flatMap((id): CatalystKindColumn[] => {
    if (fold?.hidden.has(id)) return [];
    if (self && (id === "ticker" || id === "parties")) return id === "ticker" && self.hasOthers ? ["with"] : [];
    return [id];
  }).map((id) => ({ id, label: label(id) }));
}

/** Columns sized to the widest cell on screen, up to a cap: a long value past it is the only one cut. */
const CONTENT_COLUMNS = ["date", "basis", "with", "type", "status", "agency"] as const;
type ContentColumn = typeof CONTENT_COLUMNS[number];
const CONTENT_CAPS: Record<ContentColumn, number> = { date: 16, basis: 27, with: 22, type: 19, status: 24, agency: 16 };

/** The widest cell of each column sized to its content, as the pane shows the rows. */
export function catalystKindWidths(events: readonly CatalystEvent[], read: CatalystDateRead, kind: CatalystKind, self: CatalystSelf | null = null): Partial<Record<ContentColumn, number>> {
  return Object.fromEntries(CONTENT_COLUMNS.map((column) => [column,
    events.reduce((widest, event) => Math.max(widest, displayWidth(catalystKindCell(event, column, read, kind, self, true))), 0)]));
}

/** A kind's columns fitted to `width`, each content column as wide as its widest cell (`widths`); a rule's agency stays as its date and title do. */
export function catalystKindColumns(width: number, layout: CatalystKindLayout & { widths?: Partial<Record<ContentColumn, number>> }): DataTableColumn[] {
  const { kind, widths = {} } = layout;
  const fields = catalystKindFields(layout);
  const fit = (id: ContentColumn, fallback: number) => {
    const content = widths[id];
    const heading = fields.find((field) => field.id === id)?.label.length ?? 0;
    return content ? Math.min(CONTENT_CAPS[id], Math.max(content, heading)) : Math.max(fallback, heading);
  };
  const sized = (id: ContentColumn, fallback: number, min?: number) => {
    const columnWidth = fit(id, fallback);
    return { width: columnWidth, ...(min ? { min: Math.min(min, columnWidth) } : {}) };
  };
  const sizes: Record<CatalystKindColumn, Pick<FitColumn, "width" | "min" | "flexGrow">> = {
    date: sized("date", 10),
    basis: sized("basis", 10, 10),
    ticker: { width: width < 110 ? 12 : 14, min: 10 },
    with: sized("with", 14, 10),
    parties: { width: Math.max(16, Math.min(28, Math.round(width * 0.16))), min: 14 },
    title: { width: 30, min: 20, flexGrow: 1 },
    phase: { width: 7 },
    type: sized("type", 13),
    status: sized("status", width < 110 ? 14 : 20, 14),
    agency: sized("agency", kind === "regulation" ? 16 : 12, 12),
    country: { width: 8 },
  };
  return fitCatalystColumns(fields.map(({ id, label }) => ({ id, label, align: "left" as const, ...sizes[id] })), width, kind === "regulation" ? ["agency"] : []);
}

/**
 * Agencies by the names their tables read them under, where the full name
 * would be cut: `FAA` for the Federal Aviation Administration. The detail and
 * the Agency filter keep the full name.
 */
const SHORT_AGENCIES: Record<string, string> = {
  "SEC / company disclosure": "SEC / company", "Company investor relations": "Company IR", "EMA / European Commission": "EMA / EC", "European Commission": "EC",
  "Agriculture Department": "USDA", "Centers for Medicare & Medicaid Services": "CMS", "Coast Guard": "USCG", "Commodity Futures Trading Commission": "CFTC",
  "Comptroller of the Currency": "OCC", "Consumer Financial Protection Bureau": "CFPB", "Consumer Product Safety Commission": "CPSC", "Defense Department": "DOD",
  "Energy Department": "DOE", "Environmental Protection Agency": "EPA", "Federal Aviation Administration": "FAA", "Federal Communications Commission": "FCC",
  "Federal Deposit Insurance Corporation": "FDIC", "Federal Energy Regulatory Commission": "FERC", "Federal Housing Finance Agency": "FHFA",
  "Federal Motor Carrier Safety Administration": "FMCSA", "Federal Railroad Administration": "FRA", "Federal Reserve System": "Fed", "Federal Trade Commission": "FTC",
  "Financial Crimes Enforcement Network": "FinCEN", "Fish and Wildlife Service": "FWS", "Food and Drug Administration": "FDA", "Foreign Assets Control Office": "OFAC",
  "Health and Human Services Department": "HHS", "Homeland Security Department": "DHS", "Industry and Security Bureau": "BIS", "Internal Revenue Service": "IRS",
  "International Trade Administration": "ITA", "Justice Department": "DOJ", "Labor Department": "DOL", "National Credit Union Administration": "NCUA",
  "National Highway Traffic Safety Administration": "NHTSA", "National Oceanic and Atmospheric Administration": "NOAA", "Nuclear Regulatory Commission": "NRC",
  "Occupational Safety and Health Administration": "OSHA", "Patent and Trademark Office": "USPTO", "Pipeline and Hazardous Materials Safety Administration": "PHMSA",
  "Securities and Exchange Commission": "SEC", "Trade Representative, Office of United States": "USTR", "Transportation Department": "DOT",
};

/** Statuses in fewer words where the full one would be cut. */
const SHORT_STATUSES: Record<string, string> = { "company-reported target": "Company target" };

/** A status a date still ahead always has, which says nothing its date does not: only the ones that differ show. */
const QUIET_STATUSES = new Set(["scheduled"]);

/** What a withheld date reads in a kind's Date column, which says it in place of a basis. */
const DATE_WITHHELD = "Undisclosed";
/** A kind row's date as exports keep it: the ISO day the pane draws first, or that it is withheld. */
export const catalystKindDate = (event: CatalystEvent, read: CatalystDateRead): string =>
  catalystDateWithheld(event, typeof read === "string" ? read : read?.dateField) ? DATE_WITHHELD : catalystDate(event, read);

/**
 * A cell of a kind's table as text: the shared calendar cells, with a trial's
 * phase and short basis and the other parties. `short`, as the pane shows it:
 * an agency by its short name, a status in fewer words, a date still to come
 * without the status every one has.
 */
export function catalystKindCell(event: CatalystEvent, column: string, read: CatalystDateRead, kind: CatalystKind, self: CatalystSelf | null, short = false): string {
  if (column === "with") return self ? catalystWith(event, self) : "";
  if (column === "phase") return trialPhase(event);
  if (column === "basis" && kind === "trials") return trialDateBasis(event, read);
  if (column === "date" && catalystDateWithheld(event, typeof read === "string" ? read : read?.dateField)) return DATE_WITHHELD;
  if (short && column === "agency") return SHORT_AGENCIES[catalystAgency(event.agency)] ?? catalystAgency(event.agency);
  if (short && column === "status" && !event.datePassed) {
    if (QUIET_STATUSES.has(event.status.toLowerCase())) return "";
    const status = SHORT_STATUSES[event.status.toLowerCase()];
    if (status) return status;
  }
  return catalystCell(event, column, read, false);
}

/** What a kind's rows are, for an empty company calendar: "No trials linked to PFE yet." */
const KIND_NOUNS: Record<CatalystKind, string> = { company: "company events", drugs: "drug decisions", approvals: "approvals", trials: "trials", regulation: "rules or notices", legal: "legal actions" };
export const catalystKindNoun = (kind: CatalystKind) => KIND_NOUNS[kind];
