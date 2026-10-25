import { evaluate, frames, mouse, sleep, waitFor, type Cdp, type Point } from "./browser";
import { RESIZE_SETTLE_MS } from "../../src/ui/resize-settle";

/** Edges of cells and text before/after the pane's deferred width catch-up. */
interface TableResizeFrame { pane: number; cells: Record<string, [number, number]>; text: Record<string, [number, number]> }
export const TABLE_RESIZE_KINDS = ["vols", "hp", "seas"] as const;

function tableResizeFrame(kind: string): string {
  return `(() => {
    const pane = document.querySelector('[data-gloom-pane-id="${kind}:resize"]');
    const result = { pane: pane.getBoundingClientRect().right, cells: {}, text: {} };
    for (const role of ['data-table', 'data-table-body-scroll', 'data-table-scroll-content']) {
      const box = pane.querySelector('[data-gloom-role=' + role + ']').getBoundingClientRect();
      result.cells['@' + role] = [box.left, box.right];
    }
    for (const [index, cell] of [...pane.querySelectorAll('[data-gloom-role=data-table-header-cell], [data-gloom-role=data-table-cell]')].entries()) {
      const box = cell.getBoundingClientRect();
      const key = index + ':' + cell.textContent.trim();
      result.cells[key] = [box.left, box.right];
      const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
      let node, left = Infinity, right = -Infinity;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect();
        left = Math.min(left, text.left); right = Math.max(right, text.right);
      }
      if (Number.isFinite(left)) result.text[key] = [left, right];
    }
    return result;
  })()`;
}

async function tableResizeReady(cdp: Cdp, kind: string): Promise<void> {
  if (!await waitFor(cdp, `document.querySelectorAll('[data-gloom-pane-id="${kind}:resize"] [data-gloom-role=data-table-cell]').length > 30`, 15_000)) {
    throw new Error(`${kind} did not load invented table rows: ${await evaluate(cdp, "document.body.innerText.slice(0, 500)")}`);
  }
  await sleep(700);
}

async function tableResizeGrab(cdp: Cdp, kind: string, mode: string): Promise<Point> {
  return evaluate(cdp, `(() => {
    const pane = document.querySelector('[data-gloom-pane-id="${kind}:resize"]');
    if (${JSON.stringify(mode)} === 'float') {
      const r = pane.querySelector('[data-gloom-role=resize-handle]').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    const edge = pane.getBoundingClientRect();
    const divider = [...document.querySelectorAll('[data-gloom-role=dock-divider][data-axis=horizontal]')]
      .map((element) => element.getBoundingClientRect()).find((r) => Math.abs(r.x + r.width / 2 - edge.right) < 8);
    return { x: divider.x + divider.width / 2, y: edge.top + 60 };
  })()`);
}

function requireSameGeometry(first: TableResizeFrame, settled: TableResizeFrame): void {
  for (const family of ["cells", "text"] as const) {
    const before = Object.keys(first[family]), after = Object.keys(settled[family]);
    const missing = before.filter((key) => !(key in settled[family]));
    const added = after.filter((key) => !(key in first[family]));
    if (missing.length || added.length) {
      throw new Error(`Table ${family} changed identity during the held drag: ${JSON.stringify({ missing, added })}`);
    }
  }
}

function catchupShift(first: TableResizeFrame, settled: TableResizeFrame, held = false): number {
  if (held) requireSameGeometry(first, settled);
  let shift = 0;
  for (const family of ["cells", "text"] as const) for (const [key, edges] of Object.entries(first[family])) {
    const after = settled[family][key];
    if (after) shift = Math.max(shift, Math.abs(after[0] - edges[0]), Math.abs(after[1] - edges[1]));
  }
  return shift;
}

