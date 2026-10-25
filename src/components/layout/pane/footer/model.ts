import type { ContextMenuItem } from "../../../../types/context-menu";
import { t } from "../../../../i18n";
import { clipToDisplayWidth, displayWidth } from "../../../../utils/format";
import { formatShortDate } from "../../../../utils/datetime-format";
import { getShortcutHintWidth } from "../../../ui/shortcut-hint";

export interface PaneFooterRegistration {
  order?: number;
  info?: PaneFooterSegment[];
  hints?: PaneHint[];
  /**
   * Extra entries for the pane menu (the "..." button, `.`), for actions that
   * have no footer key of their own: sort a table, change a filter, close a
   * tab. The menu already lists every hint, so do not repeat those here.
   */
  menu?: ContextMenuItem[];
  /**
   * Keys bound while the pane is focused but not drawn in the footer, for an
   * action that already shows its key where it sits (an empty state's button).
   */
  keys?: PaneHint[];
}

export interface PaneFooterSegment {
  id: string;
  parts: PaneFooterPart[];
  /**
   * Desktop affordance; parts retain the terminal representation. `clock` is
   * data a source delivers late: build it with {@link delayedFooterSegment}.
   */
  icon?: "warning" | "clock";
  /**
   * The segment only dates the pane's data (`as of 2026-10-05`). A `gloomberb
   * shot` whose status line already dates that data leaves it out, so the
   * date is not said twice, and gives it up before its status line is cut.
   * A segment that reads `as of <date>` is one without saying so; set it for
   * a segment worded another way (`holdings 2026-06-30`).
   */
  asOf?: boolean;
  /**
   * The segment only says how current the pane's quotes are (`2026-10-09 ·
   * 15m delayed`), which a `gloom shot` status line says too: a shot whose
   * line states its data's date and delay leaves it out.
   */
  quoteStatus?: boolean;
  /**
   * The segment says what the rows leave out (releases a filter hides), which
   * a picture of the rows cannot: a `gloom shot` keeps it, as it keeps a
   * warning.
   */
  capture?: boolean;
  /**
   * Shorter forms of `parts`, longest first. When the row is too narrow for
   * `parts` beside the hints, it shows the first that fits, or the last, and
   * keeps the full text as the segment's title.
   */
  variants?: PaneFooterPart[][];
  label?: string;
  title?: string;
  shortcut?: string;
  onPress?: () => void;
  disabled?: boolean;
}

/** The terminal's mark for data that arrives late, as quote ages carry it (`◷15s`). */
const DELAYED_FOOTER_GLYPH = "◷";

/**
 * The footer's one form for data a source delivers late: a yellow clock with
 * `detail` in its tooltip on the desktop, and the clock with the delay
 * (`◷15m`) in the terminal, which has no tooltip, so it takes a few cells
 * rather than a phrase. `onPress` makes it a button, such as an upgrade.
 */
export function delayedFooterSegment({
  id,
  detail,
  delay,
  onPress,
  quoteStatus,
}: {
  id: string;
  /** What is late and by how much, in words: the tooltip and the accessible name. */
  detail: string;
  /** How late, when known (`15m`, `12h`); the terminal draws it after the clock. */
  delay?: string;
  onPress?: () => void;
  quoteStatus?: boolean;
}): PaneFooterSegment {
  return {
    id,
    icon: "clock",
    label: detail,
    title: detail,
    parts: [{ text: `${DELAYED_FOOTER_GLYPH}${delay ?? ""}`, tone: "warning" }],
    ...(onPress ? { onPress } : {}),
    ...(quoteStatus ? { quoteStatus } : {}),
  };
}

/**
 * The footer's one form for data shown from a copy saved earlier because
 * refreshing it failed (offline, a hung or refused proxy): `saved copy from
 * 14:37`, or with its day when saved on another. It says how current the
 * pane's quotes are, so it is a quote status.
 */
export function savedCopyFooterSegment(id: string, savedAt: number, now = Date.now()): PaneFooterSegment {
  const saved = new Date(savedAt);
  const time = saved.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const when = saved.toDateString() === new Date(now).toDateString() ? time : `${formatShortDate(saved, { year: false })} ${time}`;
  const text = `${t("saved copy from")} ${when}`;
  return {
    id,
    quoteStatus: true,
    title: `${t("Couldn't refresh")}: ${text}`,
    parts: [{ text, tone: "warning" }],
    variants: [[{ text: t("saved copy"), tone: "warning" }]],
  };
}

/** A pane whose market data is all delayed, by no one figure: the clock alone, its tooltip saying so. */
export const DELAYED_SEGMENT: PaneFooterSegment = delayedFooterSegment({ id: "delayed", detail: "Delayed market data" });

