export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowMinimumSize {
  width: number;
  height: number;
}

export const DEFAULT_WINDOW_FRAME: WindowFrame = { x: 64, y: 48, width: 1440, height: 920 };
const DEFAULT_WINDOWS_WINDOW_FRAME: WindowFrame = { x: 32, y: 32, width: 960, height: 680 };
// Emergency fallback until Electrobun exposes stable native minimum-size handling:
// https://github.com/blackboardsh/electrobun/issues/188
export const MAIN_WINDOW_MIN_SIZE: WindowMinimumSize = { width: 640, height: 400 };
export const DETACHED_WINDOW_MIN_SIZE: WindowMinimumSize = { width: 360, height: 240 };

export function defaultMainWindowFrame(platform = process.platform): WindowFrame {
  return platform === "win32" ? DEFAULT_WINDOWS_WINDOW_FRAME : DEFAULT_WINDOW_FRAME;
}

export function normalizeWindowFrame(
  frame: Partial<WindowFrame> | null | undefined,
  fallback: WindowFrame = DEFAULT_WINDOW_FRAME,
): WindowFrame {
  return {
    x: typeof frame?.x === "number" ? frame.x : fallback.x,
    y: typeof frame?.y === "number" ? frame.y : fallback.y,
    width: typeof frame?.width === "number" ? frame.width : fallback.width,
    height: typeof frame?.height === "number" ? frame.height : fallback.height,
  };
}

export function constrainWindowFrame(frame: WindowFrame, minimumSize?: WindowMinimumSize): WindowFrame {
  if (!minimumSize) return frame;
  return {
    ...frame,
    width: Math.max(minimumSize.width, frame.width),
    height: Math.max(minimumSize.height, frame.height),
  };
}

export function normalizeWindowFrameWithMinimum(
  frame: Partial<WindowFrame> | null | undefined,
  fallback: WindowFrame = DEFAULT_WINDOW_FRAME,
  minimumSize?: WindowMinimumSize,
): WindowFrame {
  return constrainWindowFrame(normalizeWindowFrame(frame, fallback), minimumSize);
}
