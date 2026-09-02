import type { CommandBarBadgeTone } from "../../../theme/colors";
import type { ResultItem } from "./model";

export interface CommandBarRowBadge {
  text: string;
  tone: CommandBarBadgeTone;
}

/**
 * Width of the badge column, shared by every row of every list.
 *
 * Sized to the widest badge the bar can show, which is a six-character command
 * prefix; the class and document tags in play (EQ, ETF, DERIV, SYM, NEWS,
 * CALL, DOCS, RSCH, 10-K, 10-Q, 8-K) all fit inside it. Fixed rather than
 * measured, because the sections arrive at different times: instruments and
 * documents land after the local rows, and their badges are wider, so a
 * measured column would widen mid-query and shift every label above it
 * sideways. Reserving the minimum would not be enough either, since a badge
 * wider than the minimum still widens the column. The cost is one indent on a
 * list that happens to show no badge at all.
 */
export const BADGE_COLUMN_WIDTH = 6;
/** Gap between the badge column and the label. */
export const BADGE_GAP = 1;

/**
 * A shortcut prefix: EVT, RV, 13F, 10-K. Anything with lower case, spaces, or
 * more than six characters is a description and stays on the right.
 */
const SHORTCUT_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,5}$/;

type BadgeSource = Pick<ResultItem, "accent" | "badge" | "right" | "kind">;

export function looksLikeShortcut(value: string | undefined): value is string {
  return value !== undefined && SHORTCUT_PATTERN.test(value);
}

function resolveBadgeTone(item: BadgeSource): CommandBarBadgeTone {
  if (item.accent) return "assist";
  if (item.kind === "ticker" || item.kind === "search") return "instrument";
  return item.badge ? "document" : "command";
}

/**
 * Producers only had `right` for a long time, so rows that put a shortcut
 * there get it lifted into the badge column rather than every producer being
 * rewritten. Explicit `badge` always wins. Info rows never carry a badge: they
 * are placeholders, not things you can run. Plugin toggles show on/off on the
 * right instead of `right`, so nothing there is on screen to lift.
 */
export function resolveRowBadge(item: BadgeSource): CommandBarRowBadge | null {
  if (item.kind === "info" || item.kind === "plugin") return null;
  const text = item.badge || (looksLikeShortcut(item.right) ? item.right : null);
  if (!text) return null;
  return { text: text.toUpperCase(), tone: resolveBadgeTone(item) };
}

/** True when the badge was lifted from `right`, so the right column must not repeat it. */
export function badgeConsumesRight(item: BadgeSource): boolean {
  return !item.badge && resolveRowBadge(item) !== null;
}

