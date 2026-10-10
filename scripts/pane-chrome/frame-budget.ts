import { appendFile } from "fs/promises";
import { join, resolve } from "path";
import { median, positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, frames, launchBrowser, mouse, sleep, waitFor, type Cdp, type Point } from "./browser";
import { serveFixturePage, type FixturePage } from "./page";

/**
 * Frame budget of a pane drag, against a base checkout. Each run drags a
 * docked and a floating pane across a dense layout (fixture.tsx, `perf`) for
 * 1.5 s with real pointer input at 60 moves a second, and reads what the page's
 * main thread spent (Performance.getMetrics, in thread time), the React commits
 * and the frames drawn. Base and this checkout take turns, so a runner that
 * slows down mid-job slows both, and the gate is a ratio of the medians:
 * absolute numbers mean little on a shared runner with no GPU.
 *
 *   bun run benchmark:pane-drag:compare --base <checkout> [--runs 5] [--head <checkout>]
 *
 * `--head` measures another checkout in place of this one.
 */

const VIEWPORT = { width: 1400, height: 900 };
const DRAG_MS = 1_500;
const MOVE_INTERVAL_MS = 1_000 / 60;
// Calibrated on main with identical code on both sides: the medians of five
// runs differed by at most 1.06x quiet and 1.17x on a 12-core host at load 35,
// and React commits by at most 3. The drag that re-rendered on every move
// (v0.16.1) costs 5 to 7 times as much per frame with 10 times the commits,
// and a slide written to the inline style instead of an animation (a whole-page
// relayering every frame) twice as much.
const MAX_FRAME_RATIO = 1.5;
const MIN_FRAME_DELTA_MS = 0.4;
const MAX_COMMIT_RATIO = 1.5;
const MIN_COMMIT_DELTA = 10;

/** Counts React commits through the DevTools hook React looks for when it loads. */
const COMMIT_COUNTER = `
window.__commits = 0;
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, isDisabled: false, renderers: new Map(),
  inject() { return 1; },
  onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  onCommitFiberRoot() { window.__commits += 1; },
};
`;

interface DragSample {
  /** Main-thread time (script, style, layout, paint and the rest) per frame drawn, ms. */
  mainMsPerFrame: number;
  scriptMsPerFrame: number;
  styleLayoutMsPerFrame: number;
  commits: number;
  frames: number;
  /** Frames that took longer than 1.5 display frames. */
  droppedFrames: number;
}

interface Scenario {
  name: string;
  /** Where the press lands, and where the pointer is `t` (0 to 1) into the drag. */
  grab(cdp: Cdp): Promise<Point>;
  path(start: Point, t: number): Point;
}

