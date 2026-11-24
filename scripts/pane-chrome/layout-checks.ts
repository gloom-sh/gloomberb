import { click, evaluate, frames, sleep, waitFor, type Cdp } from "./browser";
import { LAYOUT_MEASURE, layoutFailures, type LayoutMeasure } from "./layout-measure";

/**
 * Where content stops on the desktop and the web (layout-fixture.tsx): at
 * three window sizes, docked and floating, every pane body runs to the footer
 * and every wrapped text uses the width it sits in. A box sized in cells, or
 * text wrapped at a count of columns, leaves a band above the footer or a gap
 * at the right edge that grows and shrinks with the pane. The open
 * Trials study, and the Changelog version and the release in it, are opened
 * as a person does, by double clicking a row, and each level is measured.
 *
 * The full registry, on the real web build: `bun run check:pane-layout`
 * (layout-sweep.ts).
 */

interface LayoutStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

/** Window sizes: a laptop, a desktop, and a narrow window taller than it is wide. */
export const LAYOUT_SIZES = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
  { width: 720, height: 900 },
] as const;

/** The size every other step expects (checks.ts). */
const RESTORE = { width: 1400, height: 900 };

/** `opens`: what a double click on a row opens, then on a row in that, and so on. */
const PANES: Array<{ id: string; label: string; opens?: string[] }> = [
  { id: "trials", label: "Trials study", opens: ["a study"] },
  { id: "changelog", label: "Changelog version and release", opens: ["a version", "a release"] },
  { id: "askg", label: "Ask Gloom answer" },
  { id: "risk", label: "10-K risk factors" },
  { id: "ek", label: "8-K events feed" },
  { id: "reader", label: "article reader" },
  { id: "markdown", label: "markdown in a detail body" },
  { id: "prose", label: "prose paragraphs in a detail body" },
  { id: "table", label: "table" },
  { id: "inline", label: "page of a table as tall as its rows and label and value rows" },
  { id: "chart-rows", label: "chart sized in rows under a query bar" },
  { id: "list", label: "series list and its detail under a query bar" },
];

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

async function doubleClick(cdp: Cdp, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  for (const clickCount of [1, 2]) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount });
  }
  await frames(cdp, 2);
}

async function openLayout(cdp: Cdp, paneId: string, mode: "dock" | "float", size: { width: number; height: number }): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
  const url = await evaluate<string>(cdp, `(() => { const url = new URL(location.href); url.search = "?scenario=layout&pane=${paneId}&mode=${mode}"; return url.href; })()`);
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;
  if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) fail("the layout fixture did not render");
}

async function measure(cdp: Cdp, instanceId: string): Promise<LayoutMeasure> {
  // Fonts and the reader's own measuring settle in a frame or two.
  await frames(cdp, 3);
  await sleep(50);
  return await evaluate<LayoutMeasure>(cdp, LAYOUT_MEASURE(instanceId));
}

