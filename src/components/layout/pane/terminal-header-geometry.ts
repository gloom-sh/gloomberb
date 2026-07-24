import { displayWidth } from "../../../utils/format";

export const PANE_HEADER_ACTION = " ... ";
export const PANE_HEADER_CLOSE = " x ";
export const PANE_HEADER_TILED = "T▦";
export const PANE_HEADER_FLOATING = "F◇";

export type TerminalPaneHeaderControl = "toggle" | "action" | "close";

export interface TerminalPaneHeaderSegment {
  control: TerminalPaneHeaderControl;
  start: number;
  end: number;
  text: string;
}

export interface TerminalPaneHeaderGeometry {
  width: number;
  leftBorder: string;
  rightBorder: string;
  contentStart: number;
  contentWidth: number;
  controls: Record<TerminalPaneHeaderControl, TerminalPaneHeaderSegment | null>;
  segments: TerminalPaneHeaderSegment[];
}

function fitText(text: string, available: number): string {
  if (available <= 0) return "";
  let fitted = "";
  let width = 0;
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > available) break;
    fitted += character;
    width += characterWidth;
  }
  return fitted;
}

export function resolveTerminalPaneHeaderGeometry(
  width: number,
  options: { floating: boolean; focused: boolean; showActions: boolean },
): TerminalPaneHeaderGeometry {
  const safeWidth = Math.max(0, Math.floor(width));
  const framed = options.focused || options.floating;
  const leftBorder = framed ? fitText("┌─", safeWidth) : "";
  const rightBorder = framed ? fitText("─┐", safeWidth - displayWidth(leftBorder)) : "";
  const controlBudget = safeWidth - displayWidth(leftBorder) - displayWidth(rightBorder);
  const toggleText = options.floating ? PANE_HEADER_FLOATING : PANE_HEADER_TILED;
  const candidates: Array<{ control: TerminalPaneHeaderControl; text: string }> = [
    { control: "toggle", text: toggleText },
    ...(options.floating ? [{ control: "close" as const, text: PANE_HEADER_CLOSE }] : []),
    ...(options.showActions ? [{ control: "action" as const, text: PANE_HEADER_ACTION }] : []),
  ];
  const visible = new Set<TerminalPaneHeaderControl>();
  let remaining = controlBudget;

  for (const candidate of candidates) {
    const candidateWidth = displayWidth(candidate.text);
    if (candidateWidth > remaining) continue;
    visible.add(candidate.control);
    remaining -= candidateWidth;
  }

  const contentStart = displayWidth(leftBorder);
  const contentWidth = remaining;
  let cursor = contentStart + contentWidth;
  const controls: TerminalPaneHeaderGeometry["controls"] = {
    toggle: null,
    action: null,
    close: null,
  };
  const segments: TerminalPaneHeaderSegment[] = [];
  const renderOrder: Array<{ control: TerminalPaneHeaderControl; text: string }> = [
    { control: "toggle", text: toggleText },
    { control: "action", text: PANE_HEADER_ACTION },
    { control: "close", text: PANE_HEADER_CLOSE },
  ];

  for (const candidate of renderOrder) {
    if (!visible.has(candidate.control)) continue;
    const segmentWidth = displayWidth(candidate.text);
    const segment = {
      control: candidate.control,
      start: cursor,
      end: cursor + segmentWidth,
      text: candidate.text,
    };
    controls[candidate.control] = segment;
    segments.push(segment);
    cursor = segment.end;
  }

  return {
    width: safeWidth,
    leftBorder,
    rightBorder,
    contentStart,
    contentWidth,
    controls,
    segments,
  };
}

export function terminalPaneHeaderControlAt(
  geometry: TerminalPaneHeaderGeometry,
  x: number,
): TerminalPaneHeaderControl | null {
  return geometry.segments.find((segment) => x >= segment.start && x < segment.end)?.control ?? null;
}
