import type { ChartToolKind } from "./tools";

const HAND_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M6.4 8V3.5a1.15 1.15 0 0 1 2.3 0V7m0-.6a1.15 1.15 0 0 1 2.3 0V8m0-.5a1.15 1.15 0 0 1 2.3 0v3.1c0 2.1-1.7 3.8-3.8 3.8H8.9c-1.2 0-2.3-.6-3-1.6L3.6 9.4a1.15 1.15 0 0 1 1.8-1.4L6.4 9.2" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const RULER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1.4" y="4.6" width="13.2" height="6.8" rx="1.4" fill="none" stroke="#000" stroke-width="1.4"/><path d="M5 4.6v2.6M8 4.6v3.6M11 4.6v2.6" stroke="#000" stroke-width="1.3" stroke-linecap="round"/></svg>`;
const PEN_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.4 13.6 4 9.9 10.6 3.3a1.6 1.6 0 0 1 2.3 0l0 0a1.6 1.6 0 0 1 0 2.3L6.2 12 2.4 13.6Z" fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
const LINE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M3.2 12.8 12.8 3.2" stroke="#000" stroke-width="1.6" stroke-linecap="round"/><circle cx="3.2" cy="12.8" r="2" fill="none" stroke="#000" stroke-width="1.4"/><circle cx="12.8" cy="3.2" r="2" fill="none" stroke="#000" stroke-width="1.4"/></svg>`;
const LEVEL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1.6 8h4.2M10.2 8h4.2" stroke="#000" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="8" r="2.2" fill="none" stroke="#000" stroke-width="1.4"/></svg>`;
const MARQUEE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2.2 6V3.4a1.2 1.2 0 0 1 1.2-1.2H6M10 2.2h2.6a1.2 1.2 0 0 1 1.2 1.2V6M13.8 10v2.6a1.2 1.2 0 0 1-1.2 1.2H10M6 13.8H3.4a1.2 1.2 0 0 1-1.2-1.2V10" fill="none" stroke="#000" stroke-width="1.7" stroke-linecap="round"/></svg>`;

export const CHART_TOOLS: ReadonlyArray<{
  /** null is the resting state: the pointer pans and nothing is armed. */
  kind: ChartToolKind | null;
  label: string;
  shortcut: string;
  hint: string;
  glyph: string;
  icon: string;
}> = [
  {
    kind: null,
    label: "Pan",
    shortcut: "Esc",
    hint: "Drag to move through time, the resting state of the pointer",
    glyph: "\u2725",
    icon: HAND_ICON,
  },
  {
    kind: "measure",
    label: "Ruler",
    shortcut: "Shift+M",
    hint: "Drag to measure change, percent, bars, and elapsed time",
    glyph: "\u2194",
    icon: RULER_ICON,
  },
  {
    kind: "zoom",
    label: "Zoom to range",
    shortcut: "Shift+Z",
    hint: "Drag to select a time range to zoom into",
    glyph: "\u229e",
    icon: MARQUEE_ICON,
  },
  {
    kind: "line",
    label: "Trend line",
    shortcut: "Shift+D",
    hint: "Drag a straight line, grab an end to reshape it, Backspace deletes",
    glyph: "\u2571",
    icon: LINE_ICON,
  },
  {
    kind: "pencil",
    label: "Freehand",
    shortcut: "Shift+P",
    hint: "Draw freehand, drag a shape to move it, Backspace deletes",
    glyph: "\u223f",
    icon: PEN_ICON,
  },
  {
    kind: "level",
    label: "Price level",
    shortcut: "Shift+H",
    hint: "Click to add a level every chart of this ticker shows, drag one to move it, Backspace deletes",
    glyph: "\u2550",
    icon: LEVEL_ICON,
  },
];

/** Pane menu names for the tools, with the keys that pick them. */
export const CHART_TOOL_MENU: ReadonlyArray<{ kind: ChartToolKind; label: string; accelerator: string }> = [
  { kind: "measure", label: "Ruler", accelerator: "Shift+M" },
  { kind: "zoom", label: "Zoom to Range", accelerator: "Shift+Z" },
  { kind: "line", label: "Trend Line", accelerator: "Shift+D" },
  { kind: "pencil", label: "Freehand", accelerator: "Shift+P" },
  { kind: "level", label: "Price Level", accelerator: "Shift+H" },
];

/** What Enter does next with a tool in hand, for the footer and the pane menu. */
export const KEYBOARD_TOOL_HINTS: Record<ChartToolKind, {
  start: string;
  startTitle: string;
  finish: string;
  finishTitle: string;
}> = {
  measure: { start: "measure", startTitle: "Start Measure", finish: "done", finishTitle: "Finish Measure" },
  zoom: { start: "select", startTitle: "Select Range", finish: "zoom", finishTitle: "Zoom to Range" },
  line: { start: "draw", startTitle: "Draw Line", finish: "place", finishTitle: "Place Line" },
  pencil: { start: "draw", startTitle: "Draw Freehand", finish: "place", finishTitle: "Place Drawing" },
  level: { start: "add level", startTitle: "Add Level", finish: "add level", finishTitle: "Add Level" },
};

export const ARMED_TOOL_BY_INTERACTION = {
  "arm-measure": "measure",
  "arm-zoom": "zoom",
  "arm-line": "line",
  "arm-pencil": "pencil",
  "arm-level": "level",
} as const satisfies Record<string, ChartToolKind>;