/** Final layout commits can restart both column and ancestor transitions. */
async function waitForTableResizeSettled(cdp: Cdp, kind: string): Promise<void> {
  await evaluate(cdp, `new Promise((resolve, reject) => {
    const pane = document.querySelector('[data-gloom-pane-id="${kind}:resize"]');
    const started = performance.now();
    let previous = '', stableFrames = 0, stopped = false;
    const timeout = setTimeout(() => {
      stopped = true;
      reject(new Error('The ${kind} table did not finish its resize within 5000ms'));
    }, 5000);
    const tick = () => {
      if (stopped) return;
      const following = pane.querySelector('[data-gloom-follow-x], [data-gloom-follow-y], [data-gloom-follow-settling]');
      const held = [...pane.querySelectorAll('[data-gloom-role=data-table]')].some((table) =>
        ['--gloom-table-resize-columns', '--gloom-table-resize-width', '--gloom-table-column-transition'].some((name) => {
          const value = table.style.getPropertyValue(name).trim();
          return value !== '' && value !== 'initial';
        }));
      const animating = pane.getAnimations({ subtree: true }).some((animation) =>
        animation.playState === 'running' && ['width', 'height', 'grid-template-columns', 'margin-right', 'margin-bottom'].includes(animation.transitionProperty));
      const vertical = [...pane.querySelectorAll('[data-gloom-role=data-table], [data-gloom-role=data-table-body-scroll]')]
        .map((element) => { const box = element.getBoundingClientRect(); return [box.top, box.bottom]; });
      const current = JSON.stringify([${tableResizeFrame(kind)}, vertical]);
      stableFrames = !following && !held && !animating && current === previous ? stableFrames + 1 : 0;
      previous = current;
      if (stableFrames >= 3 && performance.now() - started >= ${RESIZE_SETTLE_MS}) {
        stopped = true;
        clearTimeout(timeout);
        resolve();
      } else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`, 6000);
}