/** A status that opens with how late its data is: `15m delayed`, `mixed real-time and delayed`, `delayed`. */
const DELAYED_LEAD = /^(\d+[smhd] delayed|mixed real-time and delayed|delayed)(?: · |$)/;

/**
 * A status segment whose text opens with how late its data is (`15m delayed ·
 * as of 14:47 UTC`) as the footer's clock (see {@link delayedFooterSegment})
 * and the rest of its text; any other segment as it is.
 */
export function splitDelayedStatus(segment: PaneFooterSegment): PaneFooterSegment[] {
  const [first, ...more] = segment.parts;
  const match = first ? DELAYED_LEAD.exec(first.text) : null;
  if (!first || !match) return [segment];
  const lead = match[1]!;
  const clock = delayedFooterSegment({
    id: `${segment.id}-delay`,
    detail: lead,
    delay: /^\d/.test(lead) ? lead.slice(0, lead.indexOf(" ")) : undefined,
    quoteStatus: segment.quoteStatus,
  });
  const rest = first.text.slice(match[0].length);
  const parts = rest ? [{ ...first, text: rest }, ...more] : more;
  return parts.length ? [clock, { ...segment, parts }] : [clock];
}

/** Whether the segment only dates the pane's data: marked `asOf`, or reading `as of <date>`. */
export function datesPaneData(segment: Pick<PaneFooterSegment, "asOf" | "parts">): boolean {
  return segment.asOf ?? /^as of\b/i.test(segment.parts[0]?.text ?? "");
}

export interface PaneFooterPressEvent {
  pixelX?: number;
  pixelY?: number;
  stopPropagation?: () => void;
  preventDefault?: () => void;
}

export interface PaneFooterPart {
  text: string;
  tone?: "label" | "value" | "muted" | "positive" | "negative" | "warning";
  color?: string;
  bold?: boolean;
}

export interface PaneHint {
  id: string;
  key: string;
  label: string;
  /**
   * The action's full name in the pane menu. Defaults to the hint read as one
   * word (`[a]dd` is "Add"); set it when the key is not the first letter.
   */
  title?: string;
  onPress?: (event?: PaneFooterPressEvent) => void;
  disabled?: boolean;
  /**
   * For a hint a shared component adds to whatever pane hosts it, such as a
   * chart's `p` pin: the pane's own hints and keys come first. While another
   * one in the pane takes the same key, this one leaves the footer and is
   * listed in the pane menu without a key.
   */
  yieldsKey?: boolean;
}

export interface CombinedPaneFooter {
  info: PaneFooterSegment[];
  hints: PaneHint[];
  menu: ContextMenuItem[];
  keys: PaneHint[];
}

export const EMPTY_FOOTER: CombinedPaneFooter = { info: [], hints: [], menu: [], keys: [] };

/**
 * Status the hints leave room for, more when it is a warning: a failure must
 * stay readable. A status no longer than the warning's room is kept whole,
 * with the hints that no longer fit under More, so a status word is never cut
 * against them ("Cloud sync d [a]dd event"); a longer one gives way to the hints.
 */
const INFO_FLOOR_CHARS = 10;
const WARNING_FLOOR_CHARS = 24;
const HINT_GAP = 1;

function paneHintWidth(hint: Pick<PaneHint, "key" | "label">, prefix = ""): number {
  return getShortcutHintWidth(hint.key, hint.label, prefix);
}

export function totalHintsWidth(hints: readonly Pick<PaneHint, "key" | "label">[]): number {
  return hints.reduce((total, hint, index) => total + paneHintWidth(hint, index > 0 ? " " : ""), 0);
}

function infoTextWidth(segments: readonly PaneFooterSegment[]): number {
  if (segments.length === 0) return 0;
  return segments.reduce((total, segment, index) => {
    const text = segment.parts.reduce((sum, part, partIndex) => (
      sum + (partIndex > 0 ? 1 : 0) + displayWidth(part.text)
    ), 0);
    return total + (index > 0 ? 1 : 0) + text;
  }, 0);
}

/**
 * The info segments as they fit `width`: segments with `variants` step down
 * together, one variant at a time, until the row fits or none is left.
 */
