import { useCallback, useContext, useEffect, useId, useMemo, useRef } from "react";
import { AppContext, useOptionalPaneInstanceId, type AppState } from "../state/app/context";
import { usePinnedTabMoment, usePinnedTabMomentReader, useUnpinTab, type PinnedMoment } from "../state/app/tab-cursor";
import { findPaneInstance } from "../types/config";
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
 * means something else here, such as going back from an open item; through
 * `usePinnedList` it also holds the selection still under the open item.
 */
function usePinnedMoment(
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
  /**
   * Orders two rows by when they came out, negative when `a` is earlier, for
   * a clock finer than `moment`: two prints in one millisecond are told apart
   * by their nanoseconds. By `moment` when unset.
   */
  order?: (a: T, b: T) => number;
  /**
   * The id the list keeps selected, as stored: null when it has picked none,
   * even if it shows its first row then, and kept while its row is gone, so
   * the pin can tell a pick from a fallback.
   */
  selectedId: string | null;
  select: (id: string) => void;
  /** Follows the pin again when this changes under it: the tape's trades and quotes tabs. */
  followKey?: string;
  /** Names the list in its pane, which remembers what it followed for as long as the pin stays. */
  name: string;
  /**
   * Holds the selection still while an item is open over the list, so the
   * item stays the one opened; back on the list, it follows a pin that moved
   * meanwhile, and keeps its row otherwise.
   */
  paused?: boolean;
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
 * The row a list goes to at a pinned moment: the newest out at or before it,
 * else, when every row is later, the earliest. Of rows out at the same time,
 * the first in the list is the newest and the last the earliest, so a list
 * newest first gets the print nearest the moment either way. Rows with no
 * time are left out.
 */
export function pinnedRowOf<T>(
  rows: readonly T[],
  at: number,
  moment: (row: T) => number | null,
  after: (row: T, at: number) => boolean,
  order?: (a: T, b: T) => number,
): Pick<PinFollow<T>, "pinnedRow" | "beforeRows"> {
  let newest: { row: T; at: number } | null = null;
  let earliest: { row: T; at: number } | null = null;
  const earlier = (row: T, rowAt: number, than: { row: T; at: number }) => (order ? order(row, than.row) : rowAt - than.at);
  for (const row of rows) {
    const rowAt = moment(row);
    if (rowAt === null || !Number.isFinite(rowAt)) continue;
    if (!earliest || earlier(row, rowAt, earliest) <= 0) earliest = { row, at: rowAt };
    if (!after(row, at) && (!newest || earlier(row, rowAt, newest) > 0)) newest = { row, at: rowAt };
  }
  return { pinnedRow: newest?.row ?? earliest?.row ?? null, beforeRows: !newest && !!earliest };
}

const NOT_PINNED = { pinnedRow: null, beforeRows: false } as const;

/**
 * What each list followed of a pin, by pane and list, kept with the pin: a
 * list mounted again under the same pin (back from another layout tab) keeps
 * the row picked there by hand, as a list left mounted does. A pin moved or
 * lifted, or gone with its tab, takes its entries with it; a list closed with
 * its pane drops its own, whether or not it still followed the pin then.
 */
const followedPins = new WeakMap<PinnedMoment, Map<string, string>>();

/** How many lists remember following `pin`, for tests of what a closed pane leaves behind. */
export function pinFollowersForTests(pin: PinnedMoment): number {
  return followedPins.get(pin)?.size ?? 0;
}

/** Whether a pane is still open in a layout tab, the active one or one switched away from. */
function paneInLayouts(state: AppState, paneId: string): boolean {
  const { layout, layouts, activeLayoutIndex } = state.config;
  return findPaneInstance(layout, paneId) !== undefined
    || layouts.some((tab, index) => index !== activeLayoutIndex && findPaneInstance(tab.layout, paneId) !== undefined);
}

/**
 * A list that follows the tab's pinned crosshair. The selection goes to the
 * newest row out by the pinned moment when the pin moves, and when the rows
 * first arrive under it, never when a row streams in, so a row picked by hand
 * stays picked; lifting the pin leaves the selection where it is. A pin
 * before every row selects the earliest row, the one nearest the moment,
 * rather than keeping the row an earlier pin picked. Following commits the
 * row's id, so rows streaming in above it never move it. Rows out after the
 * moment are muted (`isAfterPin`, a table's `isRowMuted`).
 */
export function usePinFollow<T>({ pin, rows, getId, moment, isAfter, order, selectedId, select, followKey = "", name, paused = false }: PinFollowOptions<T>): PinFollow<T> {
  const at = pin?.at ?? null;
  const after = useCallback((row: T, time: number) => {
    if (isAfter) return isAfter(row, time);
    const rowAt = moment(row);
    return rowAt !== null && rowAt > time;
  }, [isAfter, moment]);
  const { pinnedRow, beforeRows } = useMemo(() => at === null ? NOT_PINNED
    : pinnedRowOf(rows, at, moment, after, order), [after, at, moment, order, rows]);
  const targetId = pinnedRow === null ? null : getId(pinnedRow);
  // Read only under a pin: a list follows nothing without one, so its renders
  // never look through the rows for the selection.
  const selectedShown = pin !== null && selectedId !== null && rows.some((row) => getId(row) === selectedId);
  const paneId = useOptionalPaneInstanceId();
  const ownId = useId();
  // A list outside a pane remembers only while it stays mounted.
  const memoryKey = `${paneId ?? ownId}\u0000${name}`;
  const selectRef = useRef(select);
  selectRef.current = select;
  useEffect(() => {
    if (pin === null || paused) return;
    const followed = followedPins.get(pin);
    // Nothing loaded yet: the rows follow once they come. Already followed:
    // the selection is the user's, unless it is gone from the list.
    if (targetId === null || (followed?.get(memoryKey) === followKey && selectedShown)) return;
    if (followed) followed.set(memoryKey, followKey);
    else followedPins.set(pin, new Map([[memoryKey, followKey]]));
    if (targetId !== selectedId) selectRef.current(targetId);
  }, [followKey, memoryKey, paused, pin, selectedId, selectedShown, targetId]);

  // A pane closed forgets what its list followed. Read once the unmount
  // settles, from the app's state then: a pane switched away from with its
  // tab, or remounted in place, is still in a layout and keeps it. The entry
  // is found under the tab's pin, not the one the list was given: a list that
  // stopped following before it closed (a tab of its pane with no list, a
  // folded chart) was given none, though its entry stays under the tab's.
  const app = useContext(AppContext);
  const tabPin = usePinnedTabMomentReader();
  useEffect(() => () => {
    queueMicrotask(() => {
      if (paneId !== null && app) {
        const state = "getState" in app ? app.getState() : app.state;
        if (paneInLayouts(state, paneId)) return;
      }
      const left = tabPin();
      if (left !== null) followedPins.get(left)?.delete(memoryKey);
    });
  }, [app, memoryKey, paneId, tabPin]);

  const isAfterPin = useCallback((row: T) => at !== null && after(row, at), [after, at]);
  return { pinnedRow, beforeRows, isAfterPin };
}

/**
 * `usePinnedMoment` and `usePinFollow` together, for a list beside the tab's
 * charts. `enabled: false`, for an item open over the list, also holds the
 * selection still until it closes.
 */
export function usePinnedList<T>(
  registrationId: string,
  options: Omit<PinFollowOptions<T>, "pin" | "name" | "paused"> & { enabled?: boolean; follows?: boolean },
): PinFollow<T> & { pin: PinnedMoment | null } {
  const { enabled, follows, ...follow } = options;
  const pin = usePinnedMoment(registrationId, { enabled, follows });
  return { ...usePinFollow({ ...follow, pin, name: registrationId, paused: enabled === false }), pin };
}
