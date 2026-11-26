import { useCallback, useEffect, useMemo, useRef } from "react";
import { useOptionalPaneInstanceId } from "../state/app/context";
import { usePinnedTabMoment, useUnpinTab, type PinnedMoment } from "../state/app/tab-cursor";
import { formatDetailDate, formatZonedMoment } from "../utils/datetime-format";
import { usePaneFooter, type PaneFooterSegment } from "./layout/pane/footer";

/**
 * The footer's one form for a list that follows the tab's pinned crosshair:
 * `pinned 20 Nov 14:30 HKT`. Every list names the pin on the same clock, the
 * host's, with its zone said, whatever clock its own rows are on (the tape's
 * New York, a column in UTC), so no list reads the moment on another clock
 * without saying so. Kept in a capture of the pane: it is why the later rows
 * read muted.
 */
export function pinnedMomentFooterSegment(at: number, now = Date.now(), timeZone?: string): PaneFooterSegment {
  return {
    id: "pinned-moment",
    capture: true,
    title: `Crosshair pinned at ${formatDetailDate(at, "", timeZone)}`,
    parts: [{ text: `pinned ${formatZonedMoment(at, now, timeZone)}`, tone: "muted" }],
    variants: [[{ text: "pinned", tone: "muted" }]],
  };
}

/**
 * For a list that follows the tab's pinned crosshair (news, the tape): the
 * pinned moment, null while nothing is pinned. While it is pinned the footer
 * says so, focused or not, and a focused pane's footer offers `[Esc]unpin`, so
 * the pin can be seen and lifted from a pane with no chart, the way Esc lifts
 * it on one. Only the focused pane binds the key. `enabled: false` while Esc
 * means something else here, such as going back from an open item.
 */
export function usePinnedMoment(
  registrationId: string,
  { enabled = true, follows = true }: {
    enabled?: boolean;
    /** False for a list whose rows have no time of day to read a pin against: it neither follows nor says so. */
    follows?: boolean;
  } = {},
): PinnedMoment | null {
  const tabPin = usePinnedTabMoment();
  const pinned = follows ? tabPin : null;
  const unpin = useUnpinTab();
  const at = pinned?.at ?? null;
  const offered = enabled && at !== null;
  // After the pane's own status and keys.
  usePaneFooter(registrationId, () => at === null ? null : {
    order: 1,
    info: [pinnedMomentFooterSegment(at)],
    hints: offered ? [{ id: "unpin", key: "Esc", label: "unpin", title: "Unpin Crosshair", onPress: unpin }] : [],
  }, [at, offered, unpin]);
  return pinned;
}

export interface PinFollowOptions<T> {
  /** The pin the list follows; null while there is none. */
  pin: PinnedMoment | null;
  rows: readonly T[];
  getId: (row: T) => string;
  /**
   * When the row came out, in ms: an instant, to the minute or finer. Null for
   * a row with no time of day (a filing day): it is never picked or muted, as
   * a day cannot say whether it came before a moment in it.
   */
  moment: (row: T) => number | null;
  /** Whether a row is later than the pinned moment, for a clock finer than `moment` (the tape's nanoseconds). */
  isAfter?: (row: T, at: number) => boolean;
  /** The list's selected row, null when it has none. */
  selectedId: string | null;
  select: (id: string) => void;
  /** Follows the pin again when this changes under it: the tape's trades and quotes tabs. */
  followKey?: string;
  /** Names the list in its pane, which remembers what it followed for as long as the pin stays. */
  name: string;
}

export interface PinFollow<T> {
  /** The row the list goes to under the pin: the newest at or before it, else the earliest; null while nothing is pinned. */
  pinnedRow: T | null;
  /** The pin is earlier than every row with a time. */
  beforeRows: boolean;
  /** A row out after the pinned moment, which reads muted. */
  isAfterPin: (row: T) => boolean;
}

/**
 * The row a list goes to at a pinned moment: the newest out at or before it
 * (the first of rows out at the same millisecond, so a tape newest first gets
 * its last print), else, when every row is later, the earliest. Rows with no
 * time are left out.
 */
