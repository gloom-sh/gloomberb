/**
 * QR rendering for both hosts: half-block Unicode lines for the terminal, and
 * an SVG data URI for the desktop web host, which must not draw shapes with
 * cell characters and would render them with unscannable line gaps anyway.
 *
 * A QR code must be dark-on-light for phone cameras, so both outputs have to be
 * painted with a dark foreground on a light background whatever the theme is.
 */
import qrcode from "qrcode-generator";

/** Mandatory light border around the code: the QR spec requires 4 modules on every side. */
const QUIET_ZONE_MODULES = 4;

const BOTH_LIGHT = " ";
const TOP_DARK = "\u2580"; // ▀
const BOTTOM_DARK = "\u2584"; // ▄
const BOTH_DARK = "\u2588"; // █

/** Quiet zone included, so callers only deal with one coordinate space. */
function qrGrid(text: string): { size: number; isDark: (row: number, col: number) => boolean } {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();

  const moduleCount = qr.getModuleCount();
  return {
    size: moduleCount + QUIET_ZONE_MODULES * 2,
    isDark: (row: number, col: number): boolean => {
      const moduleRow = row - QUIET_ZONE_MODULES;
      const moduleCol = col - QUIET_ZONE_MODULES;
      if (moduleRow < 0 || moduleCol < 0 || moduleRow >= moduleCount || moduleCol >= moduleCount) {
        return false;
      }
      return qr.isDark(moduleRow, moduleCol);
    },
  };
}

export function renderQrLines(text: string): string[] {
  const { size, isDark } = qrGrid(text);

  const lines: string[] = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let col = 0; col < size; col += 1) {
      const top = isDark(row, col);
      // An odd total height leaves the last line with no bottom row; pad it light.
      const bottom = row + 1 < size && isDark(row + 1, col);
      line += top ? (bottom ? BOTH_DARK : TOP_DARK) : (bottom ? BOTTOM_DARK : BOTH_LIGHT);
    }
    lines.push(line);
  }
  return lines;
}

/**
 * One `background-image` value for the desktop host. Runs of dark modules are
 * merged into a single rect per run so the markup stays small, and
 * `shape-rendering="crispEdges"` keeps module edges from being blurred away.
 */
export function renderQrSvgDataUri(text: string): string {
  const { size, isDark } = qrGrid(text);

  let rects = "";
  for (let row = 0; row < size; row += 1) {
    let runStart: number | null = null;
    for (let col = 0; col <= size; col += 1) {
      const dark = col < size && isDark(row, col);
      if (dark && runStart === null) runStart = col;
      if (!dark && runStart !== null) {
        rects += `<rect x="${runStart}" y="${row}" width="${col - runStart}" height="1"/>`;
        runStart = null;
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
    + `<rect width="${size}" height="${size}" fill="#ffffff"/>`
    + `<g fill="#000000">${rects}</g>`
    + "</svg>";
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
