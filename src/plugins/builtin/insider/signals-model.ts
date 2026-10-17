import type { DataTableColumn } from "../../../components";
import type { SelectButtonOption } from "../../../components/ui/select-button";
import type {
  InsiderSignalBuyer,
  InsiderSignalCap,
  InsiderSignalRole,
  InsiderSignalRoleGroup,
  InsiderSignalRow,
  InsiderSignalSide,
  InsiderSignalsPayload,
} from "../../../api-client/insider-signals";
import { formatShortDate } from "../../../utils/datetime-format";
import { displayWidth, formatCompact } from "../../../utils/format";
import { formatInsiderName } from "./display";
import { DEFAULT_INSIDER_SIGNAL_WINDOW, DEFAULT_INSIDER_SIGNALS_QUERY, INSIDER_SIGNAL_WINDOWS, type InsiderSignalsQuery } from "./signals-client";

export type InsiderSignalColumnId = "ticker" | "company" | "score" | "why" | "insiders" | "value" | "lastBuy";

export interface InsiderSignalColumn extends DataTableColumn {
  id: InsiderSignalColumnId;
}

/** The ranked view's title, and the one it goes back to from a company. */
export const INSIDER_SIGNALS_TITLE = "Insider Activity";

export const INSIDER_SIGNAL_WINDOW_OPTIONS = INSIDER_SIGNAL_WINDOWS.map((days) => ({ value: String(days), label: `${days}D` }));

export const INSIDER_SIGNAL_SIDE_OPTIONS: SelectButtonOption<InsiderSignalSide>[] = [
  { value: "buy", label: "Buying" },
  { value: "sell", label: "Selling" },
];

export const INSIDER_SIGNAL_ROLE_OPTIONS: SelectButtonOption<InsiderSignalRoleGroup>[] = [
  { value: "all", label: "All" },
  { value: "officers", label: "Officers", description: "CEO, CFO and other officers" },
  { value: "directors", label: "Directors" },
  { value: "owners", label: "10% owners" },
];

export const INSIDER_SIGNAL_MIN_OPTIONS: SelectButtonOption[] = [
  { value: "0", label: "Any" },
  { value: "100000", label: "$100k+" },
  { value: "250000", label: "$250k+" },
  { value: "1000000", label: "$1M+" },
  { value: "10000000", label: "$10M+" },
];

export const INSIDER_SIGNAL_CAP_OPTIONS: SelectButtonOption<InsiderSignalCap | "all">[] = [
  { value: "all", label: "All" },
  { value: "micro", label: "Micro", description: "Under $300M" },
  { value: "small", label: "Small", description: "$300M to $2B" },
  { value: "mid", label: "Mid", description: "$2B to $10B" },
  { value: "large", label: "Large", description: "Over $10B" },
];

/** The words a side changes: the column headers, the position filter, the empty and coverage lines. */
export interface InsiderSideWords {
  /** "buying", "selling". */
  activity: string;
  /** The dollars column. */
  traded: string;
  /** The insiders column. */
  insiders: string;
  /** The last trade day column. */
  last: string;
  /** The position toggle: a new position, a whole stake sold. */
  position: string;
}

export function insiderSideWords(side: InsiderSignalSide): InsiderSideWords {
  return side === "sell"
    ? { activity: "selling", traded: "Sold", insiders: "Sellers", last: "Last Sale", position: "Exited" }
    : { activity: "buying", traded: "Bought", insiders: "Buyers", last: "Last Buy", position: "New" };
}

/** A stored window the pane offers, or the default. */
function insiderSignalWindow(value: unknown): number {
  const days = Number(value);
  return (INSIDER_SIGNAL_WINDOWS as readonly number[]).includes(days) ? days : DEFAULT_INSIDER_SIGNAL_WINDOW;
}

const optionValue = <T extends string>(options: readonly SelectButtonOption<T>[], value: unknown, fallback: T): T =>
  options.some((option) => option.value === value) ? value as T : fallback;

