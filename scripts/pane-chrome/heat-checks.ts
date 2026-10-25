import { evaluate, frames, mouse, sleep, type Cdp, type Point } from "./browser";

/**
 * The market heat map's board while its box changes size (fixture.tsx,
 * `heat=market`: 500 names in sectors and industries, each layout seeded with
 * the one on screen, `ticks=1` recolouring a few names four times a second),
 * with real pointer input, a real window resize and the pane's maximise: the
 * board stretches with its box and is laid out once, after the size has held
 * still, and no tile glides, fades or pulses while the size is changing. A
 * board laid out again on every catch-up of a drag, or on every frame of a
 * window resize, restyles all of its tiles each time and moves them under
 * the pointer.
 */

interface HeatStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

const pane = (id: string) => `[data-gloom-pane-id='${id}']`;
/** Long enough for the size to settle (RESIZE_SETTLE_MS) and a glide (500 ms) to show if one started. */
const SETTLED_MS = 700;

/**
 * Starts sampling, every frame, the scenes the board committed and the
 * animations running on its tiles; `heatSample()` stops and returns them.
 */
const startSampling = (paneId: string) => `(() => {
  const record = { builds: window.__heat.builds, frames: 0, animated: [], names: {} };
  window.__heatSampling = record;
  const tick = () => {
    if (window.__heatSampling !== record) return;
    record.frames += 1;
    const running = document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.target?.closest?.(${JSON.stringify(pane(paneId))}));
    record.animated.push(running.length);
    for (const animation of running) {
      const name = (animation.animationName || "other").replace(/-[ab]$/, "");
      record.names[name] = (record.names[name] ?? 0) + 1;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

interface Sample { builds: number; frames: number; animated: number[]; names: Record<string, number> }

async function stopSampling(cdp: Cdp): Promise<Sample> {
  return evaluate<Sample>(cdp, `(() => {
    const record = window.__heatSampling;
    window.__heatSampling = null;
    return { ...record, builds: window.__heat.builds - record.builds };
  })()`);
}

/** Frames that had a tile animating, after the first `skip`: the commit that stops what a tick started lands a frame or two after the first move. */
const animatedFrames = (sample: Sample, skip = 4) => sample.animated.slice(skip).filter((count) => count > 0).length;

async function boardReady(cdp: Cdp, paneId: string): Promise<void> {
  const ready = await evaluate<boolean>(cdp, `new Promise((done) => {
    const until = performance.now() + 10000;
    const check = () => document.querySelectorAll(${JSON.stringify(`${pane(paneId)} [data-gloom-role=heat-tile]`)}).length > 200 ? done(true) : performance.now() > until ? done(false) : requestAnimationFrame(check);
    check();
  })`, 15_000);
  if (!ready) fail(`${paneId} drew no board`);
  // Past the layout the first measure settles.
  await sleep(SETTLED_MS);
}

/** After a resize: one layout, and no tile slid into it. Fades and pulses from ticks at rest are the board's own. */
async function settlesOnce(cdp: Cdp, paneId: string, what: string): Promise<void> {
  await evaluate(cdp, startSampling(paneId));
  await sleep(SETTLED_MS);
  const after = await stopSampling(cdp);
  if (after.builds !== 1) fail(`${what}: the board was laid out ${after.builds} times once the size held still, not once`, after.builds);
  if (after.names["gloom-heat-glide"]) fail(`${what}: tiles slid into the layout the size settled on`, after.names);
}

function stillWhileResizing(sample: Sample, what: string, steps: number): void {
  if (sample.builds !== 0) fail(`${what}: the board was laid out ${sample.builds} times during ${steps} steps of the resize`, sample.builds);
  if (animatedFrames(sample) > 0) fail(`${what}: tiles animated while the size was changing`, sample.names);
}

export const heatSteps: HeatStep[] = [
  {
    name: "market heat map: a corner resize stretches the board, holds every tile still, and lays it out once after the release, a refresh mid-drag included",
    scenario: "resize&float=heat&heat=market&ticks=1",
    async run(cdp) {
      const paneId = "heat:float";
      await boardReady(cdp, paneId);
      const from = await evaluate<Point & { boardWidth: number }>(cdp, `(() => {
        const r = document.querySelector("${pane(paneId)} [data-gloom-role=resize-handle]").getBoundingClientRect();
        const board = document.querySelector("${pane(paneId)} [data-gloom-role=heat-treemap]").getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, boardWidth: board.width };
      })()`);
      const to = { x: from.x - from.boardWidth * 0.4, y: from.y + 50 };
      const moves = 48;
      await mouse(cdp, "mouseMoved", from.x, from.y, false);
      await mouse(cdp, "mousePressed", from.x, from.y, true);
      let released = false;
      try {
        await frames(cdp);
        await evaluate(cdp, startSampling(paneId));
        // Shrink past two thirds: the old 1.5x limit rebuilt every tile
        // before release. The board must keep stretching through it.
        for (let move = 1; move <= moves; move += 1) {
          const t = Math.sin((move / moves) * Math.PI / 2);
          await mouse(cdp, "mouseMoved", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, true);
          if (move === moves / 2) await evaluate(cdp, "window.__heat.refresh()");
          await frames(cdp);
        }
        // Held still with the pointer down: a pause is not the end of the resize.
        await sleep(300);
        const during = await stopSampling(cdp);
        stillWhileResizing(during, "corner resize", moves);
        const duringWidth = await evaluate<number>(cdp, `document.querySelector("${pane(paneId)} [data-gloom-role=heat-treemap]").getBoundingClientRect().width`);
        if (from.boardWidth / duringWidth <= 1.5) fail("corner resize: the board never crossed the former hold limit", { before: from.boardWidth, during: duringWidth });
        await mouse(cdp, "mouseReleased", to.x, to.y, false);
        released = true;
      } finally {
        if (!released) await mouse(cdp, "mouseReleased", to.x, to.y, false);
      }
      await settlesOnce(cdp, paneId, "corner resize");
    },
  },
  {
    name: "market heat map: a window resize stretches the docked board and lays it out once the window holds still",
    scenario: "resize&dock=heat&heat=market&ticks=1",
    async run(cdp) {
      const paneId = "heat:dock";
      await boardReady(cdp, paneId);
      const viewport = await evaluate<{ width: number; height: number }>(cdp, "({ width: innerWidth, height: innerHeight })");
      const steps = 40;
      try {
        await evaluate(cdp, startSampling(paneId));
        for (let step = 1; step <= steps; step += 1) {
          const t = step / steps;
          await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(viewport.width - t * 220), height: Math.round(viewport.height - t * 80), deviceScaleFactor: 1, mobile: false });
          await frames(cdp);
        }
        stillWhileResizing(await stopSampling(cdp), "window resize", steps);
        await settlesOnce(cdp, paneId, "window resize");
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
      }
    },
  },
  {
    name: "market heat map: maximise and restore lay the board out once each, with no tile animation",
    scenario: "resize&float=heat&heat=market&ticks=1",
    async run(cdp) {
      const paneId = "heat:float";
      await boardReady(cdp, paneId);
      for (const what of ["maximise", "restore"]) {
        await evaluate(cdp, startSampling(paneId));
        await evaluate(cdp, `window.__paneChrome.registry.togglePaneFullscreen(${JSON.stringify(paneId)})`);
        await sleep(SETTLED_MS);
        const sample = await stopSampling(cdp);
        if (sample.builds !== 1) fail(`${what}: the board was laid out ${sample.builds} times, not once`, sample.builds);
        if (sample.names["gloom-heat-glide"]) fail(`${what}: tiles slid into the new layout`, sample.names);
      }
    },
  },
];
