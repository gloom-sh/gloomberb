const DOUBLE_ESCAPE_CLOSE_MS = 650;

/**
 * Where a host cannot say which Esc presses are a held key's auto-repeat (a
 * terminal that does not report key event types), an Esc this soon after the
 * Esc before it is read as the held key, while a stream is live: after an Esc
 * that closed a pane, or one that looked like its repeat. It arms nothing and
 * closes nothing, so a held key cannot go on to close the next pane.
 *
 * Just above the slowest stock repeat interval: macOS repeats every 90 ms by
 * default, Windows, GNOME, KDE and X11 every 25 to 40 ms, and keyboards set
 * faster go lower, so a held key stays under it with room for a late frame.
 * Separate presses are rarely this close: even a quick double tap of one key
 * is further apart. A keyboard set to repeat slower than this reads as
 * separate presses, and a host that flags repeats never reaches this check.
 */
const HELD_ESCAPE_GAP_MS = 110;

/**
 * How long a stream stays live with no press. A stall (the redraw after the
 * close, a busy frame) holds the next repeat back, and the ones queued behind
 * it arrive close together: that press arms, but the one after it is still
 * the held key.
 */
const HELD_ESCAPE_STALL_MS = 500;

export interface DoubleEscapeCloseState {
  lastAt: number;
  targetId: string | null;
  /** The last Esc that closed a pane, or the latest one since that looked like its repeat. */
  streamAt: number;
  /** The last Esc that armed, closed or looked like a repeat. */
  pressAt: number;
  /** The last Esc that closed a window on its own (`takeSingleEscapeClose`), until the Esc after it. */
  singleClosedAt: number;
}

export function createDoubleEscapeCloseState(): DoubleEscapeCloseState {
  return {
    lastAt: 0,
    targetId: null,
    streamAt: Number.NEGATIVE_INFINITY,
    pressAt: Number.NEGATIVE_INFINITY,
    singleClosedAt: Number.NEGATIVE_INFINITY,
  };
}

export function resetDoubleEscapeClose(state: DoubleEscapeCloseState) {
  state.lastAt = 0;
  state.targetId = null;
  state.singleClosedAt = Number.NEGATIVE_INFINITY;
}

/**
 * Key handling for a double-Esc close: `take` closes on the second Esc of a
 * pair, before the pane sees it, and `arm` makes an Esc the first half. Every
 * Esc arms, whatever the pane does with it (back out of a detail, clear a
 * selection, leave a chart), except an Esc that leaves a draft or closes a
 * menu: see `countEscapeTowardClose` and `keepEscapeFromClosing`.
 *
 * `repeat` is the host's word on whether the key is held down (DOM `repeat`,
 * the kitty protocol's repeat event): true is an auto-repeat, which is no
 * press at all, and false is a press of its own however soon it follows the
 * last. Undefined where the host cannot tell; both then go by the gap
 * between presses, see `HELD_ESCAPE_GAP_MS`.
 */
export function takeDoubleEscapeClose(
  state: DoubleEscapeCloseState,
  targetId: string | null | undefined,
  now: number,
  repeat?: boolean,
): boolean {
  if (repeat === true) return false;
  const matched = !!targetId && state.targetId === targetId && now - state.lastAt <= DOUBLE_ESCAPE_CLOSE_MS;
  if (!matched || isHeldEscape(state, now, repeat)) return false;
  resetDoubleEscapeClose(state);
  state.streamAt = now;
  state.pressAt = now;
  return true;
}

function isHeldEscape(state: DoubleEscapeCloseState, now: number, repeat: boolean | undefined): boolean {
  return repeat === undefined
    && now - state.pressAt < HELD_ESCAPE_GAP_MS
    && now - state.streamAt < HELD_ESCAPE_STALL_MS;
}

/**
 * Whether an Esc is a held key rather than a press: the host's repeat, or one
 * that comes as fast as a held key's while a stream is live. Read before the
 * Esc arms anything, since arming moves the last press to it.
 */
export function isHeldEscapePress(state: DoubleEscapeCloseState, now: number, repeat?: boolean): boolean {
  return repeat === true || isHeldEscape(state, now, repeat);
}

/**
 * One Esc nothing else took closes a floating window on its own. Call it once
 * the window closed, for a press that was not held (`isHeldEscapePress`): the
 * Esc a double press sends after it closes nothing more
 * (`swallowEscapeAfterSingleClose`), so Esc Esc still closes one window, and
 * a held key, as after a double close, goes on closing nothing.
 */
export function takeSingleEscapeClose(state: DoubleEscapeCloseState, now: number) {
  resetDoubleEscapeClose(state);
  state.streamAt = now;
  state.pressAt = now;
  state.singleClosedAt = now;
}

/**
 * The Esc right after one that closed a window on its own, at a double
 * press's pace: the second half of a pair whose first half already closed.
 * It is taken, and reaches nothing. A host's repeat is left to the held-key
 * rules.
 */
export function swallowEscapeAfterSingleClose(state: DoubleEscapeCloseState, now: number, repeat?: boolean): boolean {
  if (repeat === true || now - state.singleClosedAt > DOUBLE_ESCAPE_CLOSE_MS) return false;
  state.singleClosedAt = Number.NEGATIVE_INFINITY;
  resetDoubleEscapeClose(state);
  state.streamAt = now;
  state.pressAt = now;
  return true;
}

interface EscapeOffer {
  count(): void;
  keep(): void;
  kept: boolean;
}

const escapeOffers = new WeakMap<object, EscapeOffer>();

/**
 * The shell offers every Esc to the pane before any handler runs, so a
 * handler in any phase can say what its Esc did to the close.
 */
export function offerEscapeTowardClose(event: object, offer: { count(): void; keep(): void }) {
  escapeOffers.set(event, { ...offer, kept: false });
}

/**
 * In a text field, or while a pane is editing, an Esc counts only when the
 * pane says it left nothing typed behind: Esc Esc from an empty composer
 * closes the pane, from a draft it never does.
 */
export function countEscapeTowardClose(event: object) {
  const offer = escapeOffers.get(event);
  if (offer && !offer.kept) offer.count();
}

/**
 * An Esc that closes a menu or popover of the pane's own, or backs out of a
 * draft, is not the first half of a close.
 */
export function keepEscapeFromClosing(event: object) {
  const offer = escapeOffers.get(event);
  if (!offer) return;
  offer.kept = true;
  offer.keep();
}

export function isEscapeKeptFromClosing(event: object): boolean {
  return escapeOffers.get(event)?.kept === true;
}

export function armDoubleEscapeClose(
  state: DoubleEscapeCloseState,
  targetId: string | null | undefined,
  now: number,
  repeat?: boolean,
) {
  if (!targetId) {
    resetDoubleEscapeClose(state);
    return;
  }
  if (repeat === true) return;
  // Where the host cannot flag repeats, a held Esc is a stream of presses:
  // after the close it arms nothing, so it cannot close the next pane too, and
  // each Esc of the stream keeps it going. A separate press, further from the
  // last than a held key's repeat, arms the next pane at once.
  if (isHeldEscape(state, now, repeat)) {
    resetDoubleEscapeClose(state);
    state.streamAt = now;
    state.pressAt = now;
    return;
  }
  state.targetId = targetId;
  state.lastAt = now;
  state.pressAt = now;
}