/** A query from what the pane stored, each part checked and defaulted on its own. */
export function insiderSignalsQueryFrom(stored: {
  side?: unknown;
  window?: unknown;
  role?: unknown;
  minValue?: unknown;
  cluster?: unknown;
  position?: unknown;
  cap?: unknown;
}): InsiderSignalsQuery {
  const cap = optionValue(INSIDER_SIGNAL_CAP_OPTIONS, stored.cap, "all");
  return {
    side: optionValue(INSIDER_SIGNAL_SIDE_OPTIONS, stored.side, DEFAULT_INSIDER_SIGNALS_QUERY.side),
    window: insiderSignalWindow(stored.window),
    role: optionValue(INSIDER_SIGNAL_ROLE_OPTIONS, stored.role, "all"),
    minValue: Number(optionValue(INSIDER_SIGNAL_MIN_OPTIONS, String(stored.minValue ?? "0"), "0")),
    cluster: stored.cluster === true,
    position: stored.position === true,
    cap: cap === "all" ? null : cap,
  };
}

/** Whether a query narrows the side and window it reads. */
export function insiderSignalsFiltered(query: InsiderSignalsQuery): boolean {
  return query.role !== "all" || query.minValue > 0 || query.cluster || query.position || query.cap !== null;
}

/** A chip in the why column: a fact, in the tone its kind takes. */
export interface InsiderSignalChip {
  label: string;
  tone: "neutral" | "accent" | "positive" | "negative";
  variant: "subtle" | "solid";
  /**
   * Starts a group: the row's insiders (a cluster, or how many traded), or
   * an insider's role followed by their facts. Groups stand further apart
   * than chips; the terminal joins a group's chips with spaces and the
   * groups with " · ".
   */
  lead: boolean;
}

/** Insiders named inline; the detail strip lists every one. */
const MAX_INSIDER_GROUPS = 2;
/** A stake raise above this, in percent, is said as the holding's multiple. */
const STAKE_MULTIPLE_ABOVE = 300;

/** A raise in percent as the holding's multiple: +500% is "6x". */
function stakeMultiple(pct: number): string {
  const multiple = 1 + pct / 100;
  return multiple >= 10 ? `${Math.round(multiple)}x` : `${(Math.round(multiple * 10) / 10).toString()}x`;
}

/**
 * The why column's chips from the row's structured signals. A row of
 * several insiders opens with them: the cluster in the accent, else how
 * many traded. Then up to two insiders, each their role and every fact
 * about them (4th buy, 5x usual, +56%, 6x stake, both ways), NEW or EXITED
 * in the side's solid tone, in the order of their strongest fact. Dollars
 * are the value column's, not a chip; a lone insider whose only reason is
 * dollars is named by role. Null when the server sent no structured
 * signals (it predates them): the reasons are the text.
 */
export function insiderSignalChips(row: InsiderSignalRow, side: InsiderSignalSide): InsiderSignalChip[] | null {
  if (!Array.isArray(row.whySignals)) return null;
  const tone = side === "sell" ? "negative" : "positive";
  const role = (who: { role: InsiderSignalRole }): InsiderSignalChip => ({ label: who.role, tone: "neutral", variant: "subtle", lead: true });
  let together: InsiderSignalChip | null = null;
  const groups: InsiderSignalChip[][] = [];
  const byInsider = new Map<string, InsiderSignalChip[]>();
  for (const signal of row.whySignals) {
    if (signal.kind === "size") continue;
    if (!signal.insider) {
      together ??= { label: signal.text, tone: "accent", variant: "subtle", lead: true };
      continue;
    }
    let group = byInsider.get(signal.insider.name);
    if (!group) {
      if (groups.length === MAX_INSIDER_GROUPS) continue;
      group = [role(signal.insider)];
      byInsider.set(signal.insider.name, group);
      groups.push(group);
    }
    const label = signal.kind === "stake" && signal.value > STAKE_MULTIPLE_ABOVE ? `${stakeMultiple(signal.value)} stake` : signal.text;
    group.push({
      label,
      tone: signal.kind === "both" ? "neutral" : tone,
      variant: signal.kind === "new" || signal.kind === "exited" ? "solid" : "subtle",
      lead: false,
    });
  }
  if (!together && row.insiders > 1) together = { label: `${row.insiders} insiders`, tone: "neutral", variant: "subtle", lead: true };
  if (together) return [together, ...groups.flat()];
  if (groups.length) return groups.flat();
  // Only dollars: who traded them.
  const top = row.buyers[0];
  return top ? [role(top)] : [{ label: `${row.insiders} insiders`, tone: "neutral", variant: "subtle", lead: true }];
}

