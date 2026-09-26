const DOUBLE_ESCAPE_CLOSE_MS = 650;

export interface DoubleEscapeCloseState {
  lastAt: number;
  targetId: string | null;
}

export function createDoubleEscapeCloseState(): DoubleEscapeCloseState {
  return {
    lastAt: 0,
    targetId: null,
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
  if (matched) resetDoubleEscapeClose(state);
  return matched;
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
  state.targetId = targetId;
  state.lastAt = now;
}
