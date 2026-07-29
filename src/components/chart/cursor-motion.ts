
interface ChartCursorPosition {
  x: number | null;
  y: number | null;
}

const CELL_CURSOR_EASING = 0.72;
const CELL_CURSOR_SNAP_DISTANCE = 0.035;

function sameNullableNumber(left: number | null, right: number | null, epsilon = 0): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return Math.abs(left - right) <= epsilon;
}

function sameCursorPosition(
  left: ChartCursorPosition,
  right: ChartCursorPosition,
  epsilon = 0,
): boolean {
  return sameNullableNumber(left.x, right.x, epsilon) && sameNullableNumber(left.y, right.y, epsilon);
}

export function stepCursorTowards(
  current: ChartCursorPosition,
  target: ChartCursorPosition,
  easing = CELL_CURSOR_EASING,
  snapDistance = CELL_CURSOR_SNAP_DISTANCE,
): { next: ChartCursorPosition; settled: boolean } {
  if (target.x === null || target.y === null || current.x === null || current.y === null) {
    return { next: target, settled: true };
  }

  const easedX = Math.abs(target.x - current.x) <= snapDistance
    ? target.x
    : current.x + (target.x - current.x) * easing;
  const easedY = Math.abs(target.y - current.y) <= snapDistance
    ? target.y
    : current.y + (target.y - current.y) * easing;
  const next = { x: easedX, y: easedY };
  const settled = sameCursorPosition(next, target, snapDistance);

  return {
    next: settled ? target : next,
    settled,
  };
}
