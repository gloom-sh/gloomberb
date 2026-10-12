/**
 * Regenerates `src/renderers/opentui/pane-image/glyphs.json`, the glyph
 * coverage the terminal app draws a pane's picture with (Share to Chat). The
 * terminal has no pixels to hand over, so the picture is drawn from the cells
 * of the last frame; this is the font those cells are drawn in.
 *
 *   bun run glyphs:terminal \
 *     --font JetBrainsMono-Regular.ttf --bold JetBrainsMono-Bold.ttf \
 *     --cjk NotoSansMonoCJKsc-Regular.otf --fallback unifont.otf
 *
 * JetBrains Mono 2.304 (https://github.com/JetBrains/JetBrainsMono) draws
 * the Latin, Greek and Cyrillic text, Noto Sans Mono CJK SC
 * (https://github.com/notofonts/noto-cjk) the wide characters of the
 * translations, and GNU Unifont 15.1 (https://unifoundry.com/unifont/) the
 * symbols the others lack; all three are under the SIL Open Font License 1.1
 * (glyphs-license.txt). Box drawing, block elements and braille are not taken
 * from a font: the renderer draws them, so borders and charts meet at the cell
 * edges.
 *
 * Glyphs are painted by the pinned headless Chrome of the pane-chrome checks
 * and stored as 4-bit coverage, one cell (or two for a wide character) each.
 */
import { readFileSync, writeFileSync } from "fs";
import { deflateRawSync } from "zlib";
import { join } from "path";
import { evaluate, launchBrowser } from "./pane-chrome/browser";

const CELL_WIDTH = 12;
const CELL_HEIGHT = 24;
const FONT_SIZE = 20;
const BASELINE = 18;

const OUTPUT = join(import.meta.dir, "..", "src", "renderers", "opentui", "pane-image", "glyphs.json");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

/** Drawn by the renderer itself, never from the font. */
function procedural(codePoint: number): boolean {
  return (codePoint >= 0x2500 && codePoint <= 0x259f) || (codePoint >= 0x2800 && codePoint <= 0x28ff);
}

/** Two cells wide in a terminal: East Asian wide and fullwidth forms. */
function wide(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3041 && codePoint <= 0x33ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xa000 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6);
}

/** Every character the app's own text uses, the translations included. */
function sourceCharacters(): number[] {
  const glob = new Bun.Glob("src/**/*.{ts,tsx}");
  const found = new Set<number>();
  for (const path of glob.scanSync({ cwd: join(import.meta.dir, "..") })) {
    if (path.includes(".test.")) continue;
    const text = readFileSync(join(import.meta.dir, "..", path), "utf8");
    for (const char of text) {
      const codePoint = char.codePointAt(0)!;
      if (codePoint >= 0x80 && codePoint <= 0xffff) found.add(codePoint);
    }
  }
  return [...found];
}

const NARROW_RANGES = [
  range(0x20, 0x7e),
  range(0xa1, 0xff),
  range(0x100, 0x17f),
  range(0x391, 0x3c9),
  range(0x401, 0x45f),
  range(0x2010, 0x2027),
  range(0x2030, 0x205e),
  range(0x2070, 0x209c),
  range(0x20a0, 0x20c0),
  range(0x2100, 0x214f),
  range(0x2150, 0x218b),
  range(0x2190, 0x21ff),
  range(0x2200, 0x22ff),
  range(0x2300, 0x23ff),
  range(0x25a0, 0x25ff),
  range(0x2600, 0x26ff),
  range(0x2700, 0x27bf),
  range(0x29c0, 0x29ff),
].flat();

const fontPath = arg("font");
const boldPath = arg("bold");
const cjkPath = arg("cjk");
const fallbackPath = arg("fallback");
if (!fontPath || !boldPath || !cjkPath || !fallbackPath) {
  console.error("Usage: bun run glyphs:terminal --font <regular.ttf> --bold <bold.ttf> --cjk <cjk.otf> --fallback <unifont.otf>");
  process.exit(1);
}

const codePoints = [...new Set([...NARROW_RANGES, ...sourceCharacters()])]
  .filter((codePoint) => !procedural(codePoint) && !(codePoint >= 0xd800 && codePoint <= 0xdfff) && !(codePoint >= 0xfe00 && codePoint <= 0xfe0f))
  .filter((codePoint) => !/\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}|\p{Mn}/u.test(String.fromCodePoint(codePoint)))
  .sort((a, b) => a - b);
const narrow = codePoints.filter((codePoint) => !wide(codePoint));
const wideCodePoints = codePoints.filter(wide);
const bold = range(0x21, 0x7e);

const fontUrl = (path: string, type: string) => `data:font/${type};base64,${readFileSync(path).toString("base64")}`;

const browser = await launchBrowser("terminal-glyphs", 400, 200);
try {
  await evaluate(browser.cdp, `(async () => {
    const faces = [
      new FontFace("GlyphRegular", "url(${fontUrl(fontPath, "ttf")})"),
      new FontFace("GlyphBold", "url(${fontUrl(boldPath, "ttf")})"),
      new FontFace("GlyphCjk", "url(${fontUrl(cjkPath, "otf")})"),
      new FontFace("GlyphFallback", "url(${fontUrl(fallbackPath, "otf")})"),
    ];
    for (const face of faces) document.fonts.add(await face.load());
    return true;
  })()`, 60_000);

  const paint = async (list: number[], family: string, cells: number): Promise<number[][]> => evaluate(browser.cdp, `(() => {
    const width = ${CELL_WIDTH * cells};
    const height = ${CELL_HEIGHT};
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.font = "${FONT_SIZE}px ${family}";
    context.textBaseline = "alphabetic";
    context.fillStyle = "#fff";
    return ${JSON.stringify(list)}.map((codePoint) => {
      const text = String.fromCodePoint(codePoint);
      context.clearRect(0, 0, width, height);
      const measured = context.measureText(text).width;
      // A glyph wider than its cells is squeezed into them, as a terminal would clip it.
      const scale = measured > width ? width / measured : 1;
      context.save();
      context.translate((width - measured * scale) / 2, 0);
      context.scale(scale, 1);
      context.fillText(text, 0, ${BASELINE});
      context.restore();
      const pixels = context.getImageData(0, 0, width, height).data;
      const coverage = [];
      for (let index = 3; index < pixels.length; index += 4) coverage.push(Math.round(pixels[index] / 17));
      return coverage;
    });
  })()`, 120_000);

  const regular = await paint(narrow, "GlyphRegular, GlyphFallback", 1);
  const boldGlyphs = await paint(bold, "GlyphBold, GlyphFallback", 1);
  const wideGlyphs = await paint(wideCodePoints, "GlyphCjk, GlyphFallback", 2);

  const nibbles = [...regular, ...boldGlyphs, ...wideGlyphs].flat();
  const packed = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 2) {
    packed[index / 2] = (nibbles[index]! << 4) | (nibbles[index + 1] ?? 0);
  }
  const output = {
    cellWidth: CELL_WIDTH,
    cellHeight: CELL_HEIGHT,
    narrow: String.fromCodePoint(...narrow),
    bold: String.fromCodePoint(...bold),
    wide: String.fromCodePoint(...wideCodePoints),
    coverage: Buffer.from(deflateRawSync(packed, { level: 9 })).toString("base64"),
  };
  writeFileSync(OUTPUT, `${JSON.stringify(output)}\n`);
  console.log(`${narrow.length} narrow, ${bold.length} bold, ${wideCodePoints.length} wide glyphs, ${Math.round(output.coverage.length / 1024)} KB`);
} finally {
  await browser.close();
}