const partCenter = (selector: string) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 16), y: r.y + r.height / 2 }; })()`;

const SCENARIOS: Scenario[] = [
  {
    name: "docked pane drag",
    grab: (cdp) => evaluate(cdp, partCenter("[data-gloom-pane-id='table:5'] [data-gloom-role=pane-grip]")),
    // Over the other docked panes and their drop grids, and back.
    path: (start, t) => ({ x: start.x - Math.sin(t * Math.PI) * 420, y: start.y + Math.sin(t * Math.PI * 2) * 220 }),
  },
  {
    name: "floating pane drag",
    grab: (cdp) => evaluate(cdp, partCenter("[data-gloom-pane-id='table:float'] [data-gloom-role=pane-title]")),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 360, y: start.y + (1 - Math.cos(t * Math.PI * 2)) * 140 }),
  },
];

async function metrics(cdp: Cdp): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics");
  return Object.fromEntries(list.map((metric) => [metric.name, metric.value]));
}

async function measureDrag(cdp: Cdp, page: FixturePage, scenario: Scenario): Promise<DragSample> {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: new URL("?scenario=perf", page.url).href });
  await loaded;
  if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) throw new Error("the perf fixture did not render");
  await frames(cdp, 10);
  const start = await scenario.grab(cdp);
  await mouse(cdp, "mouseMoved", start.x, start.y, false);
  await mouse(cdp, "mousePressed", start.x, start.y, true);
  await evaluate(cdp, `(() => {
    window.__frameTimes = [];
    window.__commits = 0;
    let last = performance.now();
    window.__recording = true;
    const tick = (now) => { window.__frameTimes.push(now - last); last = now; if (window.__recording) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
  const before = await metrics(cdp);
  const began = performance.now();
  for (let move = 1; ; move += 1) {
    const t = (performance.now() - began) / DRAG_MS;
    if (t >= 1) break;
    const at = scenario.path(start, t);
    await mouse(cdp, "mouseMoved", at.x, at.y, true);
    const wait = began + move * MOVE_INTERVAL_MS - performance.now();
    if (wait > 0) await sleep(wait);
  }
  const after = await metrics(cdp);
  const recorded = await evaluate<{ frameTimes: number[]; commits: number }>(cdp, "(() => { window.__recording = false; return { frameTimes: window.__frameTimes.slice(1), commits: window.__commits }; })()");
  const end = scenario.path(start, 1);
  await mouse(cdp, "mouseReleased", end.x, end.y, false);
  const drawn = Math.max(1, recorded.frameTimes.length);
  const ms = (name: string) => (after[name]! - before[name]!) * 1000;
  return {
    mainMsPerFrame: ms("TaskDuration") / drawn,
    scriptMsPerFrame: ms("ScriptDuration") / drawn,
    styleLayoutMsPerFrame: (ms("RecalcStyleDuration") + ms("LayoutDuration")) / drawn,
    commits: recorded.commits,
    frames: recorded.frameTimes.length,
    droppedFrames: recorded.frameTimes.filter((time) => time > 1.5 * (1000 / 60)).length,
  };
}

async function runSide(page: FixturePage, label: string): Promise<Record<string, DragSample>> {
  const browser = await launchBrowser(`budget-${label}`, VIEWPORT.width, VIEWPORT.height);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: COMMIT_COUNTER });
    await browser.cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const samples: Record<string, DragSample> = {};
    for (const scenario of SCENARIOS) samples[scenario.name] = await measureDrag(browser.cdp, page, scenario);
    return samples;
  } finally {
    await browser.close();
  }
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseRoot = takeOption(args, "--base");
  if (!baseRoot) throw new Error("Usage: frame-budget.ts --base <checkout> [--runs 5] [--head <checkout>]");
  const runs = positiveInteger(takeOption(args, "--runs"), 5, "--runs");
  const sides = {
    base: await serveFixturePage(resolve(baseRoot), cacheDir("build", `budget-base-${process.pid}`)),
    head: await serveFixturePage(resolve(takeOption(args, "--head") ?? join(import.meta.dir, "../..")), cacheDir("build", `budget-head-${process.pid}`)),
  };
  const samples: Record<keyof typeof sides, Array<Record<string, DragSample>>> = { base: [], head: [] };
  let verdict: { lines: string[]; problems: string[] };
  try {
    // A result over budget is measured again, on twice the runs, before it
    // fails: one slow stretch of a shared runner should not fail a PR.
    for (let attempt = 1; ; attempt += 1) {
      for (let run = 1; run <= runs; run += 1) {
        for (const side of ["base", "head"] as const) {
          const result = await runSide(sides[side], side);
          samples[side].push(result);
          console.error(`${side} ${samples[side].length}: ${Object.entries(result).map(([name, sample]) => `${name} ${round(sample.mainMsPerFrame)} ms/frame, ${sample.commits} commits`).join("; ")}`);
        }
      }
      verdict = judge(samples);
      if (verdict.problems.length === 0 || attempt === 2) break;
      console.error("Over budget; measuring again.");
    }
  } finally {
    await sides.base.close();
    await sides.head.close();
  }

  const markdown = `${verdict.lines.join("\n")}\n`;
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (verdict.problems.length > 0) process.exitCode = 1;
}

function judge(samples: Record<"base" | "head", Array<Record<string, DragSample>>>): { lines: string[]; problems: string[] } {
  const runs = samples.head.length;
  const lines = [
    "### Pane drag frame budget",
    "",
    `Middle value of ${runs} alternating runs per side, ${DRAG_MS / 1000} s drags at 60 moves a second, headless Chrome without a GPU.`,
    "",
    "| | main | this PR |",
    "|---|---|---|",
  ];
  const problems: string[] = [];
  for (const { name } of SCENARIOS) {
    const pick = (side: "base" | "head", key: keyof DragSample) => median(samples[side].map((sample) => sample[name]![key]));
    const row = (label: string, key: keyof DragSample, unit = "") => {
      lines.push(`| ${name}: ${label} | ${round(pick("base", key))}${unit} | ${round(pick("head", key))}${unit} |`);
    };
    row("main thread per frame", "mainMsPerFrame", " ms");
    row("script per frame", "scriptMsPerFrame", " ms");
    row("style and layout per frame", "styleLayoutMsPerFrame", " ms");
    row("React commits", "commits");
    row("frames drawn", "frames");
    row("dropped frames", "droppedFrames");
    const frame = { base: pick("base", "mainMsPerFrame"), head: pick("head", "mainMsPerFrame") };
    if (frame.head > frame.base * MAX_FRAME_RATIO && frame.head - frame.base >= MIN_FRAME_DELTA_MS) {
      problems.push(`${name}: main thread per frame went from ${round(frame.base)} to ${round(frame.head)} ms (limit: +${Math.round((MAX_FRAME_RATIO - 1) * 100)}% and +${MIN_FRAME_DELTA_MS} ms).`);
    }
    const commits = { base: pick("base", "commits"), head: pick("head", "commits") };
    if (commits.head > commits.base * MAX_COMMIT_RATIO && commits.head - commits.base >= MIN_COMMIT_DELTA) {
      problems.push(`${name}: React commits went from ${commits.base} to ${commits.head} (limit: +${Math.round((MAX_COMMIT_RATIO - 1) * 100)}% and +${MIN_COMMIT_DELTA}).`);
    }
  }
  lines.push("", problems.length > 0 ? `**Over budget:**\n\n${problems.map((problem) => `- ${problem}`).join("\n")}` : "Both drags are within the budget.");
  return { lines, problems };
}

await main();
