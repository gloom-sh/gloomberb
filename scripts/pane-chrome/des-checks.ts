import { evaluate, frames, mouse, waitFor, type Cdp, type Point } from "./browser";

/**
 * DES's overview while its pane is resized (fixture.tsx, `scenario=des`), with
 * real pointer input: the quote book, the fundamentals and positions columns
 * and the description keep to the pane's right edge on every frame, every
 * column lines up from row to row and with its header, and nothing moves when
 * the pointer lets go. Text is found by what it says, so the same steps read
 * a branch whose columns are padded text.
 */

interface DesStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

interface Token { text: string; left: number; right: number }
interface DesEdges {
  /** The pane's content box, right edge. */
  pane: number;
  /** Rows of text pieces (split where two spaces or a box break them), left to right. */
  book: Token[][];
  fundamentals: Token[][];
  positions: Token[][];
  /** Right edge of the description's text box. */
  description: number;
}

/** Page helpers, installed by each step. */
const DES_HELPERS = `
window.__des = {
  paneElement() { return document.querySelector('[data-gloom-pane-id="des:a"] [data-gloom-role=pane-content]'); },
  leaf(text) { return [...this.paneElement().querySelectorAll('span')].find((e) => e.childElementCount === 0 && e.textContent.trim() === text); },
  tokens(root, skip) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (skip && skip.contains(node)) continue;
      const re = /\\S+(?: \\S+)*/g;
      let match;
      while ((match = re.exec(node.textContent))) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const box = range.getBoundingClientRect();
        if (box.width > 0) out.push({ text: match[0], left: box.left, right: box.right, top: Math.round(box.top) });
      }
    }
    const rows = new Map();
    for (const token of out) (rows.get(token.top) ?? rows.set(token.top, []).get(token.top)).push(token);
    return [...rows.values()].map((row) => row.sort((a, b) => a.left - b.left).map(({ text, left, right }) => ({ text, left, right })));
  },
  /** The text under a section heading, without the heading. */
  section(title) {
    const heading = this.leaf(title);
    if (!heading) return [];
    let box = heading.closest('div');
    while (box.parentElement && box.parentElement.children.length < 2) box = box.parentElement;
    return this.tokens(box.parentElement, box);
  },
  /**
   * Every visible glyph of a column grid cell that sits outside its own track:
   * in a label and value pair, the label outside the label's box or the value
   * left of it. Also any glyph visible past its grid's edge or the pane's. A
   * glyph is visible where no ancestor clips it.
   */
  overflow() {
    const pane = this.paneElement().getBoundingClientRect();
    const found = [];
    const visible = (rect, from) => {
      let left = rect.left;
      let right = rect.right;
      for (let el = from; el; el = el.parentElement) {
        if (getComputedStyle(el).overflowX !== 'visible') {
          const b = el.getBoundingClientRect();
          left = Math.max(left, b.left);
          right = Math.min(right, b.right);
        }
      }
      return right - left > 0.2 ? { left, right } : null;
    };
    const check = (root, region, frame, what, section) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent;
        const whole = document.createRange();
        whole.selectNodeContents(node);
        const all = visible(whole.getBoundingClientRect(), node.parentElement);
        if (!all) continue;
        if (all.left >= region.left - 0.5 && all.right <= region.right + 0.5 && all.right <= Math.min(frame.right, pane.right) + 0.5) continue;
        for (let i = 0; i < text.length; i += 1) {
          if (/\s/.test(text[i])) continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const glyph = visible(range.getBoundingClientRect(), node.parentElement);
          if (!glyph) continue;
          const into = Math.max(region.left - glyph.left, glyph.right - region.right);
          const past = Math.max(glyph.right - frame.right, glyph.right - pane.right);
          const at = { section, text: text.trim().slice(0, 40), char: text[i] };
          if (into > 0.5) found.push({ ...at, what, px: Math.round(into * 10) / 10 });
          else if (past > 0.5) found.push({ ...at, what: 'edge', px: Math.round(past * 10) / 10 });
        }
      }
    };
    for (const grid of this.paneElement().querySelectorAll('[data-gloom-ui=column-grid]')) {
      const section = grid.getAttribute('data-gloom-role');
      const frame = grid.getBoundingClientRect();
      const style = getComputedStyle(grid);
      const gap = parseFloat(style.columnGap) || 0;
      const tracks = [];
      let x = frame.left;
      for (const size of style.gridTemplateColumns.split(' ').map(parseFloat)) {
        tracks.push({ left: x, right: x + size });
        x += size + gap;
      }
      for (const cell of grid.querySelectorAll(':scope > [data-gloom-ui=column-grid-row] > *')) {
        const track = tracks[parseInt(getComputedStyle(cell).gridColumnStart, 10) - 1];
        if (!track) continue;
        const pair = cell.matches('[data-gloom-ui=column-grid-cell]') && cell.firstElementChild && cell.firstElementChild.children.length === 2 ? cell.firstElementChild : null;
        if (!pair) { check(cell, track, frame, 'track', section); continue; }
        const label = pair.children[0].getBoundingClientRect();
        check(pair.children[0], { left: track.left, right: Math.min(label.right, track.right) }, frame, 'label', section);
        check(pair.children[1], { left: Math.max(label.right, track.left), right: track.right }, frame, 'value', section);
      }
    }
    return found;
  },
  edges() {
    let book = this.leaf('Bid');
    while (book && !book.textContent.includes('Spr')) book = book.parentElement;
    const description = [...this.paneElement().querySelectorAll('span')].find((e) => e.textContent.startsWith('Example Industries builds'));
    return {
      pane: this.paneElement().getBoundingClientRect().right,
      book: book ? this.tokens(book) : [],
      fundamentals: this.section('Fundamentals'),
      positions: this.section('Positions'),
      description: description ? description.getBoundingClientRect().right : NaN,
    };
  },
};
`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

