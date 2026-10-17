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
  lines: Lines;
}
interface Problem { kind: string; message: string }
interface Lines {
  /** The content box's right edge, read off a column grid (which follows the pane's). */
  limit: number;
  paneRight: number;
  ranges: Array<{ left: number; right: number; track: number; end: number; top: number }>;
  strip: Array<{ text: string; left: number; right: number; top: number }>;
  identity: { box: number; state: number } | null;
  hint: number | null;
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
  /**
   * Where the pieces that sit beside the tables end: the range bars, the
   * return strip's pairs, the company line's status and the footer's hint,
   * found by what they are made of so a branch that draws them differently
   * reads the same.
   */
  lines() {
    const paneWindow = document.querySelector('[data-gloom-pane-id="des:a"]');
    // The widest grid fills the content box (the quote book beside the summary is narrower).
    const gridEdges = [...paneWindow.querySelectorAll('[data-gloom-ui=column-grid]')].map((grid) => grid.getBoundingClientRect().right);
    const limit = gridEdges.length > 0 ? Math.max(...gridEdges) : NaN;
    const content = this.paneElement();
    const ranges = [...content.querySelectorAll('[data-gloom-role=range-track]')].map((track) => {
      const row = track.closest('[data-gloom-role=range-row]') ?? track.parentElement.parentElement;
      const box = row.getBoundingClientRect();
      const end = row.lastElementChild.getBoundingClientRect();
      return { left: box.left, right: box.right, track: track.getBoundingClientRect().right, end: end.right, top: Math.round(box.top) };
    });
    const heading = this.leaf('Price Return');
    const strip = [];
    if (heading) {
      let section = heading.closest('div');
      while (section.parentElement && section.parentElement.children.length < 2) section = section.parentElement;
      for (const label of section.parentElement.querySelectorAll('span')) {
        if (label.childElementCount !== 0 || !/^(\\d+[DWMY]|YTD|MTD|QTD)$/.test(label.textContent.trim())) continue;
        const pair = label.parentElement.getBoundingClientRect();
        const text = label.parentElement.lastElementChild.getBoundingClientRect();
        strip.push({ text: label.textContent.trim(), left: pair.left, right: Math.max(pair.right, text.right), top: Math.round(pair.top) });
      }
    }
    const state = this.leaf('STALE') ?? this.leaf('CLOSED') ?? this.leaf('OPEN');
    let identity = null;
    if (state) {
      const row = state.parentElement;
      identity = { box: row.getBoundingClientRect().right, state: state.getBoundingClientRect().right - parseFloat(getComputedStyle(state).paddingRight || '0') };
    }
    const hint = paneWindow.querySelector('[data-gloom-role=pane-hint]');
    return {
      limit,
      paneRight: paneWindow.getBoundingClientRect().right,
      ranges,
      strip,
      identity,
      hint: hint ? hint.getBoundingClientRect().right : null,
    };
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
      lines: this.lines(),
    };
  },
};
`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

const round = (value: number) => Math.round(value * 100) / 100;

interface Overflow { section: string; what: string; text: string; char: string; px: number }
interface JumpFrame<T = Overflow[]> { after: number; found: T }

/**
 * Lets the pointer jump `by` from `from` in one move, with no frame waited, and
 * reads every frame that follows: the first ones draw the pane at its new
 * size with every cell still laid out for the old one, until a catch-up
 * (100 ms) lays them out again. Then it lets go and reads the settled pane.
 */
async function jumpDes<T = Overflow[]>(cdp: Cdp, from: Point, to: Point, read = "__des.overflow()"): Promise<{ before: T; frames: Array<JumpFrame<T>>; released: T }> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  const before = await evaluate<T>(cdp, read);
  await evaluate(cdp, `(() => {
    window.__jump = { at: null, frames: [] };
    document.addEventListener("pointermove", () => { window.__jump.at ??= performance.now(); }, { capture: true, once: true });
    const tick = () => {
      if (!window.__jump.sampling) return;
      const after = window.__jump.at == null ? -1 : performance.now() - window.__jump.at;
      setTimeout(() => { if (window.__jump.sampling) window.__jump.frames.push({ after, found: ${read} }); }, 0);
      requestAnimationFrame(tick);
    };
    window.__jump.sampling = true;
    requestAnimationFrame(tick);
  })()`);
  await mouse(cdp, "mouseMoved", to.x, to.y, true);
  // About a quarter of a second of frames: the ones before the catch-up and the ones after it.
  await evaluate(cdp, "new Promise((done) => setTimeout(done, 280))");
  const sampled = await evaluate<Array<JumpFrame<T>>>(cdp, "(() => { window.__jump.sampling = false; return window.__jump.frames; })()");
  await mouse(cdp, "mouseReleased", to.x, to.y, false);
  await frames(cdp, 8);
  await evaluate(cdp, "new Promise((done) => setTimeout(done, 250))");
  const released = await evaluate<T>(cdp, read);
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

/**
 * What a frame must keep from rest, for the pieces beside the tables: the
 * range bars end where they ended against the content edge, the return strip
 * packs its pairs as a row that wraps at the edge would (every pair inside it,
 * none wrapped that had room), the company line's status keeps its place at
 * the end of the row, and the footer's hint keeps its gap to the pane's edge.
 */
function linesProblems(now: Lines, rest: Lines): Problem[] {
  const problems: Problem[] = [];
  const differs = (a: number, b: number) => Math.abs(a - b) > 0.5;
  if (rest.ranges.length > 0) {
    if (now.ranges.length === 0) problems.push({ kind: "range bars", message: "the range bars are gone" });
    else {
      const want = rest.limit - Math.max(...rest.ranges.map((range) => range.right));
      const got = now.limit - Math.max(...now.ranges.map((range) => range.right));
      if (differs(got, want)) problems.push({ kind: "range bars", message: `the range bars end ${round(got)} px inside the content edge, ${round(want)} px at rest` });
    }
  }
  if (rest.strip.length > 1) {
    const second = rest.strip.findIndex((pair, index) => index > 0 && Math.abs(pair.top - rest.strip[index - 1]!.top) < 2);
    const between = second > 0 ? rest.strip[second]!.left - rest.strip[second - 1]!.right : 24;
    const tops = [...new Set(now.strip.map((pair) => pair.top))].sort((a, b) => a - b);
    const rows = tops.map((top) => now.strip.filter((pair) => pair.top === top));
    rows.forEach((row, index) => {
      const last = row.at(-1)!;
      if (last.right > now.limit + 0.5) problems.push({ kind: "return strip", message: `${last.text} ends ${round(last.right - now.limit)} px past the content edge` });
      const next = rows[index + 1]?.[0];
      const spare = next ? now.limit - last.right - between - (next.right - next.left) : -1;
      if (next && spare > 0.5) problems.push({ kind: "return strip", message: `${next.text} wrapped to the next row with ${round(spare)} px to spare` });
    });
  }
  if (rest.identity) {
    if (!now.identity) problems.push({ kind: "company line", message: "the status is gone" });
    else if (now.identity.state > now.identity.box + 0.5) problems.push({ kind: "company line", message: `the status is ${round(now.identity.state - now.identity.box)} px past its row` });
    else if (differs(now.identity.box - now.identity.state, rest.identity.box - rest.identity.state)) {
      problems.push({ kind: "company line", message: `the status ends ${round(now.identity.box - now.identity.state)} px inside its row, ${round(rest.identity.box - rest.identity.state)} px at rest` });
    }
  }
  if (rest.hint != null) {
    if (now.hint == null) problems.push({ kind: "footer hint", message: "the hint is gone" });
    else if (differs(now.paneRight - now.hint, rest.paneRight - rest.hint)) {
      problems.push({ kind: "footer hint", message: `${round(now.paneRight - now.hint)} px from the pane's edge, ${round(rest.paneRight - rest.hint)} px at rest` });
    }
  }
  return problems;
}

