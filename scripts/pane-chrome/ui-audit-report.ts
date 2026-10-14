import { mkdir, readdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import type { AuditElement, AuditMeasure, AuditTextRun } from "./ui-audit-measure";
import { scanStatic, total, type StaticScan } from "./ui-audit-static";

/**
 * Reads a UI audit run (ui-audit.ts) and says what conventions the app has:
 *
 * - every family of element (buttons, tabs, chips, fields, rows, headings,
 *   cards, states, pane chrome, dialogs, menus, chart chrome), its variants
 *   (equal shapes: size, padding, border, radius, shadow, type) and the
 *   components that draw them, with a picture grid per family (`grids/`);
 * - the type in use: every size, line height and weight, by role (title,
 *   heading, lead, body, metadata, table cells, labels, buttons, chips...);
 * - each view's content inset at each width, and the heights of rows;
 * - the colours in use against the theme's tokens;
 * - the static scan of the code (ui-audit-static.ts): literals per file.
 *
 *   bun scripts/pane-chrome/ui-audit-report.ts <run folder> [--sheets] [--extra <plugin checkout>]...
 *
 * Writes report.md, report.json and grids/ into the run folder; `--sheets`
 * also lays every view's picture out on contact sheets (`sheets/`), for the
 * run's own pictures and any `<browser>-shots/` folder beside them.
 */

interface ResultLine {
  id: string;
  kind: "pane" | "shell";
  token: string;
  paneId?: string;
  plugin?: string;
  view: string;
  width: number;
  theme: string;
  measure: AuditMeasure;
}

interface ViewLine { id: string; token: string; view: string; plugin?: string; kind: string }
interface VariantPicture { key: string; family: string; shape: string; component: string; state: string; token: string; view: string; width: number; file: string; hover: string | null }

/** Families whose height is their content's (a dialog, a card): their variants are told apart without it. */
const CONTENT_HEIGHT = new Set(["dialog", "card", "menu", "tooltip", "toast", "toolbar", "state-empty", "state-notice", "state-locked", "state-loading", "section-heading", "kv-row", "divider", "legend", "axis", "field-label", "link"]);

/**
 * Text and boxes a chart, map or heat map sizes to its own shapes: a tile's
 * label fitted to the tile, a map label scaled with the map. Reported apart
 * from the app's type scale and cards; their chrome (legends, axes) is not.
 */
export const FITTED = /HeatTreemap|DomHeatTile|WorldVenueMap|CountryNames|SupplyGraph|GeoMap|Basemap|MetricTreemap/;

/** What each family is, for the report's reader. */
const FAMILY_LABEL: Record<string, string> = {
  "button": "Buttons", "tab": "Tabs", "tab-bar": "Tab bars", "segmented": "Segmented controls", "chip": "Chips and badges",
  "keycap": "Key caps", "toggle": "Toggles and checkboxes", "input": "Inputs and search boxes", "select": "Selects",
  "link": "Links", "field-label": "Form labels", "toolbar": "Toolbars and filter rows", "sort-indicator": "Sort indicators",
  "table-header-row": "Table header rows", "table-header-cell": "Table header cells", "table-row": "Table rows",
  "table-section-row": "Table section rows", "list-row": "List rows", "kv-row": "Key-value rows", "card": "Cards",
  "section-heading": "Section headings", "divider": "Dividers", "state-empty": "Empty states", "state-loading": "Loading states",
  "state-notice": "Notices (stale, delayed, errors)", "state-locked": "Locked, Pro and sign-in states",
  "pane-title-bar": "Pane title bars", "pane-footer": "Pane footers", "pane-hint": "Footer key hints", "back-row": "Detail back rows",
  "dialog": "Dialogs", "menu": "Menus", "menu-item": "Menu items", "tooltip": "Tooltips and popovers", "toast": "Toasts",
  "app-header": "App header", "status-bar": "Status bar", "legend": "Chart legends", "axis": "Chart axes",
};

async function readLines<T>(file: string): Promise<T[]> {
  if (!await Bun.file(file).exists()) return [];
  return (await Bun.file(file).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

/** A text run's job in the interface, read from where it is and what drew it. */
function textRole(run: AuditTextRun): string {
  const { roles, tags, component, chain } = run;
  // Runs measured before the query bar had a region of its own were put in the command bar's.
  const region = run.region === "command-bar" && /QueryBar/.test(chain) ? "pane-body" : run.region;
  if (/tab-button|tab-label/.test(roles)) return "tab";
  if (/QueryBar/.test(chain)) return "toolbar";
  if (region === "pane-header") return roles.includes("pane-title") ? "pane-title" : tags.includes("role=tab") ? "tab" : "pane-header-other";
  if (region === "pane-footer") return roles.includes("pane-hint") ? "footer-hint" : "footer-status";
  if (region === "app-header" || region === "status-bar" || region === "menu" || region === "toast" || region === "command-bar") return region;
  if (region === "dialog") return run.fontWeight >= 600 && !tags.includes("button") ? "dialog-title" : tags.includes("button") ? "button" : "dialog-text";
  if (component.startsWith("ReaderText:")) {
    const variant = component.slice("ReaderText:".length);
    return ({ headline: "title", lead: "lead", body: "body", item: "body", heading: "heading", label: "heading", meta: "metadata", fact: "fact" } as Record<string, string>)[variant] ?? "body";
  }
  if (/data-table-header-cell|data-table-header-row/.test(roles)) return "table-header";
  if (/data-table-section-header/.test(roles)) return "table-section";
  if (/data-table-(cell|row|leading)/.test(roles)) return "table-cell";
  if (/\b(input|textarea)\b/.test(tags)) return "input";
  if (/section-heading/.test(roles)) return "section-heading";
  if (tags.includes("role=tab") || /tab-button|tab-label/.test(roles)) return "tab";
  if (/keycap/.test(roles) || component === "WebKeycap") return "keycap";
  if (/\bbutton\b|role=button/.test(tags) || /desktop-button|icon-button/.test(roles)) return "button";
  if (/(Badge|Chip|Pill)\b/.test(chain.split("<").slice(0, 4).join("<")) || /badge|chip/.test(roles)) return "chip";
  if (/\ba\b|role=link/.test(tags) || /ExternalLink/.test(component)) return "link";
  if (component === "FieldLabel") return "form-label";
  if (/empty-state|notice|pane-status|sign-in|pro-lock|wall-teaser|trial-offer/.test(roles)) return "state";
  if (/page-stack-header/.test(roles)) return "back-row";
  if (/axis|legend|composite-chart|chart|surface|heat|geo|treemap/.test(roles) || /Chart|Axis|Legend|Treemap|Heat/.test(component)) return "chart";
  if (/key-value-row|field-grid|stat-grid|pane-setting-row/.test(roles)) return /label/.test(roles) ? "label" : "label-value";
  if (/Markdown/.test(chain)) return run.fontWeight >= 600 && run.fontSize > 12.5 ? "heading" : "body";
  if (/prose|docs-body/.test(roles)) return "body";
  return run.fontWeight >= 600 ? "other-strong" : "other";
}

/** The theme token a computed colour is, or how it is not one. */
export function colourName(colour: string, palette: Record<string, string>): string {
  if (!colour) return "none";
  const rgb = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(colour);
  if (!rgb) return colour.startsWith("color(") ? "mixed (color-mix)" : `other ${colour}`;
  const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  let best = "", distance = Infinity;
  for (const [name, value] of Object.entries(palette)) {
    const p = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(value);
    if (!p) continue;
    const d = Math.abs(r - Number(p[1])) + Math.abs(g - Number(p[2])) + Math.abs(b - Number(p[3]));
    if (d < distance) { distance = d; best = name; }
  }
  if (alpha < 1) return distance <= 3 ? `${best} (translucent)` : "translucent mix";
  return distance <= 3 ? best : `off-palette ${colour}`;
}

/** The variant a family member belongs to: its shape, without the height its content gives it. */
export function variantShape(element: AuditElement): string {
  let shape = CONTENT_HEIGHT.has(element.family) ? element.shape.replace(/\bh=\d+\s*/, "") : element.shape;
  // A width over a few cells is its label's, not an icon's.
  shape = shape.replace(/\bw=(\d+)\b/, (whole, width) => (Number(width) > 48 ? "w=auto" : whole));
  if (/\bw=auto\b/.test(shape)) shape = shape.replace(/ icon\b/, "");
  return shape.trim();
}

/**
 * Colours the theme names through helpers rather than tokens (a focused
 * pane's title bar, a hover fill, the command bar's surfaces), so a colour
 * one of them makes is not counted as off the palette.
 */
async function derivedColours(themeId: string): Promise<Record<string, string>> {
  const theme = await import("../../src/theme/colors");
  const controls = await import("../../src/renderers/dom/desktop/control-styles");
  const p = theme.getThemeColors(themeId);
  const rgb = (hex: string) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
    return m ? `rgb(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)})` : hex;
  };
  const named: Record<string, string> = {
    "hoverBg()": theme.hoverBg(p), "commandBarBg()": theme.commandBarBg(p), "commandBarPanelBg()": theme.commandBarPanelBg(p),
    "commandBarInputBg()": theme.commandBarInputBg(p), "commandBarSelectedBg()": theme.commandBarSelectedBg(p), "commandBarHoverBg()": theme.commandBarHoverBg(p),
    "commandBarText()": theme.commandBarText(p), "commandBarHeadingText()": theme.commandBarHeadingText(p), "commandBarSubtleText()": theme.commandBarSubtleText(p),
    "commandBarAccentText()": theme.commandBarAccentText(p), "commandBarMatchText()": theme.commandBarMatchText(p), "commandBarSelectedText()": theme.commandBarSelectedText(p),
    "paneBg(focused)": theme.paneBg(true, p), "paneBg()": theme.paneBg(false, p), "floatingPaneBg(focused)": theme.floatingPaneBg(true, p), "floatingPaneBg()": theme.floatingPaneBg(false, p),
    "paneTitleBg(focused)": theme.paneTitleBg(true, p), "paneTitleBg()": theme.paneTitleBg(false, p), "paneTitleText(focused)": theme.paneTitleText(true, false, p), "paneTitleText()": theme.paneTitleText(false, false, p),
    "panelBorder()": controls.panelBorder(p), "panelFill()": controls.panelFill(p), "subtlePanelFill()": controls.subtlePanelFill(p), "selectedPanelFill()": controls.selectedPanelFill(p),
    "controlBorderColor()": controls.controlBorderColor(false, false, p), "controlBorderColor(focused)": controls.controlBorderColor(true, false, p),
  };
  return Object.fromEntries(Object.entries(named).map(([name, value]) => [`derived ${name}`, rgb(value)]));
}

/** Where a component is defined: the kit, the shell, or a pane's own code. */
async function componentIndex(root: string, extraDirs: readonly string[]): Promise<Map<string, string>> {
  const index = new Map<string, string>();
  const glob = new Bun.Glob("**/*.tsx");
  const dirs = [join(root, "src"), join(root, "node_modules/gloom-polls"), join(root, "node_modules/gloom-prediction-markets"), ...extraDirs];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for await (const file of glob.scan({ cwd: dir })) {
      if (/\.test\.tsx$|node_modules/.test(file)) continue;
      const source = await Bun.file(join(dir, file)).text();
      for (const match of source.matchAll(/(?:function|const)\s+([A-Z][A-Za-z0-9]+)\s*(?:<[^>]*>)?\s*(?:\(|=)/g)) {
        if (!index.has(match[1]!)) index.set(match[1]!, dir.startsWith(join(root, "src")) ? `src/${file}` : `${dir.split("/").pop()}/${file}`);
      }
    }
  }
  return index;
}

function ownerOf(component: string, index: Map<string, string>): string {
  const name = component.split(":")[0]!;
  if (/^Web[A-Z]/.test(name)) return "kit";
  const file = index.get(name);
  if (!file) return "unknown";
  if (/^src\/(components\/ui|ui|renderers\/dom)\//.test(file) || /^src\/components\/(reader|data-table|feed-data-table|chart|markdown-text)/.test(file)) return "kit";
  if (/^src\/components\/(layout|command-bar|onboarding)\/|^src\/app\//.test(file)) return "shell";
  const plugin = /^src\/plugins\/builtin\/([^/]+)/.exec(file);
  if (plugin) return `pane:${plugin[1]}`;
  if (/^src\/components\//.test(file)) return "shared";
  if (!file.startsWith("src/")) return `registry:${file.split("/")[0]}`;
  return "other";
}

function top<T>(map: Map<T, number>, count: number): Array<[T, number]> {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, count);
}

function bump<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [`| ${header.join(" | ")} |`, `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`, ...rows.map((row) => `| ${row.map((cell) => String(cell).replace(/\|/g, "/")).join(" | ")} |`)].join("\n");
}

function run(command: string[]): void {
  const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "pipe" });
  if (result.exitCode !== 0) console.warn(`${command[0]} failed: ${result.stderr.toString().slice(0, 300)}`);
}

/** Families drawn across a pane or a window: shown from their left edge, the hover state under them. */
const WIDE = /bar|dialog|card|toolbar|header|footer|row|state|menu|toast|tooltip|legend|axis|section|divider|link|label/;

/** One picture per variant of a family, under the pointer beside it when it reacts. */
async function familyGrid(out: string, family: string, variants: Array<{ index: number; label: string; picture?: VariantPicture }>): Promise<string | null> {
  const work = join(out, "grids", ".work", family);
  await mkdir(work, { recursive: true });
  const wide = WIDE.test(family);
  const tiles: string[] = [];
  for (const variant of variants) {
    if (!variant.picture) continue;
    const tile = join(work, `${variant.index}.png`);
    const parts = [join(out, variant.picture.file), ...(variant.picture.hover ? [join(out, variant.picture.hover)] : [])];
    const crop = wide ? "620x110+0+0" : "280x80+0+0";
    // Small controls at twice their size, so a pixel of padding or radius shows.
    run(["convert", ...parts.flatMap((part) => ["(", part, "-crop", crop, "+repage", ...(wide ? [] : ["-scale", "200%"]), "-bordercolor", "#4a4a4a", "-border", "1", ")"]), "-background", "#1b1b1b", wide ? "-append" : "+append", tile]);
    if (existsSync(tile)) tiles.push("-label", variant.label, tile);
  }
  if (tiles.length === 0) return null;
  const file = join(out, "grids", `${family}.png`);
  run(["montage", ...tiles, "-tile", "2x", "-geometry", wide ? "640x230>+14+10" : "760x170>+14+10", "-gravity", "North", "-background", "#1b1b1b", "-fill", "#e0e0e0", "-font", "JetBrains-Mono", "-pointsize", "10", "-title", `${FAMILY_LABEL[family] ?? family}: ${variants.length} variants`, file]);
  return existsSync(file) ? `grids/${family}.png` : null;
}

/** A variant's label under its picture: number, views, component, then its shape in short lines. */
function gridLabel(index: number, views: number, component: string, shape: string, wide: boolean): string {
  const width = wide ? 100 : 90;
  const words = shape.split(" ");
  const lines: string[] = [`#${index}  ${views} views  ${component}`];
  let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > width) { lines.push(line.trim()); line = ""; }
    line += ` ${word}`;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.slice(0, 4).join("\n");
}