/** A movement inside a cell and one beyond the deferred layout interval. */
export async function checkTableResize(cdp: Cdp, kind: string, mode: string, capture?: (name: string) => Promise<void>, distances = [13, 14, 15, 29, 61], verifyHeldIdentities = true) {
  await tableResizeReady(cdp, kind);
  const read = () => evaluate<TableResizeFrame>(cdp, tableResizeFrame(kind));
  const from = await tableResizeGrab(cdp, kind, mode);
  const before = await read();
  await capture?.("rest");
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  let x = from.x;
  const results: Array<{ name: string; shift: number; first: TableResizeFrame; settled: TableResizeFrame }> = [];
  let release = { travel: 0, maxStep: 0, maxStepPerFrame: 0 };
  let live = { frames: 0, maxShift: 0 };
  await frames(cdp);
  const pressed = await read();
  results.push({ name: "press", shift: catchupShift(before, pressed), first: before, settled: pressed });
  await evaluate(cdp, `(() => {
    const record = { active: true, frames: [] };
    window.__tableLive = record;
    const tick = () => {
      if (!record.active) return;
      setTimeout(() => { if (record.active) record.frames.push(${tableResizeFrame(kind)}); }, 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  try {
    for (const distance of distances) {
      x = from.x - distance;
      await mouse(cdp, "mouseMoved", x, from.y, true);
      await frames(cdp, 1);
      const first = await read();
      if (Math.abs(first.pane - (before.pane - distance)) > 2) {
        throw new Error(`${kind}: frame did not follow the ${distance}px pointer move (${before.pane} to ${first.pane})`);
      }
      await capture?.(`in-${distance}`);
      await sleep(180);
      const settled = await read();
      results.push({ name: `in ${distance}px`, shift: catchupShift(first, settled), first, settled });
    }
  } finally {
    const held = await read();
    const sampled = await evaluate<TableResizeFrame[]>(cdp, "(() => { window.__tableLive.active = false; return window.__tableLive.frames; })()");
    live.frames = sampled.length;
    await evaluate(cdp, `(() => {
      const record = { active: true, samples: [{ time: performance.now(), frame: ${JSON.stringify(held)} }] };
      window.__tableRelease = record;
      const tick = (time) => {
        if (!record.active) return;
        record.samples.push({ time, frame: ${tableResizeFrame(kind)} });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);
    let settled = held;
    let samples: Array<{ time: number; frame: TableResizeFrame }> = [];
    try {
      await mouse(cdp, "mouseReleased", x, from.y, false);
      await waitForTableResizeSettled(cdp, kind);
      settled = await read();
    } finally {
      samples = await evaluate(cdp, "(() => { window.__tableRelease.active = false; return window.__tableRelease.samples; })()");
    }
    // Validate the held snapshots only after letting go, including on failure.
    // A schema is allowed to change once the pointer has been released.
    for (const result of verifyHeldIdentities ? results : []) {
      requireSameGeometry(before, result.first);
      requireSameGeometry(before, result.settled);
    }
    // Compare every painted frame to the settled frame at that same pane
    // width. This includes the frames before an out-of-process first-frame
    // read reached a busy browser, without assuming that a clipped intrinsic
    // cell follows one linear fraction across a CSS minimum-width boundary.
    const references = [pressed, ...results.map((result) => result.settled)];
    for (let index = 0; index < sampled.length; index += 1) {
      const sample = sampled[index]!;
      if (verifyHeldIdentities) requireSameGeometry(before, sample);
      // The viewport always fills the pane, including when the columns keep
      // a wider scrollable extent. A table that stayed frozen until release
      // cannot pass merely because all of its text stayed frozen with it.
      for (const role of ["@data-table", "@data-table-body-scroll"]) {
        const expectedGap = pressed.pane - pressed.cells[role]![1];
        const gap = sample.pane - sample.cells[role]![1];
        live.maxShift = Math.max(live.maxShift, Math.abs(gap - expectedGap));
      }
      const reference = references.find((frame) => Math.abs(frame.pane - sample.pane) < 0.1);
      if (reference) live.maxShift = Math.max(live.maxShift, catchupShift(sample, reference));
      const previous = sampled[index - 1];
      // A column edge cannot jump farther than the pane moved on that frame;
      // a deferred whole-cell jump while the edge moves a pixel is a failure.
      if (previous) live.maxShift = Math.max(live.maxShift,
        catchupShift(previous, sample) - Math.abs(sample.pane - previous.pane));
    }
    release.travel = catchupShift(held, settled);
    for (let index = 1; index < samples.length; index += 1) {
      const before = samples[index - 1]!, after = samples[index]!;
      const step = catchupShift(before.frame, after.frame);
      release.maxStep = Math.max(release.maxStep, step);
      release.maxStepPerFrame = Math.max(release.maxStepPerFrame, step * (1000 / 60) / Math.max(1000 / 60, after.time - before.time));
    }
    await capture?.("released");
  }
  return { before, results, live, release, maxShift: Math.max(live.maxShift, ...results.map((result) => result.shift)) };
}

const overflowGeometry = `(() => {
  const pane = document.querySelector('[data-gloom-pane-id="table:resize"]');
  const body = pane.querySelector('[data-gloom-role=data-table-body-scroll]');
  const content = pane.querySelector('[data-gloom-role=data-table-scroll-content]').getBoundingClientRect();
  const last = [...pane.querySelectorAll('[data-gloom-role=data-table-header-cell]')].at(-1).getBoundingClientRect();
  return { pane: pane.getBoundingClientRect().right, viewport: body.clientWidth, content: content.width,
    endInset: content.right - last.right, cell: parseFloat(getComputedStyle(body).getPropertyValue('--cell-w')) };
})()`;

async function checkOverflowBoundary(cdp: Cdp, grow: boolean): Promise<void> {
  await tableResizeReady(cdp, "table");
  const read = () => evaluate<{ pane: number; viewport: number; content: number; endInset: number; cell: number }>(cdp, overflowGeometry);
  const before = await read();
  const initialFrame = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("table"));
  if (grow ? before.content - before.viewport < 100 : Math.abs(before.content - before.viewport) > 1) {
    throw new Error(`Wrong initial overflow state: ${JSON.stringify(before)}`);
  }
  const from = await tableResizeGrab(cdp, "table", "float");
  const direction = grow ? 1 : -1;
  let x = from.x;
  let held: TableResizeFrame | null = null;
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  try {
    for (const distance of [13, 200, 399, 400]) {
      x = from.x + direction * distance;
      await mouse(cdp, "mouseMoved", x, from.y, true);
      await frames(cdp, 1);
      const first = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("table"));
      requireSameGeometry(initialFrame, first);
      if (Math.abs(first.pane - before.pane - direction * distance) > 2) throw new Error("The overflow-boundary resize did not follow its pointer");
      await sleep(180);
      held = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("table"));
      const shift = catchupShift(first, held, true);
      if (shift > 1) throw new Error(`Crossing the overflow boundary moved cells at catch-up by ${shift.toFixed(2)}px`);
    }
    const during = await read();
    if ((grow ? Math.abs(during.content - during.viewport) > 1 : during.content - during.viewport < 100)
      || Math.abs(during.endInset - before.endInset) > 1) {
      throw new Error(`Columns did not ${grow ? "fill the widened viewport" : "keep their scrollable width"} during resize: ${JSON.stringify({ before, during })}`);
    }
  } finally {
    await mouse(cdp, "mouseReleased", x, from.y, false);
  }
  await waitForTableResizeSettled(cdp, "table");
  const after = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("table"));
  const shift = catchupShift(held!, after);
  if (shift > 1) throw new Error(`Crossing the overflow boundary moved cells on release by ${shift.toFixed(2)}px`);
}