/** The chips in their groups, as they are drawn and read. */
export function insiderSignalChipGroups(chips: readonly InsiderSignalChip[]): InsiderSignalChip[][] {
  const groups: InsiderSignalChip[][] = [];
  for (const chip of chips) {
    if (chip.lead || groups.length === 0) groups.push([chip]);
    else groups[groups.length - 1]!.push(chip);
  }
  return groups;
}

/** The chips as one line of text: the terminal's why, and the CLI's. */
export function insiderSignalChipsText(chips: readonly InsiderSignalChip[]): string {
  return insiderSignalChipGroups(chips).map((group) => group.map((chip) => chip.label).join(" ")).join(" · ");
}

/** Why, as text: the chips' words, or the reasons from a server that predates them. */
export function insiderSignalWhy(row: InsiderSignalRow, side: InsiderSignalSide = "buy"): string {
  const chips = insiderSignalChips(row, side);
  return chips ? insiderSignalChipsText(chips) : row.reasons.join(" · ");
}

/** A badge is its label plus one cell of padding on each side, one cell from the next in its group and two from the next group. */
const CHIP_CHROME = 2;
const CHIP_GAP = 1;
export const INSIDER_SIGNAL_GROUP_GAP = 2;

const chipGap = (chip: InsiderSignalChip) => (chip.lead ? INSIDER_SIGNAL_GROUP_GAP : CHIP_GAP);

/** Cells the chips take side by side. */
function insiderSignalChipsWidth(chips: readonly InsiderSignalChip[]): number {
  return chips.reduce((sum, chip, index) => sum + displayWidth(chip.label) + CHIP_CHROME + (index ? chipGap(chip) : 0), 0);
}

/**
 * The chips that fit `width` cells whole, strongest first: a chip never
 * shows cut, and an insider's role is not left alone without a fact about
 * them. The text column keeps every chip.
 */
export function insiderSignalChipsFit(chips: readonly InsiderSignalChip[], width: number): InsiderSignalChip[] {
  const shown: InsiderSignalChip[] = [];
  let used = 0;
  for (const chip of chips) {
    const cells = displayWidth(chip.label) + CHIP_CHROME + (shown.length ? chipGap(chip) : 0);
    if (used + cells > width) break;
    shown.push(chip);
    used += cells;
  }
  // A role whose facts did not fit says nothing about why.
  const next = chips[shown.length];
  if (next && !next.lead && shown[shown.length - 1]?.lead) shown.pop();
  return shown;
}

const DAY_MS = 86_400_000;

/**
 * Filings are read from a first day on: a window reaching past it ranks less
 * trading than it says, and so does one before any day has been read whole,
 * or one holding days an outage left unread.
 */