/** Every view's picture on contact sheets, 30 a sheet, per theme and width. */
async function writeSheets(out: string, engine = "chromium", shotsDir = join(out, "shots")): Promise<string[]> {
  const written: string[] = [];
  if (!existsSync(shotsDir)) return written;
  const sheets = join(out, "sheets");
  await mkdir(sheets, { recursive: true });
  for (const theme of await readdir(shotsDir)) {
    for (const width of await readdir(join(shotsDir, theme))) {
      const dir = join(shotsDir, theme, width);
      const files = (await readdir(dir)).filter((file) => /\.(jpg|png)$/.test(file)).sort();
      const perSheet = 30;
      for (let page = 0; page * perSheet < files.length; page += 1) {
        const chunk = files.slice(page * perSheet, (page + 1) * perSheet);
        const file = join(sheets, `${engine}-${theme}-${width}-${String(page + 1).padStart(2, "0")}.jpg`);
        const geometry = Number(width) >= 1000 ? "400x250+6+6" : "240x300+6+6";
        run(["montage", ...chunk.flatMap((name) => ["-label", name.replace(/\.(jpg|png)$/, ""), join(dir, name)]), "-tile", Number(width) >= 1000 ? "5x" : "8x", "-geometry", geometry, "-background", "#202020", "-fill", "#dddddd", "-font", "JetBrains-Mono", "-pointsize", "11", "-title", `${engine} ${theme} ${width}px, sheet ${page + 1}`, "-quality", "82", file]);
        if (existsSync(file)) written.push(file);
      }
    }
  }
  return written;
}