export function pinnedRowOf<T>(
  rows: readonly T[],
  at: number,
  moment: (row: T) => number | null,
  after: (row: T, at: number) => boolean,
): Pick<PinFollow<T>, "pinnedRow" | "beforeRows"> {
  let newest: { row: T; at: number } | null = null;
  let earliest: { row: T; at: number } | null = null;
  for (const row of rows) {
    const rowAt = moment(row);
    if (rowAt === null || !Number.isFinite(rowAt)) continue;
    if (!earliest || rowAt < earliest.at) earliest = { row, at: rowAt };
    if (!after(row, at) && (!newest || rowAt > newest.at)) newest = { row, at: rowAt };
  }
  return { pinnedRow: newest?.row ?? earliest?.row ?? null, beforeRows: !newest && !!earliest };
}

/**
 * What each list followed of its tab's pin, by pane and list: a list mounted
 * again under the same pin (back from another tab) keeps the row picked there
 * by hand, as a list left mounted does.
 */
const followedPins = new Map<string, string>();

/**
 * A list that follows the tab's pinned crosshair. The selection goes to the
 * newest row out by the pinned moment when the pin moves, and when the rows
 * first arrive under it, never when a row streams in, so a row picked by hand
 * stays picked; lifting the pin leaves the selection where it is. A pin
 * before every row selects the earliest row, the one nearest the moment,
 * rather than keeping the row an earlier pin picked. Rows out after the
 * moment are muted (`isAfterPin`, a table's `isRowMuted`).
 */
export function usePinFollow<T>({ pin, rows, getId, moment, isAfter, selectedId, select, followKey = "", name }: PinFollowOptions<T>): PinFollow<T> {
  const at = pin?.at ?? null;
  const after = useCallback((row: T, time: number) => {
    if (isAfter) return isAfter(row, time);
    const rowAt = moment(row);
    return rowAt !== null && rowAt > time;
  }, [isAfter, moment]);
  const { pinnedRow, beforeRows } = useMemo(() => at === null ? { pinnedRow: null, beforeRows: false }
    : pinnedRowOf(rows, at, moment, after), [after, at, moment, rows]);
  const targetId = pinnedRow === null ? null : getId(pinnedRow);
  const selectedShown = selectedId !== null && rows.some((row) => getId(row) === selectedId);
  const paneId = useOptionalPaneInstanceId();
  const memoryKey = paneId === null ? null : `${paneId}\u0000${name}`;
  const followedRef = useRef<string | null>(memoryKey === null ? null : followedPins.get(memoryKey) ?? null);
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    if (pin === null) {
      followedRef.current = null;
      if (memoryKey !== null) followedPins.delete(memoryKey);
      return;
    }
    const followed = `${pin.serial}\u0000${followKey}`;
    // Nothing loaded yet: the rows follow once they come. Already followed:
    // the selection is the user's, unless it is gone from the list.
    if (targetId === null || (followedRef.current === followed && selectedShown)) return;
    followedRef.current = followed;
    if (memoryKey !== null) followedPins.set(memoryKey, followed);
    if (targetId !== selectedId) selectRef.current(targetId);
  }, [followKey, memoryKey, pin, selectedId, selectedShown, targetId]);
  const isAfterPin = useCallback((row: T) => at !== null && after(row, at), [after, at]);
  return { pinnedRow, beforeRows, isAfterPin };
}

/** `usePinnedMoment` and `usePinFollow` together, for a list beside the tab's charts. */
export function usePinnedList<T>(
  registrationId: string,
  options: Omit<PinFollowOptions<T>, "pin" | "name"> & { enabled?: boolean; follows?: boolean },
): PinFollow<T> & { pin: PinnedMoment | null } {
  const { enabled, follows, ...follow } = options;
  const pin = usePinnedMoment(registrationId, { enabled, follows });
  return { ...usePinFollow({ ...follow, pin, name: registrationId }), pin };
}
