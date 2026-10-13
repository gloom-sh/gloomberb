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

async function ready(cdp: Cdp): Promise<DesEdges> {
  await evaluate(cdp, DES_HELPERS);
  if (!await waitFor(cdp, "!!__des.paneElement() && !!__des.leaf('Bid') && __des.section('Positions').length > 1", 5_000)) fail("DES drew no quote book or positions");
  await frames(cdp, 10);
  return evaluate<DesEdges>(cdp, "__des.edges()");
}

const dividerPoint = (cdp: Cdp) => evaluate<Point | null>(cdp, `(() => { const d = document.querySelector('[data-gloom-role=dock-divider]')?.getBoundingClientRect(); return d ? { x: d.x + d.width / 2, y: 300 } : null; })()`);
const gripPoint = (cdp: Cdp) => evaluate<Point | null>(cdp, `(() => { const g = document.querySelector('[data-gloom-pane-id="des:a"] [data-gloom-role=resize-handle]')?.getBoundingClientRect(); return g ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : null; })()`);

export const desSteps: DesStep[] = [
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
