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
import type { SortComparableValue } from "../../../utils/sort-values";
import { formatInsiderName } from "./display";
import { DEFAULT_INSIDER_SIGNAL_WINDOW, DEFAULT_INSIDER_SIGNALS_QUERY, INSIDER_SIGNAL_WINDOWS, type InsiderSignalsQuery } from "./signals-client";

export type InsiderSignalColumnId =
  | "ticker"
  | "company"
  | "score"
  | "role"
  | "nth"
  | "usual"
  | "stake"
  | "insiders"
  | "value"
  | "lastBuy";

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

/**
 * The query bar, from the roomiest to the most folded: Window
 * inline or a menu; Side as Buying and Selling, as Buy and Sell, or a menu;
 * Cluster and New (Exited) as two checkboxes, or as one Only menu. The two
 * checkboxes fold before Side does, so buying and selling stay one key or
 * click apart longest.
 */
interface InsiderSignalsBarFit {
  side: "full" | "short" | "menu";
  windowInline: boolean;
  only: boolean;
}

const BAR_FITS: readonly InsiderSignalsBarFit[] = [
  { side: "full", windowInline: true, only: false },
  { side: "full", windowInline: false, only: false },
  { side: "short", windowInline: false, only: false },
  { side: "short", windowInline: false, only: true },
  { side: "menu", windowInline: false, only: true },
];

/** Buy and Sell, for a narrow bar. */
export const INSIDER_SIGNAL_SIDE_SHORT: Record<InsiderSignalSide, string> = { buy: "Buy", sell: "Sell" };

/** The Only menu's choices: the two checkboxes folded into one control. */
export type InsiderSignalOnly = "any" | "cluster" | "position" | "both";

export function insiderSignalOnlyOptions(side: InsiderSignalSide): SelectButtonOption<InsiderSignalOnly>[] {
  const position = insiderSideWords(side).position;
  return [
    { value: "any", label: "Any" },
    { value: "cluster", label: "Cluster" },
    { value: "position", label: position },
    { value: "both", label: `Cluster and ${position.toLowerCase()}`, short: "Both" },
  ];
}

export function insiderSignalOnly(query: Pick<InsiderSignalsQuery, "cluster" | "position">): InsiderSignalOnly {
  return query.cluster ? query.position ? "both" : "cluster" : query.position ? "position" : "any";
}

/** What the bar's controls take around their words, in cells. */
interface BarMetrics {
  /** Around a menu's label and value. */
  menu: number;
  /** Beside an inline choice's label, and around each of its options. */
  stripLabel: number;
  stripOption: number;
  checkbox: number;
  clear: number;
  /** Between two controls, and at the bar's ends. */
  gap: number;
  padding: number;
  /** An inline choice shows its options' short labels. */
  shortOptions: boolean;
}

/** The terminal's QueryBar: `Label value` for a menu, ` Option ` segments, `  [x] Label` for a checkbox, `clear`, two cells between controls and one at each end. */
const TERMINAL_BAR: BarMetrics = { menu: 1, stripLabel: 1, stripOption: 2, checkbox: 6, clear: 5, gap: 2, padding: 2, shortOptions: true };
/**
 * The desktop's and the web's, in cells of 8 px with a cell for each letter
 * (they take less): a menu's padding and chevron, a choice's padding, a
 * checkbox's box and Clear, from the kit's styles and rounded up. Each
 * control holds its own spacing; inline choices show their full labels.
 */
const DESKTOP_BAR: BarMetrics = { menu: 5, stripLabel: 0, stripOption: 2.5, checkbox: 4.5, clear: 7, gap: 0, padding: 0, shortOptions: false };

/**
 * The first bar layout whose controls all fit a pane `width` cells wide with
 * this query's menus, the Cap filter when it shows, and `clear` when it
 * shows; the most folded one when none does, which the terminal cuts and the
 * desktop scrolls. A layout is measured with both checkboxes ticked and the
 * wider side's words, so ticking one or switching sides never moves the bar
 * under the pointer; another value in a menu may.
 */