const round = (value: number) => Math.round(value * 100) / 100;

interface Overflow { section: string; what: string; text: string; char: string; px: number }
interface JumpFrame { after: number; found: Overflow[] }

/**
 * Lets the pointer jump `by` from `from` in one move, with no frame waited, and
 * reads every frame that follows: the first ones draw the pane at its new
 * size with every cell still laid out for the old one, until a catch-up
 * (100 ms) lays them out again. Then it lets go and reads the settled pane.
 */
async function jumpDes(cdp: Cdp, from: Point, to: Point): Promise<{ before: Overflow[]; frames: JumpFrame[]; released: Overflow[] }> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  const before = await evaluate<Overflow[]>(cdp, "__des.overflow()");
  await evaluate(cdp, `(() => {
    window.__jump = { at: null, frames: [] };
    document.addEventListener("pointermove", () => { window.__jump.at ??= performance.now(); }, { capture: true, once: true });
    const tick = () => {
      if (!window.__jump.sampling) return;
      const after = window.__jump.at == null ? -1 : performance.now() - window.__jump.at;
      setTimeout(() => { if (window.__jump.sampling) window.__jump.frames.push({ after, found: __des.overflow() }); }, 0);
      requestAnimationFrame(tick);
    };
    window.__jump.sampling = true;
    requestAnimationFrame(tick);
  })()`);
  await mouse(cdp, "mouseMoved", to.x, to.y, true);
  // About a quarter of a second of frames: the ones before the catch-up and the ones after it.
  await evaluate(cdp, "new Promise((done) => setTimeout(done, 280))");
  const sampled = await evaluate<JumpFrame[]>(cdp, "(() => { window.__jump.sampling = false; return window.__jump.frames; })()");
  await mouse(cdp, "mouseReleased", to.x, to.y, false);
  await frames(cdp, 8);
  await evaluate(cdp, "new Promise((done) => setTimeout(done, 250))");
  const released = await evaluate<Overflow[]>(cdp, "__des.overflow()");
  return { before, frames: sampled.filter((frame) => frame.after >= 0), released };
}

