import { click, evaluate, frames, type Cdp } from "./browser";
import { HEADER_UPDATE_STATES } from "./header-fixture";
import { HEADER_MEASURE, headerControl, headerFailures, type HeaderMeasure } from "./header-measure";

/**
 * The app's top bar (header-fixture.tsx) in every update state, with the
 * command bar closed and open, at window widths from 520 to 1440 px, as the
 * macOS title bar (also in full screen and at the largest text size), the
 * Windows one with its caption buttons, Linux and the web app draw it. No two
 * of its items may paint over each other, and nothing may be cut by its slot
 * or the window edge instead of ending in an ellipsis of its own: the update
 * status gives way, Help and the market summary keep their room (GLO-767,
 * where Restart ran under Help and Help over the market summary). At the
 * narrowest width a real click on Restart restarts and one on Help opens Help.
 */

interface HeaderStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

const WIDTHS = [520, 640, 800, 1000, 1440];
/** The size every other step expects (checks.ts). */
const RESTORE = { width: 1400, height: 900 };

/**
 * `clickAt`: where the click step runs, when not at the narrowest width. At the
 * largest text size a 640 px window has room for Help and the prompt but not
 * for Restart beside them, so the status gives way there.
 */
const MODES: Array<{ label: string; query: string; fullscreen?: boolean; widths?: number[]; clickAt?: number }> = [
  { label: "macOS title bar", query: "platform=darwin" },
  { label: "macOS title bar in full screen", query: "platform=darwin", fullscreen: true },
  { label: "Windows title bar with caption buttons", query: "platform=win32" },
  { label: "Linux title bar", query: "platform=linux" },
  { label: "web app", query: "host=browser&platform=darwin" },
  // The desktop window is never narrower than 640 px.
  { label: "macOS title bar at the largest text size", query: "platform=darwin&font=20", widths: [640, 800, 1000, 1440], clickAt: 800 },
];

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}\n     ${JSON.stringify(detail)}`);
}

async function resize(cdp: Cdp, width: number): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 400, deviceScaleFactor: 1, mobile: false });
  await frames(cdp, 2);
}

async function measureState(cdp: Cdp, state: string): Promise<HeaderMeasure | null> {
  await evaluate(cdp, `window.__paneChrome.header.show(${JSON.stringify(state)})`);
  await frames(cdp, 2);
  return await evaluate<HeaderMeasure | null>(cdp, HEADER_MEASURE);
}

const presses = (cdp: Cdp) => evaluate<{ restarts: number; helpOpens: number }>(
  cdp,
  "({ restarts: window.__paneChrome.header.restarts, helpOpens: window.__paneChrome.header.helpOpens })",
);

const center = (box: { left: number; right: number; top: number; bottom: number }) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

export const headerSteps: HeaderStep[] = MODES.flatMap(({ label, query, fullscreen, widths = WIDTHS, clickAt = widths[0]! }): HeaderStep[] => [
  {
    name: `top bar (${label}): every update state fits beside Help and the market summary from ${widths[0]} to ${widths.at(-1)} px, the command bar closed and open`,
    scenario: `header&${query}`,
    async run(cdp) {
      const problems: string[] = [];
      try {
        if (fullscreen) await evaluate(cdp, "window.__paneChrome.header.fullscreen(true)");
        for (const width of widths) {
          await resize(cdp, width);
          for (const open of [false, true]) {
            await evaluate(cdp, `window.__paneChrome.header.commandBar(${open})`);
            for (const state of Object.keys(HEADER_UPDATE_STATES)) {
              const measure = await measureState(cdp, state);
              for (const failure of headerFailures(measure)) problems.push(`${width} px, ${state}${open ? ", command bar open" : ""}: ${failure}`);
            }
          }
        }
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
      }
      if (problems.length > 0) fail(`${problems.length} layouts of the top bar overlap or cut:\n     ${problems.slice(0, 12).join("\n     ")}`);
    },
  },
  {
    name: `top bar (${label}): at ${clickAt} px a click on Restart restarts and a click on Help opens Help`,
    scenario: `header&${query}`,
    async run(cdp) {
      try {
        if (fullscreen) await evaluate(cdp, "window.__paneChrome.header.fullscreen(true)");
        await resize(cdp, clickAt);
        const measure = await measureState(cdp, "ready");
        const restart = headerControl(measure, "Restart") ?? fail("no Restart button in the top bar", measure?.items.map((item) => item.name));
        const help = headerControl(measure, "Open Help") ?? fail("no Help button in the top bar", measure?.items.map((item) => item.name));
        await click(cdp, center(restart));
        const afterRestart = await presses(cdp);
        if (afterRestart.restarts !== 1 || afterRestart.helpOpens !== 0) fail("a click on Restart did not restart, and only restart", afterRestart);
        await click(cdp, center(help));
        const afterHelp = await presses(cdp);
        if (afterHelp.restarts !== 1 || afterHelp.helpOpens !== 1) fail("a click on Help did not open Help, and only Help", afterHelp);
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { ...RESTORE, deviceScaleFactor: 1, mobile: false });
      }
    },
  },
]);