export function insiderSignalsCoverageNotice(payload: Pick<InsiderSignalsPayload, "window" | "through" | "coverage" | "side">): string | null {
  const activity = insiderSideWords(payload.side ?? "buy").activity;
  const from = payload.coverage.from;
  if (!from) return `Form 4 filings are still being read, so this ranking may leave out ${activity}.`;
  const windowStart = new Date(Date.parse(`${payload.through}T00:00:00Z`) - (payload.window - 1) * DAY_MS).toISOString().slice(0, 10);
  const missingDays = Array.isArray(payload.coverage.missingDays) ? payload.coverage.missingDays : [];
  const missing = missingDays.filter((day) => typeof day === "string" && day >= windowStart && day <= payload.through);
  const day = (value: string) => formatShortDate(value, { utc: true });
  const days = (count: number) => `${count} ${count === 1 ? "day" : "days"}`;
  if (from > windowStart) {
    return missing.length
      ? `Form 4 filings are read from ${day(from)}, and ${days(missing.length)} since ${missing.length === 1 ? "is" : "are"} not read yet, so this ranking may leave out ${activity}.`
      : `Form 4 filings are read from ${day(from)}, so this window leaves out ${activity} before then.`;
  }
  if (missing.length === 1) return `Form 4 filings for ${day(missing[0]!)} are not read yet, so this ranking may leave out ${activity}.`;
  if (missing.length > 1) return `Form 4 filings for ${days(missing.length)} in this window are not read yet, so this ranking may leave out ${activity}.`;
  return null;
}

export function formatSignalValue(value: number): string {
  return `$${formatCompact(value)}`;
}

/** A trade day as m/d/yy, as the INS table writes a transaction date. */
export function formatSignalDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return match ? `${Number(match[2])}/${Number(match[3])}/${match[1]!.slice(2)}` : "--";
}

export function insiderSignalsEmptyTitle(window: number, side: InsiderSignalSide = "buy", filtered = false): string {
  const activity = insiderSideWords(side).activity;
  return filtered
    ? `No insider ${activity} in the last ${window} days matches these filters.`
    : `No open-market insider ${activity} in the last ${window} days.`;
}