/** No glyph outside its track or past the pane's edge: at rest, on every frame after a jump, and after the release. */
function expectContained(result: { before: Overflow[]; frames: JumpFrame[]; released: Overflow[] }, what: string): void {
  const describe = (found: Overflow[]) => found.slice(0, 3).map((item) => `"${item.text}" in ${item.section} (${item.what}) ${item.px} px`).join("; ");
  if (result.before.length > 0) fail(`${what}: at rest a glyph is outside its track: ${describe(result.before)}`);
  if (result.frames.length < 4) fail(`${what}: the jump drew only ${result.frames.length} frames`);
  const bad = result.frames.find((frame) => frame.found.length > 0);
  if (bad) {
    const index = result.frames.indexOf(bad);
    const worst = Math.max(...bad.found.map((item) => item.px));
    fail(`${what}: ${bad.found.length} glyphs outside their cell on frame ${index + 1} of ${result.frames.length}, ${Math.round(bad.after)} ms after the move, up to ${worst} px: ${describe(bad.found)}`);
  }
  if (result.released.length > 0) fail(`${what}: after the release a glyph is outside its track: ${describe(result.released)}`);
}

/** What a frame should keep from rest: each block's right edge against the pane's, in px. */
function gaps(edges: DesEdges) {
  // A short last row of pairs ends before the grid's last column: only full rows reach it.
  const lastRight = (rows: Token[][]) => {
    const width = Math.max(0, ...rows.map((row) => row.length));
    return rows.filter((row) => row.length === width).map((row) => edges.pane - row.at(-1)!.right);
  };
  return {
    book: lastRight(edges.book),
    fundamentals: lastRight(edges.fundamentals),
    positions: lastRight(edges.positions),
    description: [edges.pane - edges.description],
  };
}

/**
 * Where a frame lets columns down: a column whose edges differ from row to
 * row, header included. Figures end together, labels and names start together.
 */
function misaligned(rows: Token[][], what: string, isFigures: (column: number) => boolean): string | null {
  const width = Math.max(...rows.map((row) => row.length));
  for (let column = 0; column < width; column += 1) {
    const right = isFigures(column);
    const edges = rows.filter((row) => row.length === width).map((row) => right ? row[column]!.right : row[column]!.left);
    if (edges.length > 1 && Math.max(...edges) - Math.min(...edges) > 0.5) {
      return `${what} column ${column} ${right ? "ends" : "starts"} at ${edges.map(round).join(", ")} px`;
    }
  }
  return null;
}

async function resizeDes(cdp: Cdp, from: Point, path: (t: number) => Point, moves = 45): Promise<{ during: DesEdges[]; held: DesEdges; released: DesEdges }> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  await evaluate(cdp, `(() => {
    window.__desEdges = [];
    window.__desSampling = true;
    const tick = () => {
      if (!window.__desSampling) return;
      setTimeout(() => { if (window.__desSampling) window.__desEdges.push(__des.edges()); }, 0);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  let to = from;
  for (let move = 1; move <= moves; move += 1) {
    to = path(move / moves);
    await mouse(cdp, "mouseMoved", to.x, to.y, true);
    await frames(cdp);
  }
  await frames(cdp, 2);
  const during = await evaluate<DesEdges[]>(cdp, "(() => { window.__desSampling = false; return window.__desEdges; })()");
  const held = await evaluate<DesEdges>(cdp, "__des.edges()");
  await mouse(cdp, "mouseReleased", to.x, to.y, false);
  await frames(cdp, 8);
  await evaluate(cdp, "new Promise((done) => setTimeout(done, 250))");
  const released = await evaluate<DesEdges>(cdp, "__des.edges()");
  return { during, held, released };
}

/** Every block keeps its right gap on every frame and on release, and every column lines up with its header. */
function expectFollowed(rest: DesEdges, result: { during: DesEdges[]; held: DesEdges; released: DesEdges }, what: string): void {
  const expected = gaps(rest);
  for (const [kind, values] of Object.entries(expected)) {
    if (values.length === 0 || values.some((value) => !Number.isFinite(value))) fail(`${what}: no ${kind} at rest`);
    if (Math.max(...values) - Math.min(...values) > 0.5) fail(`${what}: the ${kind} rows do not end at one place at rest`, values.map(round));
  }
  let worst = { px: 0, kind: "", frame: -1 };
  const frames = [...result.during, result.held, result.released];
  frames.forEach((edges, frame) => {
    const now = gaps(edges);
    for (const kind of Object.keys(expected) as Array<keyof typeof expected>) {
      for (const gap of now[kind]) {
        const px = Math.abs(gap - expected[kind][0]!);
        if (px > worst.px) worst = { px: round(px), kind, frame };
      }
    }
    // Positions: the account, then figures. Fundamentals: label and value pairs. The book: a label and a figure.
    const broken = misaligned(edges.positions, "the positions", (column) => column > 0)
      ?? misaligned(edges.fundamentals, "the fundamentals", (column) => column % 2 === 1)
      ?? misaligned(edges.book, "the quote book", (column) => column === 1);
    if (broken) fail(`${what}: ${broken} (frame ${frame} of ${frames.length})`);
  });
  if (worst.px > 0.5) {
    const at = worst.frame >= result.during.length ? (worst.frame === result.during.length ? "just before the release" : "after the release") : `frame ${worst.frame} of ${result.during.length}`;
    fail(`${what}: the ${worst.kind} ended ${worst.px} px away from where it keeps to the pane's edge (${at})`);
  }
}

