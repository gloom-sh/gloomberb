import { expect, test } from "bun:test";
import { ALLOWLIST_PATH, checkTokens, formatTokenAllowlist, valueKey, viewKey, type ResultLine, type TokenAllowlist } from "./ui-tokens";

const run = (over: Record<string, unknown> = {}) => ({
  region: "pane-body", roles: "pane-content", tags: "", component: "Text", chain: "Text<Pane", fontSize: 12, lineHeight: 18, fontWeight: 400,
  fontFamily: "mono", italic: false, uppercase: false, letterSpacing: 0, underline: false, color: "", background: "", count: 1, chars: 4, lines: 1,
  left: 8, rightGap: 8, top: 4, sample: "Text", ...over,
});
const element = (shape: string) => ({ family: "button", region: "pane-body", component: "Button", chain: "Button<Pane", roles: "", state: "", shape, color: "", background: "", borderColor: "", count: 1, sample: null, text: "Go" });
function view(id: string, texts: unknown[], elements: unknown[] = [], kind: "pane" | "shell" = "pane", plugin?: string): ResultLine {
  return { id, kind, token: id.split("--")[0]!, ...(plugin ? { plugin } : {}), view: "root", width: 1280, measure: { texts, elements } as never };
}

test("values off the tokens fail, and what a chart fits, a spinner turns or a shell has no inset for does not", () => {
  const { failing } = checkTokens([
    view("AAA--root", [
      run({ fontSize: 13, component: "Stray" }),
      run({ fontWeight: 600, component: "Heavy" }),
      run({ left: 0, component: "Flush" }),
      run({ left: 7.6, component: "Subpixel" }),
      // A heat map tile's label is fitted; a map legend's is not.
      run({ fontSize: 9.5, chain: "DomHeatTile<HeatTreemapSurface" }),
      run({ fontSize: 11, chain: "GeoLegend<WorldVenueMap", roles: "geo-legend" }),
      run({ left: 0.8, component: "StaticXAxisLabels", roles: "chart-axis" }),
      run({ left: 4.1, component: "SpinnerMark", roles: "spinner<pane-status" }),
    ], [element("h=18 radius=6 font=12/400"), element("h=18 radius=6 6 4 0 font=12/400")]),
    view("shell", [run({ left: 0, region: "app-header" })], [], "shell"),
  ], {});
  expect(failing.map((violation) => `${violation.measure} ${violation.value} ${violation.component}`).sort()).toEqual([
    "font size 11 Text", "font size 13 Stray", "font weight 600 Heavy", "inset 0 Flush", "radius 4 Button",
  ]);
});

test("an allowlist entry covers its function's matching values only, and one nothing matched is named", () => {
  const allowlist: TokenAllowlist = {
    AAA: [{ measure: "font size", value: 31, component: "SvgText", why: "A gauge's figure." }, { measure: "inset", why: "Unused." }],
    ZZZ: [{ measure: "radius", why: "Not measured this run." }],
  };
  const { failing, allowed, unused } = checkTokens([
    view("AAA--root", [run({ fontSize: 31, component: "SvgText" }), run({ fontSize: 31, component: "Other" })]),
    view("BBB--root", [run({ fontSize: 31, component: "SvgText" })]),
  ], allowlist);
  expect(allowed.map((violation) => violation.view)).toEqual(["AAA--root"]);
  expect(failing.map((violation) => `${violation.view} ${violation.component}`)).toEqual(["AAA--root Other", "BBB--root SvgText"]);
  expect(unused).toEqual(["AAA: 1"]);
});

test("a registry plugin's value warns when its recording had it or cannot tell, and fails when the change made it", () => {
  const results = [
    view("REG--root", [run({ fontSize: 13, component: "Own" }), run({ fontSize: 11, component: "New" })], [], "pane", "reg"),
    view("REG--detail", [run({ fontSize: 13, component: "Own" })], [], "pane", "reg"),
    view("BUN--root", [run({ fontSize: 13, component: "Own" })], [], "pane", "bundled"),
  ];
  const plugins = new Set(["reg"]);
  const recording = checkTokens(results, {}, { plugins, known: null });
  // Nothing to compare with: the registry plugin's values warn, a bundled plugin's still fail.
  expect(recording.failing.map((violation) => violation.view)).toEqual(["BUN--root"]);
  expect(recording.warned).toHaveLength(3);
  // On the recording's snapshot, a value it had warns; one it had not fails; a view it never measured warns.
  const known = { views: [viewKey("REG--root", 1280)], values: [valueKey(recording.warned[0]!)] };
  const later = checkTokens(results, {}, { plugins, known });
  expect(later.failing.map((violation) => `${violation.view} ${violation.component}`)).toEqual(["REG--root New", "BUN--root Own"]);
  expect(later.warned.map((violation) => `${violation.view} ${violation.component}`)).toEqual(["REG--root Own", "REG--detail Own"]);
});

test("the UI tokens allowlist is sorted and says why each value stays", async () => {
  const text = await Bun.file(ALLOWLIST_PATH).text();
  const allowlist: TokenAllowlist = JSON.parse(text);
  expect(text).toBe(formatTokenAllowlist(allowlist));
  for (const [token, entries] of Object.entries(allowlist)) {
    for (const entry of entries) expect(entry.why.trim(), `${token}: say why ${entry.measure} ${entry.value ?? ""} stays`).not.toBe("");
  }
});
