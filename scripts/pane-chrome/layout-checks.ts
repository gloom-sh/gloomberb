import { click, evaluate, frames, sleep, waitFor, type Cdp } from "./browser";
import { LAYOUT_MEASURE, layoutFailures, type LayoutMeasure } from "./layout-measure";

/**
 * Where content stops on the desktop and the web (layout-fixture.tsx): at
 * three window sizes, docked and floating, every pane body runs to the footer
 * and every wrapped text uses the width it sits in. A box sized in cells, or
 * text wrapped at a count of columns, leaves a band above the footer or a gap
 * at the right edge that grows and shrinks with the pane. The open
 * Trials study and Changelog release are opened as a person does, by double
 * clicking a row.
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

const PANES: Array<{ id: string; label: string; opens?: string }> = [
  { id: "trials", label: "Trials study", opens: "a study" },
  { id: "changelog", label: "Changelog release", opens: "a release" },
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

async function measureOpen(cdp: Cdp, paneId: string, opens: string | undefined): Promise<LayoutMeasure> {
  const instanceId = `${paneId}:layout`;
  const pane = `document.querySelector('[data-gloom-pane-id="${instanceId}"]')`;
  const body = `${pane}?.querySelector("[data-gloom-role=pane-body]")`;
  if (!await waitFor(cdp, `(${body}?.innerText?.length ?? 0) > 100 || ${body}?.querySelector("canvas") != null`, 10_000)) {
    fail(`${paneId} drew no content`, await evaluate(cdp, `${pane}?.innerText?.slice(0, 200)`));
  }
  if (opens) {
    const row = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
      const row = ${pane}.querySelector("[data-gloom-role=data-table-row]");
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.x + r.width / 3, y: r.y + r.height / 2 };
    })()`) ?? fail(`${paneId} has no row to open`);
    await doubleClick(cdp, row.x, row.y);
    if (!await waitFor(cdp, `(${pane}.querySelector("[data-gloom-role=page-stack-detail]")?.innerText?.length ?? 0) > 300`, 5_000)) {
      fail(`double clicking a row did not open ${opens}`);
    }
  }
  // Fonts and the reader's own measuring settle in a frame or two.
  await frames(cdp, 3);
  await sleep(50);
  return await evaluate<LayoutMeasure>(cdp, LAYOUT_MEASURE(instanceId));
}

export const layoutSteps: LayoutStep[] = PANES.flatMap(({ id, label, opens }) => (["dock", "float"] as const).map((mode): LayoutStep => ({
  name: `layout: the ${label} runs to the footer and across its width, ${mode === "dock" ? "docked" : "floating"}, at three window sizes`,
  scenario: `layout&pane=${id}&mode=${mode}`,
  async run(cdp) {
    const problems: string[] = [];
    try {
      for (const size of LAYOUT_SIZES) {
        await openLayout(cdp, id, mode, size);
        const measure = await measureOpen(cdp, id, opens);
        if (measure.missing) fail(`no ${id} pane at ${size.width}x${size.height}`);
        for (const failure of layoutFailures(measure)) problems.push(`${size.width}x${size.height}: ${failure}`);
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