export async function writeAuditReport(out: string, { root = resolve(join(import.meta.dir, "../..")), extraDirs = [] as string[] } = {}): Promise<void> {
  const results = await readLines<ResultLine>(join(out, "results.jsonl"));
  const views = await readLines<ViewLine>(join(out, "views.jsonl"));
  const pictures = await readLines<VariantPicture>(join(out, "variants.jsonl"));
  if (results.length === 0) return;
  const index = await componentIndex(root, extraDirs);
  const widths = [...new Set(results.map((result) => result.width))].sort((a, b) => a - b);
  const viewIds = new Set(results.map((result) => result.id));
  const failed = views.filter((view) => view.view === "failed").map((view) => view.token);
  const gated = new Set(results.filter((result) => result.measure.gated || (result.measure.elements ?? []).some((element) => element.family === "state-locked")).map((result) => result.id));
  const measured = results.find((result) => Object.keys(result.measure.palette ?? {}).length > 0);
  // Tokens first: a derived colour equal to a token is named as the token.
  // Text tokens first, so a white that is both text-bright and border-focused reads as text.
  const order = ["text", "text-bright", "text-dim", "text-muted", "positive", "negative", "neutral", "warning", "header-text", "selected-text", "bg", "panel", "selected", "header", "hover-bg", "border", "border-focused", "command-bg", "command-border"];
  const pagePalette = measured?.measure.palette ?? {};
  const palette = {
    ...Object.fromEntries(order.filter((name) => pagePalette[name]).map((name) => [name, pagePalette[name]!])),
    ...pagePalette,
    ...(await derivedColours(measured?.theme ?? "white").catch(() => ({}))),
  };

  // Families and their variants.
  interface Variant { family: string; shape: string; views: Set<string>; tokens: Set<string>; elements: number; components: Map<string, number>; owners: Map<string, number>; colours: Map<string, number>; pictureKeys: string[] }
  const families = new Map<string, Map<string, Variant>>();
  for (const result of results) {
    for (const element of result.measure.elements ?? []) {
      if (element.family === "card" && FITTED.test(element.chain)) continue;
      const shape = variantShape(element);
      const byShape = families.get(element.family) ?? new Map<string, Variant>();
      families.set(element.family, byShape);
      const variant: Variant = byShape.get(shape) ?? { family: element.family, shape, views: new Set(), tokens: new Set(), elements: 0, components: new Map(), owners: new Map(), colours: new Map(), pictureKeys: [] };
      byShape.set(shape, variant);
      variant.views.add(result.id);
      variant.tokens.add(result.token);
      variant.elements += element.count;
      bump(variant.components, element.component, element.count);
      bump(variant.owners, ownerOf(element.component, index), element.count);
      bump(variant.colours, `${colourName(element.color, palette)} on ${colourName(element.background, palette)}`, element.count);
      const key = [element.family, element.shape, element.component, element.state].join("|");
      if (!variant.pictureKeys.includes(key)) variant.pictureKeys.push(key);
    }
  }
  const pictureByKey = new Map(pictures.map((picture) => [picture.key, picture]));
  await rm(join(out, "grids"), { recursive: true, force: true });
  await mkdir(join(out, "grids"), { recursive: true });
  const familyReport: Array<Record<string, unknown>> = [];
  const familyRows: Array<Array<string | number>> = [];
  const familyDetails: string[] = [];
  for (const [family, byShape] of [...families].sort((a, b) => b[1].size - a[1].size)) {
    const variants = [...byShape.values()].sort((a, b) => b.views.size - a.views.size || b.elements - a.elements);
    const views = new Set(variants.flatMap((variant) => [...variant.views]));
    const components = new Map<string, number>();
    const owners = new Map<string, number>();
    for (const variant of variants) {
      for (const [name, count] of variant.components) bump(components, name, count);
      for (const [name, count] of variant.owners) bump(owners, name, count);
    }
    const ownerTotal = [...owners.values()].reduce((sum, count) => sum + count, 0);
    const kitShare = Math.round(((owners.get("kit") ?? 0) / Math.max(1, ownerTotal)) * 100);
    const lead = variants[0]!;
    const grid = await familyGrid(out, family, variants.slice(0, 48).map((variant, i) => {
      const picture = variant.pictureKeys.map((key) => pictureByKey.get(key)).find(Boolean);
      return { index: i + 1, label: gridLabel(i + 1, variant.views.size, top(variant.components, 1)[0]?.[0] ?? "", variant.shape, WIDE.test(family)), picture };
    }));
    // Functions that draw this family in a shape other than its most used one: what one convention would change.
    const tokens = new Set(variants.flatMap((variant) => [...variant.tokens]));
    const offLead = new Set(variants.slice(1).flatMap((variant) => [...variant.tokens]));
    familyRows.push([FAMILY_LABEL[family] ?? family, variants.length, components.size, views.size, tokens.size, offLead.size, `${kitShare}%`, `${Math.round((lead.views.size / Math.max(1, views.size)) * 100)}%`, grid ? `[grid](${grid})` : "no picture"]);
    familyReport.push({
      family, label: FAMILY_LABEL[family] ?? family, views: views.size, kitShare, grid,
      components: top(components, 20), owners: top(owners, 20),
      variants: variants.map((variant, i) => ({
        index: i + 1, shape: variant.shape, views: variant.views.size, elements: variant.elements, functions: [...variant.tokens].sort(),
        components: top(variant.components, 5), owners: top(variant.owners, 5), colours: top(variant.colours, 5),
        sampleViews: [...variant.views].slice(0, 8),
        picture: variant.pictureKeys.map((key) => pictureByKey.get(key)).find(Boolean)?.file ?? null,
      })),
    });
    familyDetails.push(`### ${FAMILY_LABEL[family] ?? family} (\`${family}\`): ${variants.length} variants in ${views.size} views, ${components.size} components${grid ? `, [grid](${grid})` : ""}\n\n${table(
      ["#", "Shape", "Views", "Elements", "Drawn by", "Colours (text on fill)"],
      variants.slice(0, 15).map((variant, i) => [i + 1, `\`${variant.shape}\``, variant.views.size, variant.elements, top(variant.components, 3).map(([name, count]) => `${name} ${count}`).join(", "), top(variant.colours, 2).map(([name]) => name).join("; ")]),
    )}${variants.length > 15 ? `\n\n${variants.length - 15} more variants in report.json.` : ""}`);
  }

  // Type, by role.
  interface Size { views: Set<string>; runs: number; chars: number; roles: Map<string, number>; components: Map<string, number> }
  const typeByWidth = new Map<number, Map<number, Size>>();
  const roleSizes = new Map<string, Map<string, { views: Set<string>; components: Map<string, number> }>>();
  const textColours = new Map<string, number>();
  const fitted = new Set<number>();
  for (const result of results) {
    const sizes = typeByWidth.get(result.width) ?? new Map<number, Size>();
    typeByWidth.set(result.width, sizes);
    for (const run of result.measure.texts) {
      if (FITTED.test(run.chain) && !/legend|axis/i.test(run.roles)) {
        fitted.add(run.fontSize);
        continue;
      }
      const role = textRole(run);
      const entry = sizes.get(run.fontSize) ?? { views: new Set(), runs: 0, chars: 0, roles: new Map(), components: new Map() };
      sizes.set(run.fontSize, entry);
      entry.views.add(result.id);
      entry.runs += run.count;
      entry.chars += run.chars;
      bump(entry.roles, role, run.count);
      bump(entry.components, run.component, run.count);
      if (result.width === widths[widths.length - 1]) {
        const key = `${run.fontSize}px/${run.lineHeight || "normal"}/${run.fontWeight}${run.uppercase ? "/upper" : ""}`;
        const byRole = roleSizes.get(role) ?? new Map();
        roleSizes.set(role, byRole);
        const value = byRole.get(key) ?? { views: new Set<string>(), components: new Map<string, number>() };
        byRole.set(key, value);
        value.views.add(result.id);
        bump(value.components, run.component, run.count);
        bump(textColours, `${role}: ${colourName(run.color, palette)}`, run.count);
      }
    }
  }

  // Insets of the pane body, by width.
  const insets = new Map<number, { left: Map<number, Set<string>>; right: Map<number, Set<string>>; top: Map<number, Set<string>> }>();
  for (const result of results) {
    if (result.kind !== "pane" || !result.measure.inset) continue;
    const entry = insets.get(result.width) ?? { left: new Map(), right: new Map(), top: new Map() };
    insets.set(result.width, entry);
    for (const side of ["left", "right", "top"] as const) {
      const value = Math.round(result.measure.inset[side]);
      const set = entry[side].get(value) ?? new Set<string>();
      set.add(result.id);
      entry[side].set(value, set);
    }
  }

  // Row heights.
  const rows = new Map<string, Map<number, { views: Set<string>; components: Map<string, number> }>>();
  for (const result of results) {
    if (result.width !== widths[widths.length - 1]) continue;
    for (const row of result.measure.rows) {
      const byHeight = rows.get(row.kind) ?? new Map();
      rows.set(row.kind, byHeight);
      const value = byHeight.get(row.height) ?? { views: new Set<string>(), components: new Map<string, number>() };
      byHeight.set(row.height, value);
      value.views.add(result.id);
      bump(value.components, row.component, row.count);
    }
  }

  // Colours against the theme.
  const colourUse = new Map<string, { views: Set<string>; components: Map<string, number> }>();
  for (const result of results) {
    if (result.width !== widths[widths.length - 1]) continue;
    const note = (colour: string, component: string, count: number) => {
      const name = colourName(colour, palette);
      const value = colourUse.get(name) ?? { views: new Set<string>(), components: new Map<string, number>() };
      colourUse.set(name, value);
      value.views.add(result.id);
      bump(value.components, component, count);
    };
    for (const run of result.measure.texts) note(run.color, run.component, run.count);
    for (const element of result.measure.elements ?? []) {
      if (element.background) note(element.background, element.component, element.count);
      if (element.borderColor) note(element.borderColor, element.component, element.count);
    }
  }

  const scan: StaticScan = await scanStatic(root, extraDirs);
  await Bun.write(join(out, "static.json"), JSON.stringify(scan, null, 1));
  const byArea = new Map<string, Map<string, number>>();
  for (const file of scan.files) {
    const area = byArea.get(file.area) ?? new Map<string, number>();
    byArea.set(file.area, area);
    for (const [category, count] of Object.entries(file.counts)) bump(area, category, count ?? 0);
  }
  const categories = ["colour", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "spacing", "border", "radius", "shadow", "derivedColour", "cellProps"];

  const fittedNote = fitted.size ? `Labels a heat map, treemap, graph or map fits to its own shapes are left out: ${fitted.size} sizes from ${Math.min(...fitted)} to ${Math.max(...fitted)}px.\n\n` : "";
  const sizesSection = fittedNote + widths.map((width) => {
    const sizes = [...(typeByWidth.get(width) ?? new Map())].sort((a, b) => b[1].views.size - a[1].views.size);
    return `### ${width}px: ${sizes.length} font sizes\n\n${table(["Size", "Views", "Runs", "Roles", "Drawn by"], sizes.map(([size, entry]) => [`${size}px`, entry.views.size, entry.runs, top(entry.roles, 4).map(([role, count]) => `${role} ${count}`).join(", "), top(entry.components, 3).map(([name]) => name).join(", ")]))}`;
  }).join("\n\n");
  const roleSection = table(["Role", "Variants", "Size/line height/weight: views (drawn by)"], [...roleSizes].sort((a, b) => b[1].size - a[1].size).map(([role, byKey]) => [role, byKey.size, [...byKey].sort((a, b) => b[1].views.size - a[1].views.size).slice(0, 6).map(([key, value]) => `${key}: ${value.views.size} (${top(value.components, 2).map(([name]) => name).join(", ")})`).join("; ")]));
  const insetSection = [...insets].sort((a, b) => a[0] - b[0]).map(([width, entry]) => `### ${width}px\n\n${(["left", "right", "top"] as const).map((side) => `- ${side}: ${[...entry[side]].sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([value, set]) => `${value}px in ${set.size} views`).join(", ")}`).join("\n")}`).join("\n\n");
  const rowSection = table(["Row", "Heights: views (drawn by)"], [...rows].map(([kind, byHeight]) => [kind, [...byHeight].sort((a, b) => b[1].views.size - a[1].views.size).slice(0, 6).map(([height, value]) => `${height}px: ${value.views.size} (${top(value.components, 2).map(([name]) => name).join(", ")})`).join("; ")]));
  const colourRoles = new Map<string, Map<string, number>>();
  for (const [key, count] of textColours) {
    const [role, colour] = key.split(": ") as [string, string];
    bump(colourRoles.get(role) ?? colourRoles.set(role, new Map()).get(role)!, colour, count);
  }
  const colourRoleSection = table(["Text role", "Colours (runs)"], [...colourRoles].sort((a, b) => b[1].size - a[1].size).map(([role, colours]) => [role, top(colours, 6).map(([colour, count]) => `${colour} ${count}`).join(", ")]));
  const colourSection = table(["Colour", "Views", "Drawn by"], [...colourUse].sort((a, b) => b[1].views.size - a[1].views.size).slice(0, 40).map(([name, value]) => [name, value.views.size, top(value.components, 4).map(([component]) => component).join(", ")]));
  const staticSection = `${table(["Area", "Literals", ...categories], [...byArea].map(([area, counts]) => [area, [...counts].filter(([category]) => category !== "cellProps" && category !== "derivedColour").reduce((sum, [, count]) => sum + count, 0), ...categories.map((category) => counts.get(category) ?? 0)]).sort((a, b) => Number(b[1]) - Number(a[1])))}\n\nFiles with the most literals:\n\n${table(["File", "Area", "Literals", "By kind"], scan.files.slice(0, 40).map((file) => [file.file, file.area, total(file), Object.entries(file.counts).map(([category, count]) => `${category} ${count}`).join(", ")]))}\n\nCell spacing props in panes (the terminal's units, drawn as cells on the desktop): ${top(new Map(Object.entries(scan.values.cellProps ?? {})), 16).map(([value, files]) => `${value} in ${files} files`).join(", ")}.`;

  const viewCount = viewIds.size;
  const paneViews = [...viewIds].filter((id) => results.find((result) => result.id === id)?.kind === "pane").length;
  const md = `# UI audit

${viewCount} views (${paneViews} pane views of ${new Set(results.filter((result) => result.kind === "pane").map((result) => result.token)).size} functions and plugin panes, ${viewCount - paneViews} shell views), at ${widths.join(" and ")} px, measured in the ${results[0]?.theme} theme. ${gated.size} views show a sign-in wall, gate or Pro lock. ${failed.length ? `Not measured (failed to open): ${failed.join(", ")}.` : ""}

## Element families

${table(["Family", "Variants", "Components", "Views", "Functions", "Functions off the main variant", "Kit share", "Most used variant's share", "Picture"], familyRows)}

A variant is one shape (height, padding, border, radius, shadow, type); colours are listed apart. Kit share is the share of elements drawn by a component of the shared kit (src/components/ui, src/ui, the DOM renderer, the readers and tables).

## Type

${sizesSection}

### By role (${widths[widths.length - 1]}px)

${roleSection}

## Content inset of the pane body

${insetSection}

## Row heights (${widths[widths.length - 1]}px)

${rowSection}

## Colours against the theme (${widths[widths.length - 1]}px)

Text colour by role:

${colourRoleSection}

Every colour drawn, as text, fill or border:

${colourSection}

## Static scan: literals that bypass the theme and the kit

${staticSection}

## Families in detail

${familyDetails.join("\n\n")}
`;
  await Bun.write(join(out, "report.md"), md);
  await Bun.write(join(out, "report.json"), JSON.stringify({
    views: viewCount, paneViews, widths, failed, gated: [...gated],
    families: familyReport,
    type: Object.fromEntries([...typeByWidth].map(([width, sizes]) => [width, [...sizes].map(([size, entry]) => ({ size, views: entry.views.size, runs: entry.runs, chars: entry.chars, roles: top(entry.roles, 20), components: top(entry.components, 20) }))])),
    roles: Object.fromEntries([...roleSizes].map(([role, byKey]) => [role, [...byKey].map(([key, value]) => ({ key, views: value.views.size, components: top(value.components, 10), sampleViews: [...value.views].slice(0, 10) }))])),
    insets: Object.fromEntries([...insets].map(([width, entry]) => [width, Object.fromEntries((["left", "right", "top"] as const).map((side) => [side, [...entry[side]].map(([value, set]) => ({ value, views: set.size, sample: [...set].slice(0, 12) }))]))])),
    rows: Object.fromEntries([...rows].map(([kind, byHeight]) => [kind, [...byHeight].map(([height, value]) => ({ height, views: value.views.size, components: top(value.components, 5) }))])),
    colours: [...colourUse].map(([name, value]) => ({ name, views: value.views.size, components: top(value.components, 8) })),
    textColours: top(textColours, 200),
    static: { byArea: Object.fromEntries([...byArea].map(([area, counts]) => [area, Object.fromEntries(counts)])), values: scan.values },
  }, null, 1));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = resolve(args.find((arg) => !arg.startsWith("--")) ?? ".");
  const extraDirs = args.flatMap((arg, index) => (arg === "--extra" && args[index + 1] ? [resolve(args[index + 1]!)] : []));
  await writeAuditReport(out, { extraDirs });
  if (args.includes("--sheets")) {
    await rm(join(out, "sheets"), { recursive: true, force: true });
    const written = await writeSheets(out);
    // Pictures another browser drew of the same views (views.jsonl), when there are some.
    for (const engine of await readdir(out)) {
      const match = /^(\w+)-shots$/.exec(engine);
      if (match) written.push(...await writeSheets(out, match[1], join(out, engine)));
    }
    console.log(`${written.length} sheets in ${join(out, "sheets")}`);
  }
  console.log(join(out, "report.md"));
}