/** Each kind of piece that left its place, on how many frames, and the first frame it did. */
function summarize(frames: Array<{ label: string; problems: Problem[] }>): string | null {
  const kinds = new Map<string, { count: number; first: string }>();
  for (const frame of frames) {
    for (const problem of frame.problems) {
      const seen = kinds.get(problem.kind);
      if (seen) seen.count += 1;
      else kinds.set(problem.kind, { count: 1, first: `${frame.label}: ${problem.message}` });
    }
  }
  if (kinds.size === 0) return null;
  return [...kinds].map(([kind, { count, first }]) => `${kind} on ${count} of ${frames.length} frames, first ${first}`).join("; ");
}

function expectLinesFollowed(rest: Lines, result: { during: DesEdges[]; held: DesEdges; released: DesEdges }, what: string): void {
  if (rest.ranges.length === 0 || rest.strip.length === 0 || !rest.identity || rest.hint == null) fail(`${what}: the pane at rest lacks a range bar, a return strip, a status or a footer hint`, { ranges: rest.ranges.length, strip: rest.strip.length, identity: !!rest.identity, hint: rest.hint });
  const all = [...result.during, result.held, result.released];
  const failed = summarize(all.map((edges, frame) => ({ label: frame === all.length - 1 ? "after the release" : `frame ${frame}`, problems: linesProblems(edges.lines, rest) })));
  if (failed) fail(`${what}: ${failed}`);
}

