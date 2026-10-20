import type { CSSProperties, ReactNode } from "react";
import { Box, Text, useUiCapabilities } from "../../ui";
import { hoverBg } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { displayWidth, padTo, truncateToDisplayWidth } from "../../utils/format";
import { ExternalLinkText, usePaneLinkMenuEntry } from "./external-link";

/** One column of a ColumnGrid. */
export interface ColumnGridColumn {
  /** Cells the terminal gives the column, from the caller's own cell math. */
  width: number;
  /**
   * On the desktop and the web the column takes an equal share of the room the
   * fixed columns leave, and never less than this many characters. Without it
   * the column holds `width` characters there too.
   */
  growFrom?: number;
  /** Where the column's text sits; a number column is right-aligned. */
  align?: "left" | "right";
  /** Space before the column: cells on the terminal, characters on the desktop. */
  gapBefore?: number;
}

/**
 * What a cell's text opens (a row's market, a security's DES): the text is the
 * target, as a key-value row's value is, and inside a `PaneLinkMenu` the pane
 * menu lists it as `label`, so the keyboard reaches what a click opens.
 */
export interface ColumnGridLink {
  label: string;
  onOpen: () => void;
}

/** Text the grid fits to its column (padded on the terminal, cut by CSS on the desktop), or content the column holds. */
export type ColumnGridCell =
  | { text: string; color?: string; link?: ColumnGridLink }
  | { content: ReactNode }
  | null;

export interface ColumnGridProps {
  columns: readonly ColumnGridColumn[];
  /** Rows of cells, one per column. A header is the first row. */
  rows: ReadonlyArray<ReadonlyArray<ColumnGridCell>>;
  /** The terminal's width for the grid, in cells. The desktop fills its box. */
  width?: number;
  /** Names the grid for the pane chrome checks (`data-gloom-role`). */
  role?: string;
}

/**
 * Desktop text, in a box that takes what its track gives it. Whether its track
 * can be narrower than the text is `clipOf`'s to say; where it can, the text
 * carries `data-gloom-clip` and styles.css clips it, without a scroll container
 * where the engine has `overflow: clip`, and ends it in an ellipsis.
 */
const TEXT_BOX: CSSProperties = { display: "block", minWidth: 0 };
const CLIPPED = { "data-gloom-clip": "text" } as const;

/**
 * The clip a cell's text gets: a fixed column is as wide as its characters at
 * every frame, but a growing column can fall to `growFrom` characters at any
 * frame of a resize, between two catch-ups, however far the pointer moved. Text
 * longer than that is clipped, so a cell never draws outside its track.
 */
function clipOf(text: string, column: ColumnGridColumn): typeof CLIPPED | undefined {
  return displayWidth(text) > (column.growFrom ?? column.width) ? CLIPPED : undefined;
}

/**
 * The grid's tracks as CSS: characters for fixed columns, an equal share for
 * growing ones. Gaps that are all alike are the grid's column gap; otherwise
 * each gap is a track of its own, which no cell sits in.
 */
function gridTemplate(columns: readonly ColumnGridColumn[]): { template: string; gap: string | undefined; lines: number[] } {
  const track = (column: ColumnGridColumn) => column.growFrom != null ? `minmax(${column.growFrom}ch, 1fr)` : `${column.width}ch`;
  const gaps = columns.slice(1).map((column) => column.gapBefore ?? 0);
  if ((columns[0]?.gapBefore ?? 0) === 0 && gaps.every((gap) => gap === gaps[0])) {
    return { template: columns.map(track).join(" "), gap: gaps[0] ? `${gaps[0]}ch` : undefined, lines: columns.map((_, index) => index + 1) };
  }
  const tracks: string[] = [];
  const lines: number[] = [];
  for (const column of columns) {
    if (column.gapBefore) tracks.push(`${column.gapBefore}ch`);
    tracks.push(track(column));
    lines.push(tracks.length);
  }
  return { template: tracks.join(" "), gap: undefined, lines };
}

/** A link cell's pointer handling and its pane-menu entry; nothing for a plain cell. */
function useLinkTarget(link: ColumnGridLink | undefined) {
  const colors = useThemeColors();
  usePaneLinkMenuEntry(link ? `column-grid:${link.label}` : null, link?.label ?? "", () => link?.onOpen());
  return link ? {
    cursor: "pointer" as const,
    hoverBackgroundColor: hoverBg(colors),
    onMouseDown: (event?: { button?: number }) => { if ((event?.button ?? 0) === 0) link.onOpen(); },
    "data-gloom-interactive": "true",
    "data-gloom-label": link.label,
  } : {};
}

/** A text cell that opens something, in the terminal: its padded text is the target. */
function TerminalLinkCell({ text, color, link, width, align }: { text: string; color?: string; link: ColumnGridLink; width: number; align?: "left" | "right" }) {
  const target = useLinkTarget(link);
  return <Box width={width} flexDirection="row" {...target}><Text fg={color}>{padTo(text, width, align)}</Text></Box>;
}

/** A text cell that opens something, on the desktop and the web. */
function NativeLinkCell({ text, color, link, column, place }: { text: string; color?: string; link: ColumnGridLink; column: ColumnGridColumn; place: CSSProperties }) {
  const target = useLinkTarget(link);
  return (
    <Text fg={color} data-gloom-ui="column-grid-text" {...clipOf(text, column)} {...target} style={{ ...place, ...TEXT_BOX, textAlign: column.align ?? "left" }}>
      {text}
    </Text>
  );
}