async function readyHelpers(cdp: Cdp): Promise<void> {
  await evaluate(cdp, DES_HELPERS);
  if (!await waitFor(cdp, "!!__des.paneElement() && !!__des.leaf('Bid') && __des.section('Positions').length > 1", 5_000)) fail("DES drew no quote book or positions");
  await frames(cdp, 10);
}

async function ready(cdp: Cdp): Promise<DesEdges> {
  await readyHelpers(cdp);
  return evaluate<DesEdges>(cdp, "__des.edges()");
}

const dividerPoint = (cdp: Cdp) => evaluate<Point | null>(cdp, `(() => { const d = document.querySelector('[data-gloom-role=dock-divider]')?.getBoundingClientRect(); return d ? { x: d.x + d.width / 2, y: 300 } : null; })()`);
const gripPoint = (cdp: Cdp) => evaluate<Point | null>(cdp, `(() => { const g = document.querySelector('[data-gloom-pane-id="des:a"] [data-gloom-role=resize-handle]')?.getBoundingClientRect(); return g ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : null; })()`);

/** Long names, values, details and links, nine accounts and a long description. */
const LONG_FIXTURE = "des&long=1&positions=9&scale=3";

/** The pointer jumps inward in one move, by an amount that a drag's frame can cover between two catch-ups. */
const jumpSteps: DesStep[] = [60, 200].flatMap((by): DesStep[] => [
  {
    name: `DES resize: after the divider jumps ${by} px inward in one move, no glyph is outside its cell on any frame, and nothing is past the pane's edge`,
    scenario: LONG_FIXTURE,
    async run(cdp) {
      await readyHelpers(cdp);
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      expectContained(await jumpDes(cdp, divider, { x: divider.x - by, y: divider.y }), `a ${by} px divider jump`);
    },
  },
  {
    name: `DES resize: after a floating pane's corner jumps ${by} px inward in one move, no glyph is outside its cell on any frame, and nothing is past the pane's edge`,
    scenario: `${LONG_FIXTURE}&float=1`,
    async run(cdp) {
      await readyHelpers(cdp);
      const grip = await gripPoint(cdp) ?? fail("no resize grip");
      expectContained(await jumpDes(cdp, grip, { x: grip.x - by, y: grip.y - by * 0.37 }), `a ${by} px corner jump`);
    },
  },
]);

export const desSteps: DesStep[] = [
  ...jumpSteps,
  {
    name: "DES resize: the quote book, fundamentals, positions and description follow a divider drag to the pixel, line up with their headers, and stay put when it lets go",
    scenario: "des",
    async run(cdp) {
      const rest = await ready(cdp);
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      // In past a column breakpoint and part of the way back, ending between cells.
      const result = await resizeDes(cdp, divider, (t) => ({ x: divider.x - Math.sin(t * Math.PI * 0.8) * 260, y: divider.y }));
      expectFollowed(rest, result, "a divider drag");
    },
  },
  {
    name: "DES resize: the quote book, fundamentals, positions and description follow a floating pane's corner to the pixel, line up with their headers, and stay put when it lets go",
    scenario: "des&float=1",
    async run(cdp) {
      const rest = await ready(cdp);
      const grip = await gripPoint(cdp) ?? fail("no resize grip");
      const result = await resizeDes(cdp, grip, (t) => ({ x: grip.x - 181 * t, y: grip.y - 66 * t }));
      expectFollowed(rest, result, "a corner drag");
    },
  },
];
