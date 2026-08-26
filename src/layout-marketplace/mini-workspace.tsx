import { createElement, useId, useMemo, type SVGProps } from "react";
import { Box } from "../ui";
import { blendHex, type ThemeColors } from "../theme/colors";
import { useThemeColors } from "../theme/theme-context";
import type { LayoutConfig } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { buildLayoutPreviewRects, type LayoutPreviewKind } from "./geometry";
import { summarizeLayoutPanes, type GalleryPaneSummary } from "./model";
import type { PaneImagery } from "./pane-imagery";

/** Reference screen a published layout's floating coordinates were captured on. */
const REFERENCE_SCREEN = { width: 200, height: 55 };
const HEADER_HEIGHT = 13;
const MIN_RECT = 26;

function SvgText(props: SVGProps<SVGTextElement>) {
  return createElement("text", props);
}

/** Stable per-instance jitter so a card looks the same on every render. */
function hashUnit(seed: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

function fitLabel(text: string, width: number, charWidth: number): string {
  const maxChars = Math.max(1, Math.floor(width / charWidth));
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function chartPath(seed: string, x: number, y: number, width: number, height: number): string {
  const points = 12;
  return Array.from({ length: points }, (_, index) => {
    const progress = index / (points - 1);
    const wave = Math.sin(progress * Math.PI * 1.6 + hashUnit(seed, index) * 2) * 0.28;
    const drift = (hashUnit(seed, index + 40) - 0.5) * 0.22;
    const value = 0.5 + wave + drift;
    const pointX = x + progress * width;
    const pointY = y + height - Math.min(0.94, Math.max(0.06, value)) * height;
    return `${index === 0 ? "M" : "L"}${pointX.toFixed(1)} ${pointY.toFixed(1)}`;
  }).join(" ");
}

function PaneBodyImagery({
  imagery,
  seed,
  x,
  y,
  width,
  height,
  colors,
}: {
  imagery: PaneImagery;
  seed: string;
  x: number;
  y: number;
  width: number;
  height: number;
  colors: ThemeColors;
}) {
  const line = blendHex(colors.panel, colors.text, 0.34);
  const faint = blendHex(colors.panel, colors.text, 0.18);
  const accent = colors.borderFocused;

  switch (imagery) {
    case "chart":
      return (
        <>
          <path
            d={chartPath(seed, x, y, width, height)}
            fill="none"
            stroke={accent}
            strokeWidth={1.4}
            strokeLinejoin="round"
          />
          <line x1={x} y1={y + height} x2={x + width} y2={y + height} stroke={faint} strokeWidth={1} />
        </>
      );
    case "table": {
      const rows = Math.max(2, Math.min(6, Math.floor(height / 7)));
      const rowHeight = height / rows;
      return (
        <>
          {Array.from({ length: rows }, (_, row) => {
            const rowY = y + row * rowHeight + rowHeight / 2;
            const first = row === 0;
            return (
              <g key={row}>
                <line
                  x1={x}
                  y1={rowY}
                  x2={x + width * 0.38}
                  y2={rowY}
                  stroke={first ? line : faint}
                  strokeWidth={first ? 1.6 : 1.2}
                />
                <line
                  x1={x + width * 0.52}
                  y1={rowY}
                  x2={x + width * (0.62 + hashUnit(seed, row) * 0.3)}
                  y2={rowY}
                  stroke={row % 2 === 0 ? colors.positive : colors.negative}
                  strokeWidth={1.2}
                />
              </g>
            );
          })}
        </>
      );
    }
    case "feed": {
      const items = Math.max(1, Math.min(4, Math.floor(height / 11)));
      const itemHeight = height / items;
      return (
        <>
          {Array.from({ length: items }, (_, item) => {
            const top = y + item * itemHeight + 1;
            return (
              <g key={item}>
                <rect x={x} y={top} width={itemHeight * 0.55} height={itemHeight * 0.55} rx={1.5} fill={faint} />
                <line
                  x1={x + itemHeight * 0.72}
                  y1={top + itemHeight * 0.16}
                  x2={x + width * (0.7 + hashUnit(seed, item) * 0.3)}
                  y2={top + itemHeight * 0.16}
                  stroke={line}
                  strokeWidth={1.4}
                />
                <line
                  x1={x + itemHeight * 0.72}
                  y1={top + itemHeight * 0.44}
                  x2={x + width * (0.5 + hashUnit(seed, item + 7) * 0.3)}
                  y2={top + itemHeight * 0.44}
                  stroke={faint}
                  strokeWidth={1.2}
                />
              </g>
            );
          })}
        </>
      );
    }
    case "calendar": {
      const columns = 5;
      const rows = Math.max(1, Math.min(3, Math.floor(height / 9)));
      const cellWidth = width / columns;
      const cellHeight = height / rows;
      return (
        <>
          {Array.from({ length: rows * columns }, (_, cell) => {
            const column = cell % columns;
            const row = Math.floor(cell / columns);
            const marked = hashUnit(seed, cell) > 0.62;
            return (
              <rect
                key={cell}
                x={x + column * cellWidth + 1}
                y={y + row * cellHeight + 1}
                width={Math.max(2, cellWidth - 2.5)}
                height={Math.max(2, cellHeight - 2.5)}
                rx={1.5}
                fill={marked ? blendHex(colors.panel, accent, 0.5) : faint}
              />
            );
          })}
        </>
      );
    }
    case "chat": {
      const bubbles = Math.max(1, Math.min(3, Math.floor(height / 12)));
      const bubbleHeight = height / bubbles;
      return (
        <>
          {Array.from({ length: bubbles }, (_, bubble) => {
            const mine = bubble % 2 === 1;
            const bubbleWidth = width * (0.42 + hashUnit(seed, bubble) * 0.26);
            return (
              <rect
                key={bubble}
                x={mine ? x + width - bubbleWidth : x}
                y={y + bubble * bubbleHeight + 1}
                width={bubbleWidth}
                height={Math.max(3, bubbleHeight - 4)}
                rx={2.5}
                fill={mine ? blendHex(colors.panel, accent, 0.42) : faint}
              />
            );
          })}
        </>
      );
    }
    case "gauge": {
      const radius = Math.min(width, height * 1.6) / 2.4;
      const centerX = x + width / 2;
      const centerY = y + height * 0.86;
      const angle = Math.PI * (0.22 + hashUnit(seed, 3) * 0.56);
      return (
        <>
          <path
            d={`M ${centerX - radius} ${centerY} A ${radius} ${radius} 0 0 1 ${centerX + radius} ${centerY}`}
            fill="none"
            stroke={faint}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <line
            x1={centerX}
            y1={centerY}
            x2={centerX - Math.cos(angle) * radius * 0.82}
            y2={centerY - Math.sin(angle) * radius * 0.82}
            stroke={accent}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        </>
      );
    }
    case "heatmap": {
      const columns = Math.max(2, Math.min(5, Math.round(width / 16)));
      const rows = Math.max(2, Math.min(4, Math.round(height / 12)));
      const cellWidth = width / columns;
      const cellHeight = height / rows;
      return (
        <>
          {Array.from({ length: rows * columns }, (_, cell) => {
            const value = hashUnit(seed, cell + 11);
            return (
              <rect
                key={cell}
                x={x + (cell % columns) * cellWidth + 0.75}
                y={y + Math.floor(cell / columns) * cellHeight + 0.75}
                width={Math.max(2, cellWidth - 1.5)}
                height={Math.max(2, cellHeight - 1.5)}
                fill={blendHex(colors.panel, value > 0.5 ? colors.positive : colors.negative, 0.2 + value * 0.4)}
              />
            );
          })}
        </>
      );
    }
    case "media": {
      const size = Math.min(width, height) * 0.42;
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      return (
        <>
          <rect x={x} y={y} width={width} height={height} rx={2} fill={faint} />
          <path
            d={`M ${centerX - size * 0.3} ${centerY - size} L ${centerX + size * 0.75} ${centerY} L ${centerX - size * 0.3} ${centerY + size} Z`}
            fill={blendHex(colors.panel, colors.textBright, 0.55)}
          />
        </>
      );
    }
    default: {
      const rows = Math.max(2, Math.min(5, Math.floor(height / 8)));
      const rowHeight = height / rows;
      return (
        <>
          {Array.from({ length: rows }, (_, row) => (
            <line
              key={row}
              x1={x}
              y1={y + row * rowHeight + rowHeight / 2}
              x2={x + width * (0.45 + hashUnit(seed, row + 23) * 0.55)}
              y2={y + row * rowHeight + rowHeight / 2}
              stroke={row === 0 ? line : faint}
              strokeWidth={1.2}
            />
          ))}
        </>
      );
    }
  }
}

function paneChrome(kind: LayoutPreviewKind, missing: boolean, colors: ThemeColors) {
  if (missing) {
    return {
      border: blendHex(colors.border, colors.textMuted, 0.4),
      header: blendHex(colors.panel, colors.bg, 0.4),
      surface: blendHex(colors.panel, colors.bg, 0.55),
      title: colors.textMuted,
    };
  }
  if (kind === "detached") {
    return {
      border: colors.warning,
      header: blendHex(colors.panel, colors.warning, 0.24),
      surface: colors.panel,
      title: colors.textBright,
    };
  }
  if (kind === "floating") {
    return {
      border: colors.borderFocused,
      header: blendHex(colors.panel, colors.borderFocused, 0.3),
      surface: colors.panel,
      title: colors.textBright,
    };
  }
  return {
    border: colors.border,
    header: blendHex(colors.panel, colors.border, 0.55),
    surface: colors.panel,
    title: colors.text,
  };
}

/**
 * A published layout drawn as a small workspace: every pane keeps its registered
 * name and a body sketch chosen from its pane id. Nothing here reads live pane
 * state, settings, or account data.
 */
export function MiniWorkspace({
  layout,
  panes,
  width,
  height,
  detail = false,
}: {
  layout: LayoutConfig;
  panes: ReadonlyMap<string, PaneDef>;
  width: number;
  height: number;
  detail?: boolean;
}) {
  const colors = useThemeColors();
  const missingPatternId = `gloom-missing-pane-${useId().replaceAll(":", "")}`;
  const summaries = useMemo(() => summarizeLayoutPanes(layout, panes), [layout, panes]);
  const rects = useMemo(() => buildLayoutPreviewRects(
    layout,
    { width, height },
    REFERENCE_SCREEN,
    { minSize: MIN_RECT, fractional: true },
  ), [height, layout, width]);
  const summaryById = useMemo(() => {
    const map = new Map<string, GalleryPaneSummary>();
    for (const summary of summaries) map.set(summary.instanceId, summary);
    return map;
  }, [summaries]);
  const fontSize = detail ? 9 : 7.5;
  const charWidth = fontSize * 0.62;

  return (
    <Box width="100%" flexGrow={1} style={{ minHeight: 0 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={summaries.map((pane) => (
          pane.symbol ? `${pane.name} ${pane.symbol}` : pane.name
        )).join(", ")}
        style={{ display: "block" }}
      >
        <defs>
          <pattern id={missingPatternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" stroke={colors.textMuted} strokeWidth="1" opacity="0.35" />
          </pattern>
        </defs>
        <rect x={0} y={0} width={width} height={height} rx={3} fill={colors.bg} />
        {[...rects].sort((a, b) => a.depth - b.depth).map((entry) => {
          const summary = summaryById.get(entry.instanceId);
          const chrome = paneChrome(entry.kind, summary?.missing ?? true, colors);
          const { x, y, width: rectWidth, height: rectHeight } = entry.rect;
          const headerHeight = Math.min(HEADER_HEIGHT, Math.max(8, rectHeight * 0.3));
          const bodyY = y + headerHeight + 3;
          const bodyHeight = y + rectHeight - bodyY - 3;
          const label = summary
            ? `${summary.icon} ${summary.name}${summary.symbol ? ` ${summary.symbol}` : ""}`
            : entry.instanceId;
          return (
            <g key={entry.key}>
              <rect
                x={x}
                y={y}
                width={rectWidth}
                height={rectHeight}
                rx={2.5}
                fill={chrome.surface}
                stroke={chrome.border}
                strokeWidth={entry.kind === "docked" ? 1 : 1.4}
              />
              <path
                d={`M ${x} ${y + headerHeight} L ${x} ${y + 2.5} Q ${x} ${y} ${x + 2.5} ${y} L ${x + rectWidth - 2.5} ${y} Q ${x + rectWidth} ${y} ${x + rectWidth} ${y + 2.5} L ${x + rectWidth} ${y + headerHeight} Z`}
                fill={chrome.header}
              />
              <SvgText
                x={x + 4}
                y={y + headerHeight - (headerHeight - fontSize) / 2 - 1}
                fill={chrome.title}
                fontSize={fontSize}
                fontFamily="inherit"
              >
                {fitLabel(label, rectWidth - 8, charWidth)}
              </SvgText>
              {summary?.missing && (
                <rect
                  x={x + 1}
                  y={y + headerHeight}
                  width={rectWidth - 2}
                  height={Math.max(0, rectHeight - headerHeight - 1)}
                  fill={`url(#${missingPatternId})`}
                />
              )}
              {bodyHeight >= 10 && !summary?.missing && (
                <PaneBodyImagery
                  imagery={summary?.imagery ?? "generic"}
                  seed={entry.instanceId}
                  x={x + 4}
                  y={bodyY}
                  width={Math.max(4, rectWidth - 8)}
                  height={bodyHeight}
                  colors={colors}
                />
              )}
            </g>
          );
        })}
      </svg>
    </Box>
  );
}