/** Every frame after the jump, the first included, and the settled pane after the release. */
function expectLinesHeld(result: { before: Lines; frames: Array<JumpFrame<Lines>>; released: Lines }, what: string): void {
  const rest = result.before;
  if (rest.ranges.length === 0 || rest.strip.length === 0 || !rest.identity || rest.hint == null) fail(`${what}: the pane at rest lacks a range bar, a return strip, a status or a footer hint`, { ranges: rest.ranges.length, strip: rest.strip.length, identity: !!rest.identity, hint: rest.hint });
  if (result.frames.length < 4) fail(`${what}: the jump drew only ${result.frames.length} frames`);
  const failed = summarize([
    ...result.frames.map((frame, index) => ({ label: `frame ${index + 1}, ${Math.round(frame.after)} ms after the move`, problems: linesProblems(frame.found, rest) })),
    { label: "after the release", problems: linesProblems(result.released, rest) },
  ]);
  if (failed) fail(`${what}: ${failed}`);
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

/** The company name, the status and the footer's hint all on one row each, in a fixture whose name is longer than the row. */
const LINES_FIXTURE = "des&long=1&footer=1";

/** Narrow enough to wrap the return strip, and the docked pane keeps the company name cut at every width of a drag. */
const NARROW = "&ratio=0.38";
const FLOAT_NARROW = "&fw=64";

/** The pane at two widths: narrow, with the range bars stacked, and wide, with the two side by side. */
const LINE_WIDTHS = [
  { label: "", dock: NARROW, float: FLOAT_NARROW },
  { label: " (range bars side by side)", dock: "", float: "" },
];

const lineJumps: DesStep[] = [60, 200].flatMap((by): DesStep[] => LINE_WIDTHS.flatMap((width): DesStep[] => [
  {
    name: `DES resize: after the divider jumps ${by} px inward in one move, the range bars, return strip, company line and footer hint are where a CSS layout puts them on every frame${width.label}`,
    scenario: LINES_FIXTURE + width.dock,
    async run(cdp) {
      await readyHelpers(cdp);
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      const result = await jumpDes<Lines>(cdp, divider, { x: divider.x - by, y: divider.y }, "__des.lines()");
      expectLinesHeld(result, `a ${by} px divider jump`);
    },
  },
  {
    name: `DES resize: after a floating pane's corner jumps ${by} px inward in one move, the range bars, return strip, company line and footer hint are where a CSS layout puts them on every frame${width.label}`,
    scenario: `${LINES_FIXTURE}&float=1${width.float}`,
    async run(cdp) {
      await readyHelpers(cdp);
      const grip = await gripPoint(cdp) ?? fail("no resize grip");
      const result = await jumpDes<Lines>(cdp, grip, { x: grip.x - by, y: grip.y - by * 0.37 }, "__des.lines()");
      expectLinesHeld(result, `a ${by} px corner jump`);
    },
  },
]));

export const desSteps: DesStep[] = [
  ...jumpSteps,
  ...lineJumps,
  {
    name: "DES resize: the range bars, return strip, company line and footer hint follow a divider drag to the pixel, and stay put when it lets go",
    scenario: LINES_FIXTURE + NARROW,
    async run(cdp) {
      const rest = await ready(cdp);
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      // Far enough in to wrap the return strip, and short of the width where the footer swaps its hint for More.
      const result = await resizeDes(cdp, divider, (t) => ({ x: divider.x - Math.sin(t * Math.PI * 0.8) * 200, y: divider.y }));
      expectLinesFollowed(rest.lines, result, "a divider drag");
    },
  },
  {
    name: "DES resize: the range bars, return strip, company line and footer hint follow a floating pane's corner to the pixel, and stay put when it lets go",
    scenario: `${LINES_FIXTURE}&float=1${FLOAT_NARROW}`,
    async run(cdp) {
      const rest = await ready(cdp);
      const grip = await gripPoint(cdp) ?? fail("no resize grip");
      const result = await resizeDes(cdp, grip, (t) => ({ x: grip.x - 181 * t, y: grip.y - 66 * t }));
      expectLinesFollowed(rest.lines, result, "a corner drag");
    },
  },
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