async function checkHeaderMinimumRegrab(cdp: Cdp, empty: boolean): Promise<void> {
  const pane = '[data-gloom-pane-id="headers:resize"]';
  if (!await waitFor(cdp, `document.querySelectorAll('${pane} [data-gloom-role=data-table-header-cell]').length === 3`, 15_000)) {
    throw new Error("The header-minimum fixture did not render its columns");
  }
  await sleep(700);
  const state = await evaluate<{ labels: string[]; rows: number; sharedGrid: boolean }>(cdp, `(() => {
    const pane = document.querySelector('${pane}');
    return { labels: [...pane.querySelectorAll('[data-gloom-role=data-table-header-cell]')].map((cell) => cell.textContent.trim()),
      rows: pane.querySelectorAll('[data-gloom-role=data-table-cell]').length,
      sharedGrid: getComputedStyle(pane.querySelector('[data-gloom-role=data-table-scroll-content]')).display === 'grid' };
  })()`);
  if (state.labels.join() !== "IMP,CTY,EVENT" || (state.rows === 0) !== empty || state.sharedGrid === empty) {
    throw new Error(`Wrong header-minimum fixture state: ${JSON.stringify(state)}`);
  }
  const read = () => evaluate<TableResizeFrame>(cdp, tableResizeFrame("headers"));
  const before = await read();
  const from = await tableResizeGrab(cdp, "headers", "float");
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  try {
    await frames(cdp, 1);
    const shift = catchupShift(before, await read(), true);
    if (shift > 1) throw new Error(`Pressing the ${empty ? "empty" : "loaded"} table moved its headers ${shift.toFixed(2)}px`);
    await mouse(cdp, "mouseMoved", from.x + 128, from.y, true);
    await sleep(180);
    const held = await read();
    requireSameGeometry(before, held);
    if (Math.abs(held.pane - before.pane - 128) > 1) throw new Error("The header fixture did not grow across its label breakpoint");
    await evaluate(cdp, `(() => {
      const pane = document.querySelector('${pane}');
      const grid = pane.querySelector('[data-gloom-role=${empty ? "data-table-header-row" : "data-table-scroll-content"}]');
      grid.addEventListener('transitionrun', function regrab(event) {
        if (event.target !== grid || event.propertyName !== 'grid-template-columns') return;
        const labels = [...pane.querySelectorAll('[data-gloom-role=data-table-header-cell]')].map((cell) => cell.textContent.trim());
        // Release can start an earlier transition before the held labels commit.
        if (labels.join() !== 'IMPACT,COUNTRY NAME,EVENT') return;
        grid.removeEventListener('transitionrun', regrab);
        const animation = grid.getAnimations().find((item) => item.transitionProperty === 'grid-template-columns');
        if (!animation) { window.__headerRegrab = { error: 'No header-floor transition' }; return; }
        animation.pause();
        const duration = Number(animation.effect.getTiming().duration);
        animation.currentTime = 0;
        const start = ${tableResizeFrame("headers")};
        animation.currentTime = duration / 2;
        const before = ${tableResizeFrame("headers")};
        const widths = getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).map(parseFloat);
        const cell = parseFloat(getComputedStyle(grid).getPropertyValue('--cell-w'));
        const floors = [8 * cell, 14 * cell];
        const handle = pane.querySelector('[data-gloom-role=resize-handle]');
        const box = handle.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
        handle.dispatchEvent(new MouseEvent('mousedown', init));
        const after = ${tableResizeFrame("headers")};
        const held = pane.querySelector('[data-gloom-role=data-table]').style.getPropertyValue('--gloom-table-resize-columns');
        window.__headerRegrab = { start, before, after, widths, floors, held };
        document.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      });
    })()`);
  } finally {
    await mouse(cdp, "mouseReleased", from.x + 128, from.y, false);
  }
  if (!await waitFor(cdp, "!!window.__headerRegrab", 3000)) throw new Error("The wider header floors did not transition after release");
  const result = await evaluate<{ error?: string; start: TableResizeFrame; before: TableResizeFrame; after: TableResizeFrame; widths: number[]; floors: number[]; held: string }>(cdp, "window.__headerRegrab");
  if (result.error) throw new Error(result.error);
  if (!result.held || result.held === "initial") throw new Error("The halfway press did not begin another resize");
  if (result.widths.length !== 3 || result.floors.some((floor, index) => !Number.isFinite(result.widths[index]) || floor - result.widths[index]! < 1)) {
    throw new Error(`The fixed and flexible destination floors must exceed their painted widths: ${JSON.stringify({ widths: result.widths, floors: result.floors })}`);
  }
  if (catchupShift(result.start, result.before) < 1) throw new Error("The header fixture did not advance into its transition");
  const shift = catchupShift(result.before, result.after, true);
  if (shift > 1) throw new Error(`Regrabbing the ${empty ? "empty" : "loaded"} table at wider header floors moved its cells ${shift.toFixed(2)}px`);
  await waitForTableResizeSettled(cdp, "headers");
}

