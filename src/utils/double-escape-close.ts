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
 * Key handling for a double-Esc close: `take` runs before the pane and closes on the
 * second Esc of a pair, `arm` runs after it and only when nothing used the Esc.
 * So an Esc that backs out of a detail or closes a menu never counts as the
 * first half of a close.
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

const escapeArmOffers = new WeakMap<object, () => void>();

/**
 * Leaving an empty text field is the one Esc a pane uses that still counts as
 * the first half of a close, so Esc Esc from an idle composer closes the pane.
 * The shell offers every Esc in its `before` phase, focused field or not; a
 * pane handler that runs later takes the offer with `countEscapeTowardClose`
 * and consumes the Esc as usual. Anything the Esc backs out of (a draft, a
 * reply, a menu) keeps it from counting.
 */
export function offerEscapeTowardClose(event: object, arm: () => void) {
  escapeArmOffers.set(event, arm);
}

export function countEscapeTowardClose(event: object) {
  const arm = escapeArmOffers.get(event);
  escapeArmOffers.delete(event);
  arm?.();
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