export function insiderSignalsBarFit(
  width: number,
  query: InsiderSignalsQuery,
  { capShown, desktop }: { capShown: boolean; desktop: boolean },
): InsiderSignalsBarFit {
  const bar = desktop ? DESKTOP_BAR : TERMINAL_BAR;
  const widest = (labels: readonly string[]) => Math.max(...labels.map(displayWidth));
  const valueLabel = <T extends string>(options: readonly SelectButtonOption<T>[], value: T) => {
    const option = options.find((candidate) => candidate.value === value);
    return option?.short ?? option?.label ?? value;
  };
  const menu = (label: string, valueCells: number) => displayWidth(label) + bar.menu + valueCells;
  const strip = (label: string, options: readonly string[]) =>
    displayWidth(label) + bar.stripLabel + options.reduce((sum, option) => sum + displayWidth(option) + bar.stripOption, 0);
  const checkbox = (labels: readonly string[]) => bar.checkbox + widest(labels);
  const sides = ["buy", "sell"] as const;
  const shared = [
    menu("Role", displayWidth(valueLabel(INSIDER_SIGNAL_ROLE_OPTIONS, query.role))),
    menu("Min", displayWidth(valueLabel(INSIDER_SIGNAL_MIN_OPTIONS, String(query.minValue)))),
    ...(capShown ? [menu("Cap", displayWidth(valueLabel(INSIDER_SIGNAL_CAP_OPTIONS, query.cap ?? "all")))] : []),
  ];
  const narrowedMenus = [query.window !== DEFAULT_INSIDER_SIGNAL_WINDOW, query.role !== "all", query.minValue > 0, query.cap !== null].filter(Boolean).length;
  const fits = (fit: InsiderSignalsBarFit) => {
    const short = fit.side === "short" && bar.shortOptions;
    const controls = [
      fit.side === "menu"
        ? menu("Side", widest(sides.map((side) => INSIDER_SIGNAL_SIDE_SHORT[side])))
        : strip("Side", short ? sides.map((side) => INSIDER_SIGNAL_SIDE_SHORT[side]) : INSIDER_SIGNAL_SIDE_OPTIONS.map((option) => option.label)),
      fit.windowInline ? strip("Window", INSIDER_SIGNAL_WINDOW_OPTIONS.map((option) => option.label)) : menu("Window", displayWidth(`${query.window}D`)),
      ...shared,
      ...(fit.only
        ? [menu("Only", widest(sides.flatMap((side) => insiderSignalOnlyOptions(side).map((option) => option.short ?? option.label))))]
        : [checkbox(["Cluster"]), checkbox(sides.map((side) => insiderSideWords(side).position))]),
    ];
    if (narrowedMenus + (fit.only ? 1 : 2) >= 2) controls.push(bar.clear);
    return bar.padding + controls.reduce((sum, cells) => sum + cells, 0) + bar.gap * (controls.length - 1) <= width;
  };
  return BAR_FITS.find(fits) ?? BAR_FITS[BAR_FITS.length - 1]!;
}

/** Whether a query narrows the side and window it reads. */
export function insiderSignalsFiltered(query: InsiderSignalsQuery): boolean {
  return query.role !== "all" || query.minValue > 0 || query.cluster || query.position || query.cap !== null;
}

/** What a cell shows without a fact: no history, no balance, or a book traded both ways. */
export const INSIDER_SIGNAL_NONE = "--";
/**
 * After a stake counted on the net of an insider's buys and sales, drawn
 * muted: bought and sold. One cell in every monospace font; an arrow pair
 * falls back to a font that draws it a fraction of the size.
 */
export const INSIDER_BOTH_WAYS_MARK = "\u00b1";

/**
 * What a column says about one insider: its words, the figure it sorts and
 * exports by, and how it reads. `weight` keeps the colour roles the why
 * chips had: "signal" in the side's tone for a fact the ranking counts (a
 * 2nd trade or more in 90 days, twice the usual size or more) and in its
 * sign's tone for a change in the holding, "strong" for NEW and EXITED,
 * "plain" for a figure the ranking does not count (a 1st trade, a size
 * under twice the usual), "none" for the dash.
 */