/** An insider's change in the holding: NEW, EXITED, +56%, -39%, 6x above +300%, or "--" without balances. */
export function formatInsiderStakeChange(buyer: InsiderSignalBuyer): string {
  if (buyer.exited) return "EXITED";
  if (buyer.newPosition) return "NEW";
  const pct = buyer.stakeChangePct;
  if (pct == null || !Number.isFinite(pct) || pct === 0) return "--";
  if (pct > STAKE_MULTIPLE_ABOVE) return stakeMultiple(pct);
  // Under 1% keeps a decimal, so a small trade does not read as none.
  const rounded = Math.abs(pct) < 1 ? Math.round(pct * 10) / 10 : Math.round(pct);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/** One line of the selected company's detail: an insider and what they traded. */
export interface InsiderSignalDetailLine {
  name: string;
  role: InsiderSignalRole;
  value: string;
  last: string;
  stake: string;
}

export function insiderSignalDetailLines(row: InsiderSignalRow): InsiderSignalDetailLine[] {
  return row.buyers.map((buyer) => ({
    name: formatInsiderName(buyer.name),
    role: buyer.role,
    value: formatSignalValue(buyer.value),
    last: formatSignalDay(buyer.lastBuy),
    stake: formatInsiderStakeChange(buyer),
  }));
}

/** Cells left and right of the columns, and between two of them. */
const TABLE_PADDING = 2;
const COLUMN_GAP = 1;
/** The kit widens a column to fit its header plus the sort arrow. */
const HEADER_EXTRA = 2;
/** The reasons are the point of the view; below this they would read as noise. */
const WHY_MIN = 24;

function fitWidth(texts: readonly string[], label: string, max: number): number {
  const widest = texts.reduce((width, value) => Math.max(width, displayWidth(value)), 0);
  return Math.max(displayWidth(label) + HEADER_EXTRA, Math.min(max, widest));
}

/**
 * The columns that fit `width` cells (the desktop passes its width in the
 * same cells and lets the reasons fill the rest). The reasons keep at least
 * 24 cells: when the pane runs short the company goes first, then the
 * insider count and the last trade day, so a narrow pane still reads
 * ticker, score, why and dollars. Room the reasons do not need widens the
 * company. `chips` sizes the reasons as chips (the desktop and the web),
 * else as their text.
 */
export function buildInsiderSignalColumns(
  width: number,
  rows: readonly InsiderSignalRow[],
  { side = "buy", chips = false }: { side?: InsiderSignalSide; chips?: boolean } = {},
): InsiderSignalColumn[] {
  const words = insiderSideWords(side);
  const widths = {
    ticker: fitWidth(rows.map((row) => row.ticker), "Ticker", 8),
    company: fitWidth(rows.map((row) => row.company), "Company", 20),
    score: fitWidth(rows.map((row) => String(row.score)), "Score", 5),
    insiders: fitWidth(rows.map((row) => String(row.insiders)), words.insiders, 4),
    value: fitWidth(rows.map((row) => formatSignalValue(row.value)), words.traded, 8),
    lastBuy: fitWidth(rows.map((row) => formatSignalDay(row.lastBuy)), words.last, 8),
  };
  const show = { company: true, insiders: true, lastBuy: true };
  const available = Math.max(0, Math.floor(width) - TABLE_PADDING);
  const fixed = () => [
    widths.ticker,
    show.company ? widths.company : 0,
    widths.score,
    show.insiders ? widths.insiders : 0,
    widths.value,
    show.lastBuy ? widths.lastBuy : 0,
  ].reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0);
  for (const drop of ["company", "insiders", "lastBuy"] as const) {
    if (available - fixed() - COLUMN_GAP >= WHY_MIN) break;
    show[drop] = false;
  }
  let why = Math.max(8, available - fixed() - COLUMN_GAP);
  // Room the reasons do not need goes to the company names cut at 20.
  if (show.company) {
    const needs = rows.map((row) => {
      const rowChips = insiderSignalChips(row, side);
      return chips && rowChips ? insiderSignalChipsWidth(rowChips) : displayWidth(insiderSignalWhy(row, side));
    });
    const whyNeed = Math.max(displayWidth("Why") + HEADER_EXTRA, ...needs);
    const grow = Math.max(0, Math.min(why - whyNeed, fitWidth(rows.map((row) => row.company), "Company", 32) - widths.company));
    widths.company += grow;
    why -= grow;
  }
  return [
    { id: "ticker", label: "Ticker", width: widths.ticker, align: "left" },
    ...(show.company ? [{ id: "company" as const, label: "Company", width: widths.company, align: "left" as const }] : []),
    { id: "score", label: "Score", width: widths.score, align: "right" },
    { id: "why", label: "Why", width: why, align: "left", flexGrow: 1 },
    ...(show.insiders ? [{ id: "insiders" as const, label: words.insiders, width: widths.insiders, align: "right" as const }] : []),
    { id: "value", label: words.traded, width: widths.value, align: "right" },
    ...(show.lastBuy ? [{ id: "lastBuy" as const, label: words.last, width: widths.lastBuy, align: "right" as const }] : []),
  ];
}

/** The ranking's own order breaks ties, so a sort never shuffles equal rows. */
export function compareInsiderSignalRows(a: InsiderSignalRow, b: InsiderSignalRow, columnId: InsiderSignalColumnId, side: InsiderSignalSide = "buy"): number {
  switch (columnId) {
    case "ticker": return a.ticker.localeCompare(b.ticker, "en-US");
    case "company": return a.company.localeCompare(b.company, "en-US", { sensitivity: "base" });
    case "score": return a.score - b.score;
    case "why": return insiderSignalWhy(a, side).localeCompare(insiderSignalWhy(b, side), "en-US", { sensitivity: "base" });
    case "insiders": return a.insiders - b.insiders;
    case "value": return a.value - b.value;
    case "lastBuy": return a.lastBuy.localeCompare(b.lastBuy);
  }
}

/** Text columns sort A to Z first, figures and dates largest first. */
export function insiderSignalFirstDirection(columnId: InsiderSignalColumnId): "asc" | "desc" {
  return columnId === "ticker" || columnId === "company" || columnId === "why" ? "asc" : "desc";
}
