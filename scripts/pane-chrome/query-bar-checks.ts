import { click, evaluate, frames, waitFor, type Cdp } from "./browser";
import { QUERY_BAR_CASES } from "./query-bar-fixture";
import { QUERY_BAR_MEASURE, queryBarFailures, type QueryBarMeasure } from "./query-bar-measure";

/**
 * The query bar (query-bar-fixture.tsx) in the shapes the panes give it, from
 * 200 to 1440 px wide at the default and the largest text size. No two of its
 * controls may paint over each other at any width, where the price chart's
 * bar once drew Range, Extended hours and its interval over one another, and
 * nothing may be cut but by a strip that scrolls by itself: a bar short of
 * room drops its inline labels, shortens its toggles and folds its interval
 * and ranges into menus before it scrolls, where a half-scrolled range strip
 * once left a ghost of 1W beside Range. A bar too narrow even for that
 * scrolls; the widths below say where each bar still fits, at the default
 * text size. A bar that gave way opens again once it is wide enough, and a
 * folded range picks a range with a click.
 */

interface QueryBarStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

const WIDTHS = [200, 240, 280, 320, 360, 400, 480, 560, 640, 720, 800, 960, 1120, 1280, 1440];
/** The default text size and the largest the settings offer. */
const FONT_SIZES = [12, 20];
/**
 * The narrowest width, in px at 12 px text, at which each bar still fits once everything has given way, with room
 * for other fonts: below it the bar may scroll. A select chip keeps its label, so the bars with several are wide.
 */
const FITS_FROM: Record<string, number> = {
  "price chart, intraday": 280,
  "price chart, five years": 200,
  "generic future, total return, a date window": 560,
  "option chain": 200,
  "statement with an as-of": 344,
  "list with a search": 664,
  "a range alone": 200,
};
/** The one inline list that scrolls by itself (the option chain's expiries); every other inline choice shows whole or folds. */
const SCROLLING_STRIPS = ["expiration"];
/** The size every other step expects (checks.ts). */
const RESTORE = { width: 1400, height: 900 };

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

async function resize(cdp: Cdp, width: number): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await frames(cdp, 3);
}

const measureAll = (cdp: Cdp) => evaluate<QueryBarMeasure[]>(cdp, QUERY_BAR_MEASURE);

function caseMeasure(measures: QueryBarMeasure[], name: string): QueryBarMeasure {
  return measures.find((measure) => measure.name === name) ?? fail(`no query bar for "${name}"`, measures.map((measure) => measure.name));
}

/** What the price chart's bar shows: its texts, left to right. */
const texts = (measure: QueryBarMeasure) => measure.paints.filter((paint) => paint.kind === "text").map((paint) => paint.label);

export const queryBarSteps: QueryBarStep[] = [
  ...FONT_SIZES.map((font): QueryBarStep => ({
    name: `query bar at ${font} px text: no control paints over another from ${WIDTHS[0]} to ${WIDTHS.at(-1)} px, and none is cut where giving way fits it`,
    scenario: `query-bar&font=${font}`,
    async run(cdp) {
      const missing = QUERY_BAR_CASES.filter((bar) => FITS_FROM[bar.name] === undefined);
      if (missing.length) fail("give each query bar case the width it fits from", missing.map((bar) => bar.name));
      const problems: string[] = [];
      try {
        for (const width of WIDTHS) {
          await resize(cdp, width);
          for (const measure of await measureAll(cdp)) {
            const barMayScroll = width < FITS_FROM[measure.name]! * (font / 12);
            const failures = queryBarFailures(measure, { barMayScroll, strips: SCROLLING_STRIPS });
            if (failures.length) problems.push(`${width} px, ${measure.name}: ${failures[0]}${failures.length > 1 ? ` (and ${failures.length - 1} more)` : ""}`);
          }
        }
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
      }
      if (problems.length > 0) fail(`${problems.length} query bar layouts overlap or cut:\n     ${problems.slice(0, 16).join("\n     ")}`);
    },
  })),
  {
    name: "query bar: the price chart's bar gives way at 320 px and opens again at 1280 px",
    scenario: "query-bar",
    async run(cdp) {
      const bar = "price chart, intraday";
      try {
        await resize(cdp, 1280);
        const wide = texts(caseMeasure(await measureAll(cdp), bar));
        const full = ["Range", ...["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "ALL"], "Extended hours", "Auto (1m)"];
        if (full.some((text) => !wide.includes(text))) fail("at 1280 px the bar does not show every range, its label and the whole toggle", wide);
        await resize(cdp, 320);
        const narrow = texts(caseMeasure(await measureAll(cdp), bar));
        if (narrow.includes("Range") || narrow.includes("1W") || !narrow.includes("1D") || !narrow.includes("Ext hours")) {
          fail("at 320 px the bar did not drop Range, shorten Extended hours and fold the ranges", narrow);
        }
        await resize(cdp, 1280);
        const again = texts(caseMeasure(await measureAll(cdp), bar));
        if (again.join("|") !== wide.join("|")) fail("back at 1280 px the bar is not what it was", { before: wide, after: again });
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
      }
    },
  },
  {
    name: "query bar: at 320 px a click on the folded range opens its menu and a click on 5Y picks it",
    scenario: "query-bar",
    async run(cdp) {
      const caseSelector = JSON.stringify('[data-query-bar-case="price chart, intraday"]');
      try {
        await resize(cdp, 320);
        const chip = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
          const button = document.querySelector(${caseSelector})?.querySelector("button[aria-haspopup=listbox]");
          const r = button?.getBoundingClientRect();
          return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()`) ?? fail("no folded range at 320 px");
        await click(cdp, chip);
        const item = await waitFor<{ x: number; y: number } | null>(cdp, `(() => {
          const option = [...document.querySelectorAll(".gloom-menu-item")].find((element) => element.textContent?.trim() === "5Y");
          const r = option?.getBoundingClientRect();
          return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
        })()`) ?? fail("the folded range opened no menu with 5Y in it");
        await click(cdp, item);
        await frames(cdp, 2);
        const shown = texts(caseMeasure(await measureAll(cdp), "price chart, intraday"));
        if (!shown.includes("5Y") || shown.includes("1D")) fail("the folded range does not show 5Y after picking it", shown);
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
      }
    },
  },
];
