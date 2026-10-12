import type { PaneDef, PanePersonalData, PanePersonalDataContext } from "../types/plugin";
import type { NativePaneImage } from "../ui/host";
import type { SharePayload } from "./payload";

/** A picture of one pane as it looked when it was taken, ready to post. */
export interface PaneImageCapture {
  paneId: string;
  paneType: string;
  title: string;
  /** ISO instant the picture was taken; its status line shows it. */
  capturedAt: string;
  /** What personal data the pane shows, so posting it asks first; null for market data. */
  personalData: PanePersonalData | null;
  /** The same view, projected through the existing public sharing rules at capture time. */
  sharePayload?: Extract<SharePayload, { kind: "pane" }> | null;
  png: Uint8Array;
  width: number;
  height: number;
  /** The terminal's picture as RGBA, for a preview in cells where the terminal cannot show images. */
  pixels?: Uint8ClampedArray;
  /** The terminal cells the picture was drawn from, for a preview where they fit. */
  cells?: NativePaneImage["cells"];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The status line a pane's picture carries, `Sat 10 Oct 2026 14:52 UTC`: when
 * it was taken, in UTC like the panes' own footers, for readers anywhere.
 */
export function formatCaptureStamp(date: Date): string {
  const clock = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  return `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${clock} UTC`;
}

/**
 * The personal data a pane instance shows now, from its definition: the one
 * answer Share and Ask Gloom both read. A declaration decides, and a rule that
 * returns null opts the instance out. A pane that says nothing keeps the
 * answer plugins written before `personalData` got (an external plugin's
 * panes still ask until it declares): `holdings` when its plugin connects a
 * broker, so a broker plugin's positions and orders ask, else `personal` when
 * it keeps fields private when shared, else market data.
 */
export function resolvePanePersonalData(
  def: Pick<PaneDef, "personalData" | "portableShare"> | undefined,
  context: PanePersonalDataContext,
  options: { ownerConnectsBroker?: boolean } = {},
): PanePersonalData | null {
  const declared = def?.personalData;
  if (declared !== undefined) return typeof declared === "function" ? declared(context) : declared;
  if (options.ownerConnectsBroker) return "holdings";
  return def?.portableShare?.private ? "personal" : null;
}

/** Whether the person holds the ticker a pane shows: a position that is not zero. */
export function holdsActiveTicker(context: Pick<PanePersonalDataContext, "activeTicker" | "tickers">): boolean {
  const ticker = context.activeTicker ? context.tickers.get(context.activeTicker) : undefined;
  return ticker?.metadata.positions.some((position) => position.shares !== 0) ?? false;
}

/** Whether the pane is on one of the person's portfolios: a watchlist is tickers they follow, a portfolio is what they hold. */
export function isOnPortfolio(context: Pick<PanePersonalDataContext, "config" | "activeCollectionId">): boolean {
  return context.config.portfolios.some((portfolio) => portfolio.id === context.activeCollectionId);
}

/** The confirmation a picture of personal data asks before it is posted. */
export function personalDataQuestion(kind: PanePersonalData): string {
  switch (kind) {
    case "holdings":
      return "This shows your holdings. Post it?";
    case "account":
      return "This shows your account details. Post it?";
    case "messages":
      return "This shows private messages. Post it?";
    case "personal":
      return "This shows your own data. Post it?";
  }
}

function hex(channel: number): string {
  return Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, "0");
}

/** One preview cell: the colours of its upper and lower half. */
export interface ThumbnailCell {
  top: string;
  bottom: string;
}

/**
 * The picture shrunk to `cols` by `rows` cells, two pixels a cell (upper and
 * lower half), each the average of the pixels it covers. The aspect ratio is
 * kept, so the result may be narrower or shorter than asked.
 */
export function paneImageThumbnail(
  image: { width: number; height: number; pixels: Uint8ClampedArray },
  cols: number,
  rows: number,
): ThumbnailCell[][] {
  if (cols <= 0 || rows <= 0 || image.width <= 0 || image.height <= 0) return [];
  // A cell is about twice as tall as it is wide, so each half cell is square.
  const scale = Math.min(cols / image.width, (rows * 2) / image.height);
  const outCols = Math.max(1, Math.round(image.width * scale));
  const outRows = Math.max(1, Math.round((image.height * scale) / 2));
  const average = (x0: number, y0: number, x1: number, y1: number): string => {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    const left = Math.floor(x0);
    const top = Math.floor(y0);
    const right = Math.max(left + 1, Math.ceil(x1));
    const bottom = Math.max(top + 1, Math.ceil(y1));
    // Sample at most a 6x6 grid of each block: a thumbnail needs the colour, not every pixel.
    const stepX = Math.max(1, Math.floor((right - left) / 6));
    const stepY = Math.max(1, Math.floor((bottom - top) / 6));
    for (let y = top; y < bottom && y < image.height; y += stepY) {
      for (let x = left; x < right && x < image.width; x += stepX) {
        const offset = (y * image.width + x) * 4;
        r += image.pixels[offset]!;
        g += image.pixels[offset + 1]!;
        b += image.pixels[offset + 2]!;
        count += 1;
      }
    }
    return count ? `#${hex(r / count)}${hex(g / count)}${hex(b / count)}` : "#000000";
  };
  const cellWidth = image.width / outCols;
  const halfHeight = image.height / (outRows * 2);
  const result: ThumbnailCell[][] = [];
  for (let row = 0; row < outRows; row += 1) {
    const line: ThumbnailCell[] = [];
    for (let col = 0; col < outCols; col += 1) {
      const x0 = col * cellWidth;
      const y0 = row * 2 * halfHeight;
      line.push({
        top: average(x0, y0, x0 + cellWidth, y0 + halfHeight),
        bottom: average(x0, y0 + halfHeight, x0 + cellWidth, y0 + halfHeight * 2),
      });
    }
    result.push(line);
  }
  return result;
}

/** PNG bytes from base64, as the desktop's canvas hands them over. */
export function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A data: URL for a preview, from the PNG's bytes. */
export function pngDataUrl(png: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < png.length; index += chunk) {
    binary += String.fromCharCode(...png.subarray(index, index + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}
