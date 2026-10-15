import { useMemo } from "react";
import { ClippedText } from "../components/ui/display";
import { fitDialogWidth } from "../components/ui/frame";
import { useThemeColors } from "../theme/theme-context";
import { Box, ImageSurface, Span, Text, TextAttributes, useUiCapabilities } from "../ui";
import { truncateWithEllipsis } from "../utils/text-wrap";
import { paneImageThumbnail, pngDataUrl, type PaneImageCapture } from "./pane-image";

/** The widest a dialog with a pane's picture gets, in cells; the preview is as wide as the form. */
export const CAPTURE_DIALOG_COLUMNS = 72;
/** Border plus padding the terminal dialog host draws around the content. */
export const CAPTURE_DIALOG_CHROME = 6;

/**
 * Terminal: how wide the form is and how many rows its preview may take, so
 * the picture and the `formRows` under it fit the window.
 */
export function captureDialogSize(
  viewport: { width: number; height: number },
  capture: Pick<PaneImageCapture, "cells" | "width" | "height">,
  formRows: number,
): { width: number; previewRows: number } {
  const width = Math.max(30, Math.min(CAPTURE_DIALOG_COLUMNS, viewport.width - CAPTURE_DIALOG_CHROME - 4));
  const naturalRows = capture.cells && capture.cells.cols <= width
    ? capture.cells.rows
    : Math.ceil((width * capture.height) / Math.max(1, capture.width) / 2);
  return { width, previewRows: Math.max(4, Math.min(naturalRows, viewport.height - formRows)) };
}

/** The terminal's stand-in for the picture where it cannot draw images: half blocks, two pixels a cell. */
function ThumbnailRows({ capture, cols, rows }: { capture: PaneImageCapture; cols: number; rows: number }) {
  const lines = useMemo(() => (
    capture.pixels ? paneImageThumbnail({ width: capture.width, height: capture.height, pixels: capture.pixels }, cols, rows) : []
  ), [capture, cols, rows]);
  return (
    <Box flexDirection="column" alignItems="center" width={cols}>
      {lines.map((line, row) => (
        <Text key={row}>
          {line.map((cell, col) => <Span key={col} fg={cell.top} bg={cell.bottom}>▀</Span>)}
        </Text>
      ))}
    </Box>
  );
}

/** The terminal's preview of a pane that fits: its own cells, as the picture draws them. */
function CellRows({ cells }: { cells: NonNullable<PaneImageCapture["cells"]> }) {
  const rows = useMemo(() => {
    const result: Array<Array<{ text: string; fg: string; bg: string; bold: boolean }>> = [];
    for (let row = 0; row < cells.rows; row += 1) {
      const spans: Array<{ text: string; fg: string; bg: string; bold: boolean }> = [];
      for (const cell of cells.cells.slice(row * cells.cols, (row + 1) * cells.cols)) {
        if (!cell.char) continue;
        const last = spans.at(-1);
        if (last && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold) last.text += cell.char;
        else spans.push({ text: cell.char, fg: cell.fg, bg: cell.bg, bold: cell.bold });
      }
      result.push(spans);
    }
    return result;
  }, [cells]);
  return (
    <Box flexDirection="column" width={cells.cols}>
      {rows.map((spans, row) => (
        <Text key={row}>
          {spans.map((span, index) => (
            <Span key={index} fg={span.fg} bg={span.bg} attributes={span.bold ? TextAttributes.BOLD : 0}>{span.text}</Span>
          ))}
        </Text>
      ))}
    </Box>
  );
}

export interface CapturePreviewProps {
  capture: PaneImageCapture;
  /** The dim line under the picture: what it is and what goes with it. */
  meta: string;
  /** Terminal: the form's content width and the rows the preview may take. */
  width: number;
  previewRows: number;
}

/**
 * A pane's picture as it will be posted, with one dim line under it: the
 * image on the desktop and the web; in the terminal the pane's own cells when
 * they fit, else a thumbnail of the picture. Share and Report a Bug show it alike.
 */
export function CapturePreview({ capture, meta, width, previewRows }: CapturePreviewProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const previewUrl = useMemo(() => (nativePaneChrome ? pngDataUrl(capture.png) : ""), [capture.png, nativePaneChrome]);

  const preview = nativePaneChrome ? (
    <ImageSurface
      src={previewUrl}
      alt={capture.title}
      objectFit="contain"
      style={{
        width: "100%",
        height: `min(46vh, calc(${fitDialogWidth(CAPTURE_DIALOG_COLUMNS)} * ${capture.height / Math.max(1, capture.width)}))`,
        border: `1px solid ${colors.border}`,
        borderRadius: 6,
        backgroundColor: colors.bg,
      }}
    />
  ) : capture.cells && capture.cells.cols <= width && capture.cells.rows <= previewRows ? (
    // A pane that fits shows as its own cells. Kitty images stay out of the
    // terminal preview: a dialog covers them, its own included.
    <Box width={width} alignItems="center">
      <CellRows cells={capture.cells} />
    </Box>
  ) : (
    <Box width={width} alignItems="center">
      <ThumbnailRows capture={capture} cols={width} rows={previewRows} />
    </Box>
  );

  return (
    <Box flexDirection="column">
      {preview}
      <ClippedText fg={colors.textDim} text={meta} width={width} cut={truncateWithEllipsis} />
    </Box>
  );
}