/** The pane, then each level `opens` names, measured as it opens; the last level stays open. */
async function measureOpen(cdp: Cdp, paneId: string, opens: string[] = []): Promise<Array<{ level: string; measure: LayoutMeasure }>> {
  const instanceId = `${paneId}:layout`;
  const pane = `document.querySelector('[data-gloom-pane-id="${instanceId}"]')`;
  const body = `${pane}?.querySelector("[data-gloom-role=pane-body]")`;
  const detail = `${pane}?.querySelector("[data-gloom-role=page-stack-detail]")`;
  if (!await waitFor(cdp, `(${body}?.innerText?.length ?? 0) > 100 || ${body}?.querySelector("canvas") != null`, 10_000)) {
    fail(`${paneId} drew no content`, await evaluate(cdp, `${pane}?.innerText?.slice(0, 200)`));
  }
  if (opens.length === 0) return [{ level: "", measure: await measure(cdp, instanceId) }];
  const measures: Array<{ level: string; measure: LayoutMeasure }> = [];
  for (const [index, opened] of opens.entries()) {
    // The first row of the pane, then the first row of what is open.
    const within = index === 0 ? pane : detail;
    const before = await evaluate<string>(cdp, `${detail}?.innerText ?? ""`);
    const row = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
      const row = ${within}?.querySelector("[data-gloom-role=data-table-row]");
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.x + r.width / 3, y: r.y + r.height / 2 };
    })()`) ?? fail(`${paneId} has no row to open ${opened}`);
    await doubleClick(cdp, row.x, row.y);
    // A reader (a study, a release) opens on its text; a list (a version's updates) on its table.
    if (!await waitFor(cdp, `(() => {
      const open = ${detail};
      const text = open?.innerText ?? "";
      if (text === ${JSON.stringify(before)}) return false;
      return text.length > 300 || open?.querySelector("[data-gloom-role=data-table-row]") != null;
    })()`, 5_000)) {
      fail(`double clicking a row did not open ${opened}`);
    }
    measures.push({ level: `${opened}: `, measure: await measure(cdp, instanceId) });
  }
  return measures;
}

export const layoutSteps: LayoutStep[] = PANES.flatMap(({ id, label, opens }) => (["dock", "float"] as const).map((mode): LayoutStep => ({
  name: `layout: the ${label} runs to the footer and across its width, ${mode === "dock" ? "docked" : "floating"}, at three window sizes`,
  scenario: `layout&pane=${id}&mode=${mode}`,
  async run(cdp) {
    const problems: string[] = [];
    try {
      for (const size of LAYOUT_SIZES) {
        await openLayout(cdp, id, mode, size);
        for (const { level, measure } of await measureOpen(cdp, id, opens)) {
          if (measure.missing) fail(`no ${id} pane at ${size.width}x${size.height}`);
          for (const failure of layoutFailures(measure)) problems.push(`${size.width}x${size.height}: ${level}${failure}`);
        }
        // The release's last line is a link, not the markdown it was written as.
        if (id === "changelog") {
          const read = await evaluate<{ links: string[]; raw: boolean }>(cdp, `(() => {
            const detail = document.querySelector('[data-gloom-pane-id="changelog:layout"] [data-gloom-role=page-stack-detail]');
            return { links: [...detail.querySelectorAll("[role=link]")].map((link) => link.textContent), raw: detail.innerText.includes("](") };
          })()`);
          if (read.links.join("|") !== "Full diff" || read.raw) problems.push(`${size.width}x${size.height}: the release's markdown link did not read as a link (${JSON.stringify(read)})`);
          else {
            const spot = await evaluate<{ x: number; y: number }>(cdp, `(() => {
              const link = document.querySelector('[data-gloom-pane-id="changelog:layout"] [data-gloom-role=page-stack-detail] [role=link]');
              link.scrollIntoView({ block: "center" });
              const r = link.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()`);
            await click(cdp, spot);
            const opened = await evaluate<string[]>(cdp, "window.__paneChrome.externalOpens");
            if (opened.join("|") !== "https://example.invalid/compare/v0.9.8...v0.9.9") problems.push(`${size.width}x${size.height}: a click on the release's link opened ${JSON.stringify(opened)}`);
          }
        }
        // A value that fits the row's pixels shows whole: clipped in CSS where it ends, never cut at a count of columns.
        const cut = await evaluate<string[]>(cdp, `[...document.querySelectorAll('[data-gloom-pane-id="${id}:layout"] [data-gloom-ui=key-value-row]')].map((row) => row.innerText.trim()).filter((text) => /(\\.\\.\\.|\\u2026)$/.test(text))`);
        for (const text of cut) problems.push(`${size.width}x${size.height}: a label and value row cut its value at a column count ("${text.replace(/\s+/g, " ").slice(0, 60)}")`);
        // Rows side by side share their row: none is pushed past the pane's edge, where only its first letter shows.
        const past = await evaluate<string[]>(cdp, `(() => { const pane = document.querySelector('[data-gloom-pane-id="${id}:layout"]'); const edge = pane.getBoundingClientRect().right; return [...pane.querySelectorAll('[data-gloom-ui=key-value-row]')].filter((row) => row.getBoundingClientRect().right > edge + 1).map((row) => row.innerText.trim()); })()`);
        for (const text of past) problems.push(`${size.width}x${size.height}: a label and value row runs past the pane's right edge ("${text.replace(/\s+/g, " ").slice(0, 60)}")`);
      }
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
    }
    if (problems.length > 0) fail(problems.join("\n     "));
  },
})));

/**
 * Prose a pane sets in the app's own type reads in the reading column
 * (`ReaderMeasure`, reader-text.tsx): a call's transcript and summary, an Ask
 * Gloom answer with its tables and citations, and a 10-K's risk factors. In
 * a wide window the column is the measure of its type, centred, and no line
 * holds more characters than that; in a narrow one it takes the pane's width.
 * Nothing in it runs past its edge.
 */
const MEASURED: Array<{ query: string; pane: string; label: string; shows: string }> = [
  { query: "pane=calls&reader=transcript", pane: "calls", label: "a call's transcript", shows: "Mara Ellison" },
  { query: "pane=calls&reader=summary", pane: "calls", label: "a call's summary", shows: "Analysts Pressed On" },
  { query: "pane=askg", pane: "askg", label: "an Ask Gloom answer", shows: "Change over" },
  { query: "pane=risk", pane: "risk", label: "a 10-K's risk factors", shows: "All Risk Factors" },
];