export function fitPaneFooterInfo(info: PaneFooterSegment[], width: number, { besideHints = true }: { besideHints?: boolean } = {}): PaneFooterSegment[] {
  const stages = Math.max(0, ...info.map((segment) => segment.variants?.length ?? 0));
  let fitted = info;
  for (let stage = 0; stage < stages && infoTextWidth(fitted) > width; stage += 1) {
    fitted = info.map((segment) => {
      const variants = segment.variants ?? [];
      return variants.length ? {
        ...segment,
        title: segment.title ?? segment.parts.map((part) => part.text).join(" "),
        parts: variants[Math.min(stage, variants.length - 1)]!,
      } : segment;
    });
  }
  // A trailing status cut mid-word reads as part of the hints beside it ("quote 12h t[x] put"): one that does not
  // fit ends in an ellipsis a column short of them, or is left out when less than half of it would show. A
  // warning, an icon or a pressable segment stays as it is, clipped by the row if it must be. With no hints beside it
  // (a pane picture's footer), the row clips it, so a frame that fits its own status line sees it overflow.
  while (besideHints && fitted.length > 1 && infoTextWidth(fitted) > width) {
    const last = fitted.at(-1)!;
    if (last.icon || last.onPress || last.parts.some((part) => part.tone === "warning" || part.tone === "negative")) break;
    const room = width - infoTextWidth(fitted.slice(0, -1)) - 2;
    if (room * 2 >= infoTextWidth([last])) return [...fitted.slice(0, -1), clipSegment(last, room)];
    fitted = fitted.slice(0, -1);
  }
  return fitted;
}

/** A segment cut to `width` behind an ellipsis, each part keeping its tone; the full text stays as its title. */
function clipSegment(segment: PaneFooterSegment, width: number): PaneFooterSegment {
  const full = segment.parts.map((part) => part.text).join(" ");
  const clipped = clipToDisplayWidth(full, width);
  if (clipped === full) return segment;
  const body = clipped.slice(0, -1);
  const parts: PaneFooterPart[] = [];
  let offset = 0;
  for (const part of segment.parts) {
    if (offset >= body.length) break;
    parts.push({ ...part, text: body.slice(offset, offset + part.text.length) });
    offset += part.text.length + 1;
  }
  const last = parts.at(-1);
  if (!last) return { ...segment, title: segment.title ?? full, parts: [{ ...segment.parts[0]!, text: clipped }] };
  parts[parts.length - 1] = { ...last, text: `${last.text}…` };
  return { ...segment, title: segment.title ?? full, parts };
}

function moreControl(budget: number): { label: string; width: number } {
  const label = t("More");
  const width = displayWidth(label) + 2;
  if (budget >= width) return { label, width };
  const short = "…";
  return { label: short, width: Math.min(Math.max(0, budget), displayWidth(short) + 2) };
}

export interface PaneFooterHintRow {
  hints: PaneHint[];
  overflow: PaneHint[];
  moreLabel: string;
  moreWidth: number;
  hintsWidth: number;
  infoWidth: number;
}

/** Hints that fit this footer row, and the rest, which a More control owns. */
export function layoutPaneFooterHintRow(
  footer: CombinedPaneFooter,
  contentWidth: number,
  iconReserve = 0,
): PaneFooterHintRow {
  const width = Math.max(0, Math.floor(contentWidth));
  const hints = footer.hints.filter((hint) => !hint.disabled);
  const warning = footer.info.some((segment) => segment.parts.some((part) => part.tone === "warning" || part.tone === "negative"));
  const infoChars = infoTextWidth(footer.info);
  const textFloor = footer.info.length === 0 ? 0
    : warning || infoChars <= WARNING_FLOOR_CHARS ? Math.min(WARNING_FLOOR_CHARS, infoChars)
    : INFO_FLOOR_CHARS;
  const infoFloor = Math.min(width, Math.max(iconReserve, textFloor));
  const hintBudget = Math.max(0, width - infoFloor - (infoFloor > 0 && hints.length > 0 ? 1 : 0));
  const more = moreControl(hintBudget);
  let visible = hints;
  let overflow: PaneHint[] = [];
  if (totalHintsWidth(hints) > hintBudget) {
    const room = Math.max(0, hintBudget - more.width - (more.width > 0 ? HINT_GAP : 0));
    visible = [];
    let used = 0;
    for (const hint of hints) {
      const next = used + (visible.length > 0 ? HINT_GAP : 0) + paneHintWidth(hint);
      if (next > room) break;
      visible.push(hint);
      used = next;
    }
    overflow = hints.slice(visible.length);
  }
  const hintsWidth = overflow.length > 0
    ? totalHintsWidth(visible) + (visible.length > 0 ? HINT_GAP : 0) + more.width
    : totalHintsWidth(visible);
  return {
    hints: visible,
    overflow,
    moreLabel: more.label,
    moreWidth: more.width,
    hintsWidth,
    infoWidth: Math.max(0, width - hintsWidth),
  };
}