export interface InsiderSignalFact {
  text: string;
  /** Larger reads stronger; null without a fact, which sorts last either way. */
  sort: number | null;
  /** What an export writes: the figure (12, 2.8, 29), NEW or EXITED; null for the dash. */
  value: number | string | null;
  weight: "strong" | "signal" | "plain" | "none";
  /** Which way a holding moved, so a stake reads in the buy or sell tone by its sign, not the side's. */
  sign?: 1 | -1;
  /** Counted on the net of buys and sales: the stake carries INSIDER_BOTH_WAYS_MARK. */
  bothWays?: boolean;
}

/** From where the ranking counts a repeat (repeatPoints) and a size against the usual (usualMinRatio). */
const REPEAT_COUNTED_FROM = 2;
const USUAL_COUNTED_FROM = 2;
/** The ranking holds a size against the usual at most this many times ("100x+"). */
const USUAL_CAP = 100;
/** A stake raise above this, in percent, is said as the holding's multiple. */
const STAKE_MULTIPLE_ABOVE = 300;

const NO_FACT: InsiderSignalFact = { text: INSIDER_SIGNAL_NONE, sort: null, value: null, weight: "none" };

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[value % 10] ?? "th";
  return `${value}${suffix}`;
}

/** A raise in percent as the holding's multiple: +500% is "6x". */
function stakeMultiple(pct: number): string {
  const multiple = 1 + pct / 100;
  return multiple >= 10 ? `${Math.round(multiple)}x` : `${(Math.round(multiple * 10) / 10).toString()}x`;
}

const known = (value: number | null | undefined): value is number => value != null && Number.isFinite(value);

/** An insider's nth trade in 90 days: "12th"; the dash without one. */
export function formatInsiderNth(nth: number | null | undefined): string {
  return known(nth) && nth >= 1 ? ordinal(Math.round(nth)) : INSIDER_SIGNAL_NONE;
}

/** A size against the usual: "2.8x", "5x", "22x", "100x+", "<0.1x" (the server says it to a tenth); the dash without history. */
export function formatInsiderUsual(ratio: number | null | undefined): string {
  if (!known(ratio) || ratio < 0) return INSIDER_SIGNAL_NONE;
  if (ratio >= USUAL_CAP) return `${USUAL_CAP}x+`;
  if (ratio >= 10) return `${Math.round(ratio)}x`;
  if (ratio < 0.1) return "<0.1x";
  return `${(Math.round(ratio * 10) / 10).toString()}x`;
}

/** What a holding did: the change in percent, NEW or EXITED, or null without balances. */
export type InsiderStakeValue = number | "NEW" | "EXITED" | null;

/** An insider's stake as its value: what the stake column sorts, exports and prints from. */
export function insiderStakeValue(buyer: InsiderSignalBuyer): InsiderStakeValue {
  if (buyer.exited) return "EXITED";
  if (buyer.newPosition) return "NEW";
  const pct = buyer.stakeChangePct;
  return known(pct) && pct !== 0 ? pct : null;
}

/**
 * A stake as text: NEW or EXITED, +29%, -58%, 6x above +300%, a decimal
 * under 1% so a small trade does not read as none, the dash without
 * balances. Counted on the net of buys and sales, it ends in the both-ways
 * mark.
 */
export function formatInsiderStake(stake: InsiderStakeValue, bothWays = false): string {
  let text: string;
  if (typeof stake === "string") text = stake;
  else if (!known(stake) || stake === 0) text = INSIDER_SIGNAL_NONE;
  else if (stake > STAKE_MULTIPLE_ABOVE) text = stakeMultiple(stake);
  else {
    const rounded = Math.abs(stake) < 1 ? Math.round(stake * 10) / 10 : Math.round(stake);
    text = `${rounded > 0 ? "+" : ""}${rounded}%`;
  }
  return bothWays ? `${text} ${INSIDER_BOTH_WAYS_MARK}` : text;
}

/** A server that predates the buyer's own figures said them only as the insider's why facts. */
function whyFigure(row: InsiderSignalRow | undefined, buyer: InsiderSignalBuyer, kind: "repeat" | "usual"): number | null {
  const signal = row?.whySignals?.find((candidate) => candidate.kind === kind && candidate.insider?.name === buyer.name);
  return signal ? signal.value : null;
}