const READING_COLUMN = (paneId: string) => `(() => {
  const pane = document.querySelector('[data-gloom-pane-id="${paneId}"]');
  const column = pane?.querySelector("[data-gloom-ui=reader-measure]");
  if (!column) return null;
  const C = column.getBoundingClientRect();
  const P = column.parentElement.getBoundingClientRect();
  const parent = getComputedStyle(column.parentElement);
  const inner = { left: P.left + parseFloat(parent.paddingLeft), right: P.right - parseFloat(parent.paddingRight) };
  // The measure in the column's own type.
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
  probe.textContent = "0".repeat(66);
  column.appendChild(probe);
  const measure = probe.getBoundingClientRect().width;
  probe.remove();
  // Characters on each rendered line of text in the column.
  let most = 0, sample = "";
  const one = document.createRange();
  const walker = document.createTreeWalker(column, NodeFilter.SHOW_TEXT);
  const rows = new Map();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent;
    for (let i = 0; i < text.length && i < 4000; i++) {
      one.setStart(node, i); one.setEnd(node, i + 1);
      const q = [...one.getClientRects()].find((r) => r.width > 0);
      if (!q) continue;
      const key = Math.round(q.top / 2);
      const row = rows.get(key) ?? { left: q.left, right: q.left, text: "" };
      // A space where a line wraps hangs past the edge in CSS; only ink counts.
      if (/\\S/.test(text[i])) { row.left = Math.min(row.left, q.left); row.right = Math.max(row.right, q.right); }
      row.text += text[i];
      rows.set(key, row);
    }
  }
  const past = [];
  for (const row of rows.values()) {
    const chars = row.text.replace(/\\s+$/, "").length;
    if (chars > most) { most = chars; sample = row.text.slice(0, 40); }
    if (row.right > C.right + 1) past.push(row.text.slice(0, 40) + " (" + Math.round(row.right - C.right) + "px)");
  }
  return { width: C.width, measure, left: C.left - inner.left, right: inner.right - C.right, available: inner.right - inner.left, most, sample, past };
})()`;

const READING_SIZES = [
  { name: "wide", width: 1440, height: 900 },
  { name: "narrow", width: 400, height: 900 },
] as const;

layoutSteps.push({
  name: "layout: a call's transcript and summary, an Ask Gloom answer and RISK read in the reading column, centred wide and the pane's width narrow",
  scenario: "layout&pane=calls&mode=dock",
  async run(cdp) {
    const problems: string[] = [];
    try {
      for (const { query, pane, label, shows } of MEASURED) {
        for (const size of READING_SIZES) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
          const url = await evaluate<string>(cdp, `(() => { const url = new URL(location.href); url.search = "?scenario=layout&${query}&mode=dock"; return url.href; })()`);
          const loaded = cdp.once("Page.loadEventFired");
          await cdp.send("Page.navigate", { url });
          await loaded;
          if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) fail(`the ${pane} fixture did not render`);
          const paneId = `${pane}:layout`;
          if (!await waitFor(cdp, `(document.querySelector('[data-gloom-pane-id="${paneId}"]')?.innerText ?? "").includes(${JSON.stringify(shows)})`, 10_000)) {
            fail(`${label} did not open`, await evaluate(cdp, `document.querySelector('[data-gloom-pane-id="${paneId}"]')?.innerText?.slice(0, 200)`));
          }
          await frames(cdp, 3);
          const column = await evaluate<{ width: number; measure: number; left: number; right: number; available: number; most: number; sample: string; past: string[] } | null>(cdp, READING_COLUMN(paneId));
          const at = `${label} at ${size.width}px`;
          if (!column) { problems.push(`${at}: no reading column`); continue; }
          if (column.most > 66) problems.push(`${at}: a line holds ${column.most} characters ("${column.sample}")`);
          if (column.past.length > 0) problems.push(`${at}: lines run past the column's edge: ${column.past.join(" | ")}`);
          if (size.name === "wide") {
            if (Math.abs(column.width - column.measure) > 1) problems.push(`${at}: the column is ${Math.round(column.width)}px, the measure ${Math.round(column.measure)}px`);
            if (Math.abs(column.left - column.right) > 1) problems.push(`${at}: the column is not centred (${Math.round(column.left)}px left, ${Math.round(column.right)}px right)`);
          } else if (Math.abs(column.width - column.available) > 1) {
            problems.push(`${at}: the column is ${Math.round(column.width)}px of the ${Math.round(column.available)}px the pane gives it`);
          }
        }
      }
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
    }
    if (problems.length > 0) fail(problems.join("\n     "));
  },
});