/** The name a hint goes by in the pane menu: `[a]dd` is "Add", `[r]efresh` is "Refresh". */
export function paneHintTitle(hint: Pick<PaneHint, "key" | "label" | "title">): string {
  if (hint.title) return hint.title;
  const label = hint.label.trim();
  const key = hint.key;
  const joined = key.length === 1 && /^[a-z]$/i.test(key) && /^[a-z]/.test(hint.label)
    && !label.toLowerCase().startsWith(key.toLowerCase())
    ? `${key}${label}`
    : label;
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export function hasPaneFooterContent(footer?: CombinedPaneFooter | null): boolean {
  if (!footer) return false;
  return footer.info.length > 0 || footer.hints.some((hint) => !hint.disabled);
}

export function combinePaneFooterRegistrations(registrations: Map<string, PaneFooterRegistration>): CombinedPaneFooter {
  if (registrations.size === 0) return EMPTY_FOOTER;

  const ordered = Array.from(registrations.entries()).sort(([idA, a], [idB, b]) => {
    const orderDelta = (a.order ?? 0) - (b.order ?? 0);
    return orderDelta || idA.localeCompare(idB);
  });

  const info: PaneFooterSegment[] = [];
  const hints: PaneHint[] = [];
  const menu: ContextMenuItem[] = [];
  const keys: PaneHint[] = [];
  for (const [id, registration] of ordered) {
    if (registration.info) info.push(...registration.info);
    if (registration.hints) hints.push(...registration.hints);
    if (registration.keys) keys.push(...registration.keys);
    if (registration.menu?.length) {
      if (menu.length > 0) menu.push({ type: "divider", id: `${id}:divider` });
      menu.push(...registration.menu);
    }
  }

  // A key a pane holds but has turned off does nothing, so it takes nothing.
  const taken = new Set([...hints, ...keys].flatMap((hint) => hint.yieldsKey || hint.disabled ? [] : [hint.key]));
  const yielded = hints.filter((hint) => hint.yieldsKey && taken.has(hint.key));
  if (yielded.length > 0) {
    if (menu.length > 0) menu.push({ type: "divider", id: "yielded-hints:divider" });
    for (const hint of yielded) {
      const onPress = hint.onPress;
      if (!hint.disabled && onPress) menu.push({ id: `pane-hint:${hint.id}`, label: paneHintTitle(hint), onSelect: () => onPress() });
    }
  }
  const shown = yielded.length > 0 ? hints.filter((hint) => !yielded.includes(hint)) : hints;

  if (info.length === 0 && shown.length === 0 && menu.length === 0 && keys.length === 0) return EMPTY_FOOTER;
  return { info, hints: shown, menu, keys };
}

function sameFooterParts(left: PaneFooterPart[], right: PaneFooterPart[]): boolean {
  return left.length === right.length && left.every((part, index) => {
    const other = right[index];
    return !!other
      && part.text === other.text
      && part.tone === other.tone
      && part.color === other.color
      && part.bold === other.bold;
  });
}

function sameMenuItems(left: ContextMenuItem[], right: ContextMenuItem[]): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index]!;
    if (item.type === "divider" || other.type === "divider") return item.type === other.type;
    return item.id === other.id
      && item.label === other.label
      && item.checked === other.checked
      && item.enabled === other.enabled
      && item.hidden === other.hidden
      && item.accelerator === other.accelerator
      && !!item.submenu === !!other.submenu
      && (!item.submenu || sameMenuItems(item.submenu, other.submenu ?? []));
  });
}

export function samePaneFooterRegistration(
  left: PaneFooterRegistration | null,
  right: PaneFooterRegistration | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftInfo = left.info ?? [];
  const rightInfo = right.info ?? [];
  const leftHints = left.hints ?? [];
  const rightHints = right.hints ?? [];
  const leftKeys = left.keys ?? [];
  const rightKeys = right.keys ?? [];
  return (left.order ?? 0) === (right.order ?? 0)
    && sameMenuItems(left.menu ?? [], right.menu ?? [])
    && leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key.id === rightKeys[index]!.id && key.key === rightKeys[index]!.key && key.disabled === rightKeys[index]!.disabled)
    && leftInfo.length === rightInfo.length
    && leftHints.length === rightHints.length
    && leftInfo.every((segment, index) => {
      const other = rightInfo[index];
      return !!other
        && segment.id === other.id
        && segment.icon === other.icon
        && segment.label === other.label
        && segment.title === other.title
        && segment.shortcut === other.shortcut
        && !!segment.onPress === !!other.onPress
        && segment.disabled === other.disabled
        && sameFooterParts(segment.parts, other.parts)
        && (segment.variants?.length ?? 0) === (other.variants?.length ?? 0)
        && (segment.variants ?? []).every((variant, variantIndex) => sameFooterParts(variant, other.variants![variantIndex]!));
    })
    && leftHints.every((hint, index) => {
      const other = rightHints[index];
      return !!other
        && hint.id === other.id
        && hint.key === other.key
        && hint.label === other.label
        && hint.title === other.title
        && !!hint.onPress === !!other.onPress
        && hint.disabled === other.disabled;
    });
}
