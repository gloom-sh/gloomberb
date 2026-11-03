import { ONE_SHOT_COOLDOWN_MS } from "./one-shot";

const DOUBLE_ESCAPE_CLOSE_MS = 650;

export interface DoubleEscapeCloseState {
  lastAt: number;
  targetId: string | null;
  /** The last Esc that closed a pane, or came while that close was still cooling down. */
  closedAt: number;
}

export function createDoubleEscapeCloseState(): DoubleEscapeCloseState {
  return {
    lastAt: 0,
    targetId: null,
    closedAt: Number.NEGATIVE_INFINITY,
  };
}

export function resetDoubleEscapeClose(state: DoubleEscapeCloseState) {
  state.lastAt = 0;
  state.targetId = null;
}

/**
 * Key handling for a double-Esc close: `take` closes on the second Esc of a
 * pair, before the pane sees it, and `arm` makes an Esc the first half. Every
 * Esc arms, whatever the pane does with it (back out of a detail, clear a
 * selection, leave a chart), except an Esc that leaves a draft or closes a
 * menu: see `countEscapeTowardClose` and `keepEscapeFromClosing`.
 */
export function takeDoubleEscapeClose(
  state: DoubleEscapeCloseState,
  targetId: string | null | undefined,
  now: number,
  thresholdMs = DOUBLE_ESCAPE_CLOSE_MS,
): boolean {
  const matched = !!targetId && state.targetId === targetId && now - state.lastAt <= thresholdMs;
  if (matched) {
    resetDoubleEscapeClose(state);
    state.closedAt = now;
  }
  return matched;
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
) {
  if (!targetId) {
    resetDoubleEscapeClose(state);
    return;
  }
  // A held Esc is a stream of presses: after the close it arms nothing, so it
  // cannot close the next pane too. Each Esc of the stream extends the pause.
  if (now - state.closedAt < ONE_SHOT_COOLDOWN_MS) {
    state.closedAt = now;
    return;
  }
  state.targetId = targetId;
  state.lastAt = now;
}