/** The insider's nth buy (sale) in 90 days, from the buyer or, from an older server, the row's why facts. */
export function insiderNth(buyer: InsiderSignalBuyer, row?: InsiderSignalRow): number | null {
  const nth = buyer.repeatBuys === undefined ? whyFigure(row, buyer, "repeat") : buyer.repeatBuys;
  return known(nth) && nth >= 1 ? nth : null;
}

/** The insider's largest day against their usual size, from the buyer or, from an older server, the row's why facts. */
export function insiderUsualRatio(buyer: InsiderSignalBuyer, row?: InsiderSignalRow): number | null {
  const ratio = buyer.usualRatio === undefined ? whyFigure(row, buyer, "usual") : buyer.usualRatio;
  return known(ratio) && ratio >= 0 ? ratio : null;
}

/** The insider's nth buy (sale) in 90 days: "12th"; the dash for a book traded both ways. */
function insiderNthFact(buyer: InsiderSignalBuyer, row?: InsiderSignalRow): InsiderSignalFact {
  const nth = insiderNth(buyer, row);
  if (nth == null) return NO_FACT;
  return { text: formatInsiderNth(nth), sort: nth, value: nth, weight: nth >= REPEAT_COUNTED_FROM ? "signal" : "plain" };
}

/** The insider's largest day against their usual size: "2.8x", "100x+"; the dash without the history. */
function insiderUsualFact(buyer: InsiderSignalBuyer, row?: InsiderSignalRow): InsiderSignalFact {
  const ratio = insiderUsualRatio(buyer, row);
  if (ratio == null) return NO_FACT;
  return { text: formatInsiderUsual(ratio), sort: ratio, value: ratio, weight: ratio >= USUAL_COUNTED_FROM ? "signal" : "plain" };
}

/**
 * The insider's change in the holding, with the both-ways mark when it was
 * counted on the net of buys and sales. Sorted by how far the holding
 * moved: NEW above every raise (buying), EXITED as a 100% cut (selling).
 */
export function insiderStakeFact(buyer: InsiderSignalBuyer): InsiderSignalFact {
  const stake = insiderStakeValue(buyer);
  const bothWays = buyer.twoWay === true;
  const text = formatInsiderStake(stake, bothWays);
  const marked = bothWays ? { bothWays } : {};
  if (stake === null) return { ...NO_FACT, text, ...marked };
  if (typeof stake === "string") {
    const isNew = stake === "NEW";
    return { text, sort: isNew ? Number.MAX_SAFE_INTEGER : 100, value: stake, weight: "strong", sign: isNew ? 1 : -1, ...marked };
  }
  return { text, sort: Math.abs(stake), value: stake, weight: "signal", sign: stake > 0 ? 1 : -1, ...marked };
}

/**
 * Why, as the server's sentences: what exports and scripts read as `why`.
 * The pane and the text report say it as columns.
 */
export function insiderSignalWhy(row: Pick<InsiderSignalRow, "reasons">): string {
  return row.reasons.join(" · ");
}

/** The insider a row's columns speak for: the one with the most dollars (the ranking lists them largest first). */
export function insiderSignalLead(row: InsiderSignalRow): InsiderSignalBuyer | null {
  return row.buyers[0] ?? null;
}

/** The lead insider's role, and how many others traded: "Director +1". */
export function insiderSignalRoleText(row: InsiderSignalRow): string {
  const lead = insiderSignalLead(row);
  if (!lead) return INSIDER_SIGNAL_NONE;
  const others = Math.max(0, row.insiders - 1);
  return others ? `${lead.role} +${others}` : lead.role;
}

/** The row's insider columns: the lead insider's role, nth trade, size against usual and stake. */
export interface InsiderSignalRowFacts {
  role: string;
  nth: InsiderSignalFact;
  usual: InsiderSignalFact;
  stake: InsiderSignalFact;
}