/**
 * Columns of single-line text that line up from row to row: a table of
 * figures under its header, or label and value pairs set in columns. The terminal lays the
 * columns out at the whole cells the caller worked out, as text padded to
 * them. The desktop and the web lay out one CSS grid whose tracks are counted
 * in characters, so the columns follow a resize to the pixel, every row and
 * the header share the same tracks, and text that does not fit ends in an
 * ellipsis instead of being cut to a count of cells. A text cell with a `link`
 * opens it on a click and is listed in the pane menu.
 */
export function ColumnGrid({ columns, rows, width, role }: ColumnGridProps) {
  const { nativePaneChrome } = useUiCapabilities();
  if (!nativePaneChrome) {
    return (
      <Box flexDirection="column" width={width} data-gloom-role={role}>
        {rows.map((row, rowIndex) => (
          <Box key={rowIndex} flexDirection="row" height={1}>
            {columns.map((column, index) => {
              const cell = row[index] ?? null;
              return (
                <Box key={index} flexDirection="row">
                  {column.gapBefore ? <Box width={column.gapBefore} /> : null}
                  {cell && "text" in cell
                    ? cell.link
                      ? <TerminalLinkCell text={cell.text} color={cell.color} link={cell.link} width={column.width} align={column.align} />
                      : <Text fg={cell.color}>{padTo(cell.text, column.width, column.align)}</Text>
                    : <Box width={column.width} flexDirection="row">{cell?.content}</Box>}
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    );
  }

  const { template, gap, lines } = gridTemplate(columns);
  return (
    <Box
      data-gloom-ui="column-grid"
      data-gloom-role={role}
      // A row is one line of text, as tall as the text's own line: rows of a set
      // height spare the browser sizing them again on every frame of a resize.
      // The grid clips what its tracks put past its edge (columns that cannot shrink under a pane that does).
      data-gloom-clip="box"
      style={{ display: "grid", gridTemplateColumns: template, gridAutoRows: "var(--cell-h)", ...(gap ? { columnGap: gap } : {}) }}
    >
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} data-gloom-ui="column-grid-row" style={{ display: "contents" }}>
          {columns.map((column, index) => {
            const cell = row[index] ?? null;
            if (!cell) return null;
            const place: CSSProperties = { gridColumn: lines[index], gridRow: rowIndex + 1 };
            if ("text" in cell && cell.link) return <NativeLinkCell key={index} text={cell.text} color={cell.color} link={cell.link} column={column} place={place} />;
            return "text" in cell
              ? (
                <Text
                  key={index}
                  fg={cell.color}
                  data-gloom-ui="column-grid-text"
                  {...clipOf(cell.text, column)}
                  style={{ ...place, ...TEXT_BOX, textAlign: column.align ?? "left" }}
                >
                  {cell.text}
                </Text>
              )
              : <Box key={index} flexDirection="row" data-gloom-ui="column-grid-cell" style={{ ...place, minWidth: 0 }}>{cell.content}</Box>;
          })}
        </Box>
      ))}
    </Box>
  );
}

export interface ColumnGridPairProps {
  label: string;
  /** Cells, and on the desktop characters, the label takes. */
  labelWidth: number;
  /** The terminal's cells for label and value together. */
  width: number;
  value: string;
  valueColor?: string;
  /** Muted context after the value, already chosen to fit. */
  detail?: string;
  /** The value opens this address. */
  url?: string;
}

/**
 * A label and its value in one ColumnGrid cell: the label at a fixed width,
 * the value right-aligned in the rest and cut from its end when it is too
 * long, and its muted detail after it. The detail gives way before the value.
 */
export function ColumnGridPair({ label, labelWidth, width, value, valueColor, detail, url }: ColumnGridPairProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const color = valueColor ?? colors.text;
  if (!nativePaneChrome) {
    const valueWidth = Math.max(1, width - labelWidth);
    const shown = truncateToDisplayWidth(value, valueWidth);
    return (
      <>
        <Box width={labelWidth} overflow="hidden">
          <Text fg={colors.textDim}>{label}</Text>
        </Box>
        <Box flexDirection="row" width={valueWidth} justifyContent="flex-end" overflow="hidden">
          {url ? <ExternalLinkText url={url} label={shown} color={color} /> : <Text fg={color}>{shown}</Text>}
          {detail ? <Text fg={colors.textDim}>{` ${detail}`}</Text> : null}
        </Box>
      </>
    );
  }
  // The value's box can fall to nothing at any frame of a resize (the columns hold their labels, not their
  // values), so its text and detail are clipped, the detail first. A link is clipped by its box, from its end.
  return (
    <>
      <Text
        fg={colors.textDim}
        {...(displayWidth(label) > labelWidth ? { "data-gloom-clip": "box" } : {})}
        style={{ flexGrow: 0, flexShrink: 0, flexBasis: `${labelWidth}ch`, display: "block" }}
      >
        {label}
      </Text>
      <Box flexDirection="row" justifyContent="flex-end" flexGrow={1} flexShrink={1} flexBasis={0} {...(url ? { "data-gloom-clip": "box" } : {})}>
        {url
          ? <ExternalLinkText url={url} label={value} color={color} />
          : <Text fg={color} {...CLIPPED} style={{ ...TEXT_BOX, flexShrink: 1 }}>{value}</Text>}
        {detail ? <Text fg={colors.textDim} {...CLIPPED} style={{ ...TEXT_BOX, flexShrink: 1000 }}>{` ${detail}`}</Text> : null}
      </Box>
    </>
  );
}
