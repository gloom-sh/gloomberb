import type { CommandBarBadgeTone } from "../../../theme/colors";
import type { ResultItem } from "./model";

export interface CommandBarRowBadge {
  text: string;
  tone: CommandBarBadgeTone;
}

const BADGE_COLUMN_MIN = 4;
const BADGE_COLUMN_MAX = 6;
/** Column reserved for the badge plus the gap before the label. */
export const BADGE_GAP = 1;

/**
 * A shortcut prefix: EVT, RV, 13F, 10-K. Anything with lower case, spaces, or
 * more than six characters is a description and stays on the right.
 */
const SHORTCUT_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,5}$/;

type BadgeSource = Pick<ResultItem, "badge" | "right" | "kind">;

export function looksLikeShortcut(value: string | undefined): value is string {
  return value !== undefined && SHORTCUT_PATTERN.test(value);
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
  const tone: CommandBarBadgeTone = item.kind === "ticker" || item.kind === "search"
    ? "instrument"
    : item.badge
      ? "document"
      : "command";
  if (item.badge) return { text: item.badge, tone };
  if (looksLikeShortcut(item.right)) return { text: item.right, tone };
  return null;
}

/** True when the badge was lifted from `right`, so the right column must not repeat it. */
export function badgeConsumesRight(item: BadgeSource): boolean {
  return !item.badge && resolveRowBadge(item) !== null;
}

/**
 * Width of the badge column shared by every row in a list, or 0 when no row
 * has one. Padded to the widest badge so labels line up, within a band that
 * keeps a lone "T" from looking lost and "FILING" from pushing labels out.
 */
export function resolveBadgeColumnWidth(items: readonly BadgeSource[]): number {
  let widest = 0;
  for (const item of items) {
    const badge = resolveRowBadge(item);
    if (badge) widest = Math.max(widest, badge.text.length);
  }
  if (widest === 0) return 0;
  return Math.min(BADGE_COLUMN_MAX, Math.max(BADGE_COLUMN_MIN, widest));
}