export function insiderSignalRowFacts(row: InsiderSignalRow): InsiderSignalRowFacts {
  const lead = insiderSignalLead(row);
  return {
    role: insiderSignalRoleText(row),
    nth: lead ? insiderNthFact(lead, row) : NO_FACT,
    usual: lead ? insiderUsualFact(lead, row) : NO_FACT,
    stake: lead ? insiderStakeFact(lead) : NO_FACT,
  };
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

/** The opened company's title: its ticker and name, said once. */
export function insiderSignalDetailTitle(row: Pick<InsiderSignalRow, "ticker" | "company">): string {
  return `${row.ticker} \u00b7 ${row.company}`;
}

/** One figure of the opened company, for its `StatGrid` and the CLI's line over its insiders. */
export interface InsiderSignalFigure {
  id: string;
  label: string;
  value: string;
  detail?: string;
  tone?: "positive" | "negative";
}

/**
 * The opened company's figures, each said once: its score, the dollars and
 * shares, how many insiders on how many days, the window and the first
 * trade in it, the last trade and when it was filed, and the market value where
 * the server stores it. What each insider did is the table under them.
 */
export function insiderSignalFigures(row: InsiderSignalRow, window: number, side: InsiderSignalSide): InsiderSignalFigure[] {
  const words = insiderSideWords(side);
  const days = `${row.buys} ${side === "sell" ? "sale" : "buy"} ${row.buys === 1 ? "day" : "days"}`;
  return [
    { id: "score", label: "Score", value: String(row.score) },
    {
      id: "value",
      label: words.traded,
      value: formatSignalValue(row.value),
      detail: `${formatCompact(Math.round(row.shares))} shares`,
      tone: side === "sell" ? "negative" : "positive",
    },
    { id: "insiders", label: words.insiders, value: String(row.insiders), detail: days },
    { id: "window", label: "Window", value: `${window}D`, detail: `first ${side === "sell" ? "sale" : "buy"} ${formatSignalDay(row.firstBuy)}` },
    { id: "last", label: words.last, value: formatSignalDay(row.lastBuy), detail: `filed ${formatSignalDay(row.lastFiled)}` },
    ...(row.marketCap != null && row.marketCap > 0 ? [{
      id: "cap",
      label: "Market cap",
      value: formatSignalValue(row.marketCap),
      detail: `${formatSharePct(row.value / row.marketCap)} ${words.traded.toLowerCase()}`,
    }] : []),
  ];
}

/** A part of a company, in percent: 0.42%, 3.1%, 12%, and <0.01% for less than rounds to. */
function formatSharePct(ratio: number): string {
  const pct = ratio * 100;
  if (pct < 0.01) return "<0.01%";
  return `${pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** One line of the opened company's insiders: an insider, in the ranking's columns. */
export interface InsiderSignalDetailLine {
  buyer: InsiderSignalBuyer;
  name: string;
  role: InsiderSignalRole;
  nth: InsiderSignalFact;
  usual: InsiderSignalFact;
  stake: InsiderSignalFact;
  value: string;
  last: string;
}

export function insiderSignalDetailLines(row: InsiderSignalRow): InsiderSignalDetailLine[] {
  return row.buyers.map((buyer) => ({
    buyer,
    name: formatInsiderName(buyer.name),
    role: buyer.role,
    nth: insiderNthFact(buyer, row),
    usual: insiderUsualFact(buyer, row),
    stake: insiderStakeFact(buyer),
    value: formatSignalValue(buyer.value),
    last: formatSignalDay(buyer.lastBuy),
  }));
}

export type InsiderSignalDetailColumnId = "name" | "role" | "nth" | "usual" | "stake" | "value" | "lastBuy";
export type InsiderSignalDetailColumn = DataTableColumn & { id: InsiderSignalDetailColumnId };

/**
 * The opened company's insider columns, the ranking's in the same order:
 * name, role, nth trade, size against usual, stake, dollars and last trade
 * day. The name takes the room left; below 12 cells the size against usual
 * goes, then the nth trade, then the last trade day, as the ranking drops
 * them, so a phone keeps the dollars whole.
 */
export function buildInsiderSignalDetailColumns(
  width: number,
  lines: readonly InsiderSignalDetailLine[],
  { side = "buy" }: { side?: InsiderSignalSide } = {},
): InsiderSignalDetailColumn[] {
  const words = insiderSideWords(side);
  const widths = {
    role: fitWidth(lines.map((line) => line.role), "Role", 16),
    nth: fitWidth(lines.map((line) => line.nth.text), "Nth", 6),
    usual: fitWidth(lines.map((line) => line.usual.text), "Vs Usual", 6),
    stake: fitWidth(lines.map((line) => line.stake.text), "Stake", 10),
    value: fitWidth(lines.map((line) => line.value), words.traded, 8),
    lastBuy: fitWidth(lines.map((line) => line.last), words.last, 8),
  };
  const show = { usual: true, nth: true, lastBuy: true };
  const available = Math.max(0, Math.floor(width) - TABLE_PADDING);
  const room = () => available - [
    widths.role,
    show.nth ? widths.nth : 0,
    show.usual ? widths.usual : 0,
    widths.stake,
    widths.value,
    show.lastBuy ? widths.lastBuy : 0,
  ].reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0);
  for (const drop of ["usual", "nth", "lastBuy"] as const) {
    if (room() >= COMPANY_MIN) break;
    show[drop] = false;
  }
  return [
    { id: "name", label: "Insider", width: Math.max(COMPANY_MIN, room()), align: "left", flexGrow: 1 },
    { id: "role", label: "Role", width: widths.role, align: "left" },
    ...(show.nth ? [{ id: "nth" as const, label: "Nth", width: widths.nth, align: "right" as const }] : []),
    ...(show.usual ? [{ id: "usual" as const, label: "Vs Usual", width: widths.usual, align: "right" as const }] : []),
    { id: "stake", label: "Stake", width: widths.stake, align: "right" },
    { id: "value", label: words.traded, width: widths.value, align: "right" },
    ...(show.lastBuy ? [{ id: "lastBuy" as const, label: words.last, width: widths.lastBuy, align: "right" as const }] : []),
  ];
}

/** What an insider column sorts by, as the ranking's columns do. */
export function insiderSignalDetailSortValue(line: InsiderSignalDetailLine, columnId: InsiderSignalDetailColumnId): SortComparableValue {
  switch (columnId) {
    case "name": return line.name.toLocaleLowerCase("en-US");
    case "role": return line.role;
    case "nth": return line.nth.sort;
    case "usual": return line.usual.sort;
    case "stake": return line.stake.sort;
    case "value": return line.buyer.value;
    case "lastBuy": return line.buyer.lastBuy;
  }
}

/** Names and roles sort A to Z first, figures and dates largest first. */
export function insiderSignalDetailFirstDirection(columnId: InsiderSignalDetailColumnId): "asc" | "desc" {
  return columnId === "name" || columnId === "role" ? "asc" : "desc";
}

/** Cells left and right of the columns, and between two of them. */
const TABLE_PADDING = 2;
const COLUMN_GAP = 1;
/** The kit widens a column to fit its header plus the sort arrow. */
const HEADER_EXTRA = 2;
/** Below this the company names read as stubs: the column goes instead. */
const COMPANY_MIN = 12;

function fitWidth(texts: readonly string[], label: string, max: number): number {
  const widest = texts.reduce((width, value) => Math.max(width, displayWidth(value)), 0);
  return Math.max(displayWidth(label) + HEADER_EXTRA, Math.min(max, widest));
}

/** The columns a narrow pane gives up, first to last: the lead insider's size against usual and nth trade, then as before. */
const NARROW_DROPS = ["usual", "nth", "company", "insiders", "lastBuy"] as const;

/**
 * The columns that fit `width` cells (the desktop passes its width in the
 * same cells): ticker, company, score, then the lead insider's role, nth
 * trade, size against usual and stake, then the insiders, dollars and last
 * trade day. When the pane runs short, the size against usual goes first,
 * then the nth trade, then the company (below 12 cells), the insider count
 * and the last trade day, so a narrow pane still reads ticker, score, role,
 * stake and dollars. The company takes the room left, the role when the
 * company is gone.
 */
export function buildInsiderSignalColumns(
  width: number,
  rows: readonly InsiderSignalRow[],
  { side = "buy" }: { side?: InsiderSignalSide } = {},
): InsiderSignalColumn[] {
  const words = insiderSideWords(side);
  const facts = rows.map(insiderSignalRowFacts);
  const widths = {
    ticker: fitWidth(rows.map((row) => row.ticker), "Ticker", 8),
    score: fitWidth(rows.map((row) => String(row.score)), "Score", 5),
    role: fitWidth(facts.map((fact) => fact.role), "Role", 16),
    nth: fitWidth(facts.map((fact) => fact.nth.text), "Nth", 6),
    usual: fitWidth(facts.map((fact) => fact.usual.text), "Vs Usual", 6),
    stake: fitWidth(facts.map((fact) => fact.stake.text), "Stake", 10),
    insiders: fitWidth(rows.map((row) => String(row.insiders)), words.insiders, 4),
    value: fitWidth(rows.map((row) => formatSignalValue(row.value)), words.traded, 8),
    lastBuy: fitWidth(rows.map((row) => formatSignalDay(row.lastBuy)), words.last, 8),
  };
  const show = { usual: true, nth: true, company: true, insiders: true, lastBuy: true };
  const available = Math.max(0, Math.floor(width) - TABLE_PADDING);
  const fixed = () => [
    widths.ticker,
    widths.score,
    widths.role,
    show.nth ? widths.nth : 0,
    show.usual ? widths.usual : 0,
    widths.stake,
    show.insiders ? widths.insiders : 0,
    widths.value,
    show.lastBuy ? widths.lastBuy : 0,
  ].reduce((sum, columnWidth) => sum + (columnWidth > 0 ? columnWidth + COLUMN_GAP : 0), 0) - COLUMN_GAP;
  const room = () => available - fixed() - (show.company ? COLUMN_GAP : 0);
  for (const drop of NARROW_DROPS) {
    if (room() >= (show.company ? COMPANY_MIN : 0)) break;
    show[drop] = false;
  }
  const left = Math.max(0, room());
  const company = Math.max(COMPANY_MIN, left);
  // Wider than the names need, the company still takes the rest, so the figures sit at the pane's right edge.
  const role = show.company ? widths.role : widths.role + left;
  return [
    { id: "ticker", label: "Ticker", width: widths.ticker, align: "left" },
    ...(show.company ? [{ id: "company" as const, label: "Company", width: company, align: "left" as const, flexGrow: 1 }] : []),
    { id: "score", label: "Score", width: widths.score, align: "right" },
    { id: "role", label: "Role", width: role, align: "left", ...(show.company ? {} : { flexGrow: 1 }) },
    ...(show.nth ? [{ id: "nth" as const, label: "Nth", width: widths.nth, align: "right" as const }] : []),
    ...(show.usual ? [{ id: "usual" as const, label: "Vs Usual", width: widths.usual, align: "right" as const }] : []),
    { id: "stake", label: "Stake", width: widths.stake, align: "right" },
    ...(show.insiders ? [{ id: "insiders" as const, label: words.insiders, width: widths.insiders, align: "right" as const }] : []),
    { id: "value", label: words.traded, width: widths.value, align: "right" },
    ...(show.lastBuy ? [{ id: "lastBuy" as const, label: words.last, width: widths.lastBuy, align: "right" as const }] : []),
  ];
}

/** What a column sorts a row by: the shared sort puts a missing fact last either way, and the ranking's order breaks ties. */
export function insiderSignalSortValue(row: InsiderSignalRow, columnId: InsiderSignalColumnId): SortComparableValue {
  switch (columnId) {
    case "ticker": return row.ticker;
    case "company": return row.company.toLocaleLowerCase("en-US");
    case "score": return row.score;
    // By role, then by how many others traded: Director, Director +1, Director +12.
    case "role": {
      const lead = insiderSignalLead(row);
      return lead ? `${lead.role} ${String(Math.max(0, row.insiders - 1)).padStart(4, "0")}` : null;
    }
    case "nth": return insiderSignalRowFacts(row).nth.sort;
    case "usual": return insiderSignalRowFacts(row).usual.sort;
    case "stake": return insiderSignalRowFacts(row).stake.sort;
    case "insiders": return row.insiders;
    case "value": return row.value;
    case "lastBuy": return row.lastBuy;
  }
}

/** Text columns sort A to Z first, figures and dates largest first. */
export function insiderSignalFirstDirection(columnId: InsiderSignalColumnId): "asc" | "desc" {
  return columnId === "ticker" || columnId === "company" || columnId === "role" ? "asc" : "desc";
}