export const tableResizeSteps = [...TABLE_RESIZE_KINDS.flatMap((kind) => ["float", "dock"].map((mode) => ({
  name: `table resize: ${kind.toUpperCase()} ${mode} cells and text follow before the width catch-up`,
  scenario: `table-resize&pane=${kind}&mode=${mode}`,
  async run(cdp: Cdp) {
    const result = await checkTableResize(cdp, kind, mode);
    if (result.maxShift > 1) throw new Error(`${kind} moved ${result.maxShift.toFixed(2)}px off the pane's current width: ${JSON.stringify({ live: result.live, steps: result.results.map(({ name, shift }) => ({ name, shift })) })}`);
    if (kind === "hp") {
      // The wide fixture has spare room in its responsive price columns.
      // Its content must shrink with the edge, not wait clipped until release.
      const inset = result.before.pane - result.before.cells["@data-table-scroll-content"]![1];
      for (const { first, settled } of result.results) for (const frame of [first, settled]) {
        if (Math.abs(frame.pane - frame.cells["@data-table-scroll-content"]![1] - inset) > 1) {
          throw new Error("HP's responsive columns did not follow the pane edge");
        }
      }
    }
    if (result.release.maxStepPerFrame > 3) throw new Error(`${kind} jumped on release: ${JSON.stringify(result.release)}`);
  },
}))), ...[false, true].map((empty) => ({
  name: `table resize: ${empty ? "empty" : "loaded"} headers keep painted tracks when regrabbed below wider destination floors`,
  scenario: `table-resize&pane=headers&fw=512${empty ? "&empty=1" : ""}`,
  run: (cdp: Cdp) => checkHeaderMinimumRegrab(cdp, empty),
})), ...[true, false].map((grow) => ({
  name: `table resize: columns follow across the ${grow ? "overflow-to-fit" : "fit-to-overflow"} boundary`,
  scenario: `table-resize&pane=table&wide=1&fw=${grow ? 640 : 1100}`,
  run: (cdp: Cdp) => checkOverflowBoundary(cdp, grow),
})), {
  name: "table resize: the trailing-gutter boundary settles without a release jump",
  scenario: "table-resize&pane=table&wide=1&fw=640",
  async run(cdp: Cdp) {
    await tableResizeReady(cdp, "table");
    const before = await evaluate<{ viewport: number; content: number; cell: number }>(cdp, overflowGeometry);
    const growth = before.content - before.viewport - before.cell / 2;
    if (!(growth > 100)) throw new Error("The gutter-boundary fixture did not begin overflowing");
    const result = await checkTableResize(cdp, "table", "float", undefined, [-growth]);
    if (result.maxShift > 1 || result.release.travel > before.cell + 1 || result.release.maxStepPerFrame > 3) {
      throw new Error(`The trailing gutter jumped: ${JSON.stringify({ shift: result.maxShift, release: result.release })}`);
    }
  },
}, {
  name: "table resize: a second drag keeps the last fractional cell on press",
  scenario: "table-resize&pane=vols&mode=float",
  async run(cdp: Cdp) {
    const first = await checkTableResize(cdp, "vols", "float", undefined, [61]);
    const fractional = await evaluate<number>(cdp, `(() => {
      const pane = document.querySelector('[data-gloom-pane-id="vols:resize"]');
      const cells = pane.getBoundingClientRect().width / parseFloat(getComputedStyle(pane).getPropertyValue('--cell-w'));
      return Math.abs(cells - Math.round(cells));
    })()`);
    if (fractional < 0.1) throw new Error("The second drag did not start at a fractional-cell width");
    const second = await checkTableResize(cdp, "vols", "float", undefined, [1, 2, 15]);
    if (Math.max(first.maxShift, second.maxShift) > 1 || Math.max(first.release.maxStepPerFrame, second.release.maxStepPerFrame) > 3) {
      throw new Error(`A second drag jumped: ${JSON.stringify({ first: first.maxShift, second: second.results.map(({ name, shift }) => ({ name, shift })), live: second.live, release: second.release })}`);
    }
  },
}, {
  name: "table resize: resizing another pane leaves fractional table ancestors still",
  scenario: "table-resize&pane=vols&fw=643&other=1",
  async run(cdp: Cdp) {
    await tableResizeReady(cdp, "vols");
    // Make the empty fraction explicit: the real pane may already fill every
    // ancestor at this width, which would not exercise preserving a table gap.
    await evaluate(cdp, `(() => {
      const table = document.querySelector('[data-gloom-pane-id="vols:resize"] [data-gloom-role=data-table]');
      const frame = table.closest('[data-gloom-role=table-view-frame]');
      if (!frame?.parentElement) throw new Error('The unrelated-pane fixture has no table frame');
      const parent = frame.parentElement;
      const style = getComputedStyle(parent);
      const inset = ['borderLeftWidth', 'borderRightWidth', 'paddingLeft', 'paddingRight']
        .reduce((sum, name) => sum + (parseFloat(style[name]) || 0), 0);
      const cell = parseFloat(getComputedStyle(table).getPropertyValue('--cell-w'));
      frame.style.width = (parent.getBoundingClientRect().width - inset - cell / 2) + 'px';
    })()`);
    await waitForTableResizeSettled(cdp, "vols");
    const gap = await evaluate<number>(cdp, `(() => {
      const table = document.querySelector('[data-gloom-pane-id="vols:resize"] [data-gloom-role=data-table]');
      const cell = parseFloat(getComputedStyle(table).getPropertyValue('--cell-w'));
      for (let box = table.parentElement; box && box.getAttribute('data-gloom-role') !== 'pane-content'; box = box.parentElement) {
        if (!box.style.width.endsWith('px')) continue;
        const short = box.parentElement.getBoundingClientRect().width - box.getBoundingClientRect().width;
        if (short > 1 && short < cell) return short;
      }
      return 0;
    })()`);
    if (gap === 0) throw new Error("The unrelated-pane fixture has no fractional table ancestor");
    const before = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("vols"));
    const from = await evaluate<Point & { right: number }>(cdp, `(() => {
      const pane = document.querySelector('[data-gloom-pane-id="plain:other"]');
      const handle = pane.querySelector('[data-gloom-role=resize-handle]').getBoundingClientRect();
      return { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2, right: pane.getBoundingClientRect().right };
    })()`);
    await mouse(cdp, "mouseMoved", from.x, from.y, false);
    await mouse(cdp, "mousePressed", from.x, from.y, true);
    let x = from.x;
    try {
      for (const distance of [0, -13]) {
        x = from.x + distance;
        if (distance) await mouse(cdp, "mouseMoved", x, from.y, true);
        await frames(cdp, 1);
        const right = await evaluate<number>(cdp, "document.querySelector('[data-gloom-pane-id=\"plain:other\"]').getBoundingClientRect().right");
        if (Math.abs(right - from.right - distance) > 1) throw new Error("The unrelated pane did not follow its resize pointer");
        for (const delay of [0, 180]) {
          if (delay) await sleep(delay);
          const after = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("vols"));
          const shift = catchupShift(before, after, true);
          if (Math.abs(after.pane - before.pane) > 1 || shift > 1) {
            throw new Error(`An unrelated pane resize moved the table ${shift.toFixed(2)}px (${distance}px movement, ${delay}ms catch-up)`);
          }
        }
      }
    } finally {
      await mouse(cdp, "mouseReleased", x, from.y, false);
    }
    await waitForTableResizeSettled(cdp, "vols");
    const released = await evaluate<TableResizeFrame>(cdp, tableResizeFrame("vols"));
    if (catchupShift(before, released) > 1) throw new Error("An unrelated pane release moved the table");
  },
}, {
  name: "table resize: the header remains pinned above vertically scrolled rows",
  scenario: "table-resize&pane=table&fw=1000",
  async run(cdp: Cdp) {
    await tableResizeReady(cdp, "table");
    const read = `(() => {
      const pane = document.querySelector('[data-gloom-pane-id="table:resize"]');
      const body = pane.querySelector('[data-gloom-role=data-table-body-scroll]');
      const header = pane.querySelector('[data-gloom-role=data-table-header-row]');
      const rect = header.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + 20, rect.top + rect.height / 2);
      return { top: rect.top - body.getBoundingClientRect().top, scroll: body.scrollTop,
        above: hit?.closest('[data-gloom-role=data-table-header-row]') === header,
        firstRow: pane.querySelector('[data-gloom-role=data-table-row]')?.getAttribute('data-gloom-row-key') };
    })()`;
    const before = await evaluate<{ top: number; scroll: number; above: boolean; firstRow: string }>(cdp, read);
    await evaluate(cdp, `(() => {
      const body = document.querySelector('[data-gloom-pane-id="table:resize"] [data-gloom-role=data-table-body-scroll]');
      body.scrollTop = 540; body.dispatchEvent(new Event('scroll', { bubbles: true }));
    })()`);
    await frames(cdp, 3);
    const after = await evaluate<typeof before>(cdp, read);
    if (after.scroll < 500 || after.firstRow === before.firstRow || Math.abs(after.top - before.top) > 1 || !after.above) {
      throw new Error(`The table header did not stay above its scrolling rows: ${JSON.stringify({ before, after })}`);
    }
  },
}, {
  name: "table resize: regrabbing a settling table keeps the currently painted columns",
  scenario: "table-resize&pane=hp&mode=float",
  async run(cdp: Cdp) {
    await tableResizeReady(cdp, "hp");
    const from = await tableResizeGrab(cdp, "hp", "float");
    await mouse(cdp, "mouseMoved", from.x, from.y, false);
    await mouse(cdp, "mousePressed", from.x, from.y, true);
    await mouse(cdp, "mouseMoved", from.x - 61, from.y, true);
    await frames(cdp, 2);
    await sleep(180);
    await evaluate(cdp, `(() => {
      const pane = document.querySelector('[data-gloom-pane-id="hp:resize"]');
      const content = pane.querySelector('[data-gloom-role=data-table-scroll-content]');
      content.addEventListener('transitionrun', function regrab(event) {
        if (event.target !== content || event.propertyName !== 'grid-template-columns') return;
        // Pause the real CSS transition halfway through: the machine's frame
        // rate must not decide whether the test catches the short transition.
        const animation = content.getAnimations().find((item) => item.transitionProperty === 'grid-template-columns');
        if (!animation) { window.__tableRegrab = { error: 'No column transition' }; return; }
        const time = animation.currentTime;
        const playing = animation.playState === 'running';
        animation.pause();
        animation.currentTime = 0;
        const start = ${tableResizeFrame("hp")};
        animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
        const before = ${tableResizeFrame("hp")};
        const travel = Math.max(0, ...['cells', 'text'].flatMap((family) =>
          Object.entries(start[family]).flatMap(([key, edges]) => {
            const next = before[family][key];
            return next ? [Math.abs(next[0] - edges[0]), Math.abs(next[1] - edges[1])] : [];
          })));
        // Releasing the painted override can change track syntax without
        // moving a column. Wait for the deferred layout's actual redistribution.
        if (travel < 1) {
          animation.currentTime = time;
          if (playing) animation.play();
          return;
        }
        content.removeEventListener('transitionrun', regrab);
        const handle = pane.querySelector('[data-gloom-role=resize-handle]');
        const box = handle.getBoundingClientRect();
        const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
        handle.dispatchEvent(new MouseEvent('mousedown', init));
        const after = ${tableResizeFrame("hp")};
        window.__tableRegrab = { start, before, after };
        document.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      });
    })()`);
    await mouse(cdp, "mouseReleased", from.x - 61, from.y, false);
    if (!await waitFor(cdp, "!!window.__tableRegrab", 3000)) throw new Error("The resized table did not settle its columns");
    const result = await evaluate<{ error?: string; start: TableResizeFrame; before: TableResizeFrame; after: TableResizeFrame }>(cdp, "window.__tableRegrab");
    if (result.error) throw new Error(result.error);
    if (catchupShift(result.start, result.before) < 1) throw new Error("The fixture did not redistribute its columns during the transition");
    const shift = catchupShift(result.before, result.after, true);
    if (shift > 1) throw new Error(`Regrabbing a settling table moved its columns ${shift.toFixed(2)}px`);
  },
}, {
  name: "table resize: a horizontally scrolled table keeps its frozen axis and scroll position",
  scenario: "table-resize&pane=table&frozen=1&wide=1&fw=640",
  async run(cdp: Cdp) {
    await tableResizeReady(cdp, "table");
    await evaluate(cdp, `(() => {
      const body = document.querySelector('[data-gloom-pane-id="table:resize"] [data-gloom-role=data-table-body-scroll]');
      body.scrollLeft = 120; body.dispatchEvent(new Event('scroll', { bubbles: true }));
    })()`);
    await frames(cdp, 3);
    const axis = `(() => {
      const pane = document.querySelector('[data-gloom-pane-id="table:resize"]');
      const body = pane.querySelector('[data-gloom-role=data-table-body-scroll]');
      return { scroll: body.scrollLeft, positions: [...pane.querySelectorAll('[data-gloom-role=data-table-row], [data-gloom-role=data-table-header-row]')]
        .map((row) => row.firstElementChild.getBoundingClientRect().left - body.getBoundingClientRect().left) };
    })()`;
    const before = await evaluate<{ scroll: number; positions: number[] }>(cdp, axis);
    if (before.scroll !== 120) throw new Error("The frozen-table fixture did not scroll");
    const result = await checkTableResize(cdp, "table", "float");
    const after = await evaluate<typeof before>(cdp, axis);
    if (result.maxShift > 1 || result.release.maxStepPerFrame > 3 || after.scroll !== before.scroll
      || after.positions.some((left, index) => Math.abs(left - before.positions[index]!) > 1)) {
      throw new Error(`Frozen table changed while resized: ${JSON.stringify({ before, after, shift: result.maxShift, release: result.release })}`);
    }
  },
}, ...([
  { kind: "vols", width: 720, distance: 96, part: "columns" },
  { kind: "seas", width: 456, distance: 64, part: "summary rows" },
] as const).map(({ kind, width, distance, part }) => ({
  name: `table resize: ${kind.toUpperCase()} ${part} keep their arrangement across a breakpoint until release`,
  scenario: `table-resize&pane=${kind}&fw=${width}`,
  async run(cdp: Cdp) {
    await tableResizeReady(cdp, kind);
    const read = () => evaluate<{ columns: number; rows: number; top: number; gap: number }>(cdp, `(() => {
      const pane = document.querySelector('[data-gloom-pane-id="${kind}:resize"]');
      const table = pane.querySelector('[data-gloom-role=data-table]');
      const rect = table.getBoundingClientRect();
      return { columns: table.querySelectorAll('[data-gloom-role=data-table-header-cell]').length,
        rows: pane.querySelectorAll('[data-gloom-role=stat-grid-row]').length,
        top: rect.top, gap: pane.getBoundingClientRect().right - rect.right };
    })()`);
    const before = await read();
    if (kind === "vols" ? before.columns !== 7 : before.rows !== 1) {
      throw new Error(`The ${kind} fixture did not begin above its ${part} breakpoint: ${JSON.stringify(before)}`);
    }
    const from = await tableResizeGrab(cdp, kind, "float");
    await mouse(cdp, "mouseMoved", from.x, from.y, false);
    await mouse(cdp, "mousePressed", from.x, from.y, true);
    try {
      await mouse(cdp, "mouseMoved", from.x - distance, from.y, true);
      await sleep(250);
      const held = await read();
      if (held.columns !== before.columns || held.rows !== before.rows
        || Math.abs(held.top - before.top) > 1 || Math.abs(held.gap - before.gap) > 1) {
        throw new Error(`The ${kind} breakpoint reflowed during the drag: ${JSON.stringify({ before, held })}`);
      }
    } finally {
      await mouse(cdp, "mouseReleased", from.x - distance, from.y, false);
    }
    await waitForTableResizeSettled(cdp, kind);
    const after = await read();
    if (kind === "vols" ? after.columns !== 6 : after.rows !== 2) {
      throw new Error(`The ${kind} breakpoint did not settle after release: ${JSON.stringify({ before, after })}`);
    }
  },
}))];
