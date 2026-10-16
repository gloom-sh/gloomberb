import { evaluate, frames, mouse, waitFor, type Cdp, type Point } from "./browser";

/**
 * The chat list, driven with real pointer, wheel and keyboard input over an
 * invented channel (chat-fixture.tsx): which row is marked, where the list is
 * after each thing that can happen to it, and the control that offers the newest
 * message. Positions are read back from the page: the scroll offset, and where
 * the message at the top of the view sits in it, which is what a reader notices.
 *
 * Steps whose scenario says `anchoring=off` run with the engine's own scroll
 * anchoring switched off, as it is in browsers that have none, so they show what
 * the list does for itself.
 */

interface ChatStep {
  name: string;
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

interface ListState { top: number; height: number; client: number; fromBottom: number }
interface Anchor { id: string; offset: number }

/** Page helpers for the chat list, installed by each step. Rows are found by what they are, not by their place in the tree. */
const CHAT_HELPERS = `
window.__chat = {
  scroller() {
    const row = document.querySelector('[data-gloom-role=chat-message]');
    return row?.closest('[data-gloom-role=chat-transcript]') ?? null;
  },
  rows() { return [...(this.scroller()?.querySelectorAll('[data-gloom-role=chat-message]') ?? [])]; },
  state() {
    const s = this.scroller();
    if (!s) return null;
    return { top: s.scrollTop, height: s.scrollHeight, client: s.clientHeight, fromBottom: s.scrollHeight - s.clientHeight - s.scrollTop };
  },
  /** The first message with any part in view, and how far below the view's top it starts. */
  anchor() {
    const s = this.scroller();
    const top = s.getBoundingClientRect().top;
    const row = this.rows().find((r) => r.getBoundingClientRect().bottom > top + 1);
    return row ? { id: row.getAttribute('data-gloom-chat-message-id'), offset: row.getBoundingClientRect().top - top } : null;
  },
  /** How far below the view's top the message starts, wherever it is; null while it is not drawn. */
  offsetOf(id) {
    const row = this.rows().find((r) => r.getAttribute('data-gloom-chat-message-id') === id);
    return row ? row.getBoundingClientRect().top - this.scroller().getBoundingClientRect().top : null;
  },
  rowRect(id) {
    const row = this.rows().find((r) => r.getAttribute('data-gloom-chat-message-id') === id);
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  },
  /** Rows that look marked: a band painted on them, or their Reply button showing. */
  marked() {
    return this.rows().filter((row) => {
      const painted = [...row.querySelectorAll('[data-gloom-role=chat-message-row]')]
        .some((el) => { const bg = getComputedStyle(el).backgroundColor; return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'; });
      const reply = row.querySelector('[data-gloom-role=chat-message-reply-action]');
      return painted || (reply ? parseFloat(getComputedStyle(reply).opacity) > 0.01 : false);
    }).map((row) => row.getAttribute('data-gloom-chat-message-id'));
  },
  /** Rows selected, the keyboard's cursor: nothing but a key press or a reply should leave one. */
  selected() { return this.rows().filter((row) => row.getAttribute('data-selected') === 'true').map((row) => row.getAttribute('data-gloom-chat-message-id')); },
  jump() {
    const control = document.querySelector('[data-gloom-role=chat-new-messages] button');
    if (!control) return null;
    const r = control.getBoundingClientRect();
    return { text: control.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  },
  composer() {
    const r = document.querySelector('textarea')?.getBoundingClientRect();
    return r ? { x: r.x + 24, y: r.y + r.height / 2 } : null;
  },
  /**
   * The lowest name of a user in view: its box, colour, the icons its header
   * row shows, where the status beside it starts, and the row's height.
   */
  name(username) {
    const view = this.scroller().getBoundingClientRect();
    const text = [...document.querySelectorAll('[data-gloom-role=chat-message-row] span, [data-gloom-role=chat-message-row] div')]
      .filter((el) => {
        if (el.childElementCount !== 0 || el.textContent !== username) return false;
        const r = el.getBoundingClientRect();
        return r.top >= view.top && r.bottom <= view.bottom;
      })
      .at(-1);
    if (!text) return null;
    const row = text.closest('[data-gloom-role=chat-message-row]');
    const message = row.closest('[data-gloom-role=chat-message]');
    const r = text.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const icons = [...row.querySelectorAll('[data-gloom-role=chat-person-icon]')].map((icon) => {
      const b = icon.getBoundingClientRect();
      return {
        id: icon.getAttribute('data-person-icon'),
        title: icon.getAttribute('title'),
        left: b.left,
        drawn: !!icon.querySelector('svg[data-gloom-icon]'),
        visible: b.width > 0 && b.right <= rowRect.right + 0.5 && b.bottom <= rowRect.bottom + 0.5,
      };
    });
    // The status text after the name and its icons: the first leaf that reads like one.
    const status = [...row.querySelectorAll('span, div')]
      .find((el) => el.childElementCount === 0 && /^\\s*(\\d|now|sending|failed)/.test(el.textContent ?? ''));
    // The desktop draws a row's actions on every row and shows them on hover.
    const actions = row.querySelector('[data-gloom-role=chat-message-reply-action]')?.getBoundingClientRect();
    const actionsInRow = !actions || actions.right <= rowRect.right + 0.5;
    return {
      id: message?.getAttribute('data-gloom-chat-message-id') ?? null,
      x: r.x + r.width / 2,
      y: r.y + r.height / 2,
      left: r.left,
      top: r.top,
      // Whole: its box as wide as its text, and no icon over it.
      nameWhole: text.parentElement.getBoundingClientRect().width >= r.width - 0.5 && icons.every((icon) => icon.left >= r.right - 0.5),
      rowHeight: rowRect.height,
      statusLeft: status ? status.getBoundingClientRect().left : null,
      color: getComputedStyle(text).color,
      icons,
      actionsInRow,
    };
  },
  /** The text of the open profile card, or null. */
  card() {
    const card = this.cardElement();
    return card ? card.textContent : null;
  },
  cardElement() {
    return [...document.querySelectorAll('.gloom-popover')].find((popover) => popover.querySelector('[data-gloom-role^=chat-profile-]')) ?? null;
  },
  /** The icons the open card shows beside the handle. */
  cardIcons() {
    return [...(this.cardElement()?.querySelectorAll('[data-gloom-role=chat-person-icon]') ?? [])].map((icon) => icon.getAttribute('data-person-icon')).join();
  },
  neighbour() {
    const r = document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="plain:a"]')?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  },
  /** A message's chips: what each says, where it is, and whether it shows a picture. */
  chips(id) {
    const row = this.rows().find((r) => r.getAttribute('data-gloom-chat-message-id') === id);
    return [...(row?.querySelectorAll('[data-gloom-role=chat-pane-chip]') ?? [])].map((chip) => {
      const r = chip.getBoundingClientRect();
      return { link: chip.getAttribute('data-gloom-pane-link'), text: chip.textContent, picture: !!chip.querySelector('img'), x: r.x + r.width / 2, y: r.y + r.height / 2, height: r.height };
    });
  },
  /** Everything a message row draws, chips and controls included. */
  rowText(id) {
    return this.rows().find((r) => r.getAttribute('data-gloom-chat-message-id') === id)?.textContent ?? '';
  },
  /**
   * How far left of the chat pane's right edge, in px, each row in view ends,
   * with the text box of its body and the cut-off of its reply quote; and the
   * widths of all rows, in view or not.
   */
  edges() {
    const pane = document.querySelector('[data-gloom-pane-id="chat:a"] [data-gloom-role=pane-content]').getBoundingClientRect();
    const view = this.scroller().getBoundingClientRect();
    const rows = this.rows();
    const inView = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > view.top && b.top < view.bottom; });
    const gap = (el) => pane.right - el.getBoundingClientRect().right;
    return {
      rows: inView.map(gap),
      bodies: inView.flatMap((r) => [...r.querySelectorAll('[data-gloom-role=chat-message-body]')].map(gap)),
      quotes: inView.flatMap((r) => [...r.querySelectorAll('[data-gloom-role=chat-message-row] [style*="text-overflow: ellipsis"]')].map(gap)),
      widths: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().width * 100) / 100))],
      fromBottom: this.state().fromBottom,
    };
  },
  /** The words a message's body draws, without its chips. */
  bodyText(id) {
    const row = this.rows().find((r) => r.getAttribute('data-gloom-chat-message-id') === id);
    return row?.querySelector('[data-gloom-role=chat-message-body]')?.textContent ?? '';
  },
};
`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

const state = (cdp: Cdp) => evaluate<ListState>(cdp, "__chat.state()");
const anchor = (cdp: Cdp) => evaluate<Anchor>(cdp, "__chat.anchor()");
const marked = (cdp: Cdp) => evaluate<string[]>(cdp, "__chat.marked()");
const selected = (cdp: Cdp) => evaluate<string[]>(cdp, "__chat.selected()");
const pause = (cdp: Cdp, ms: number) => evaluate(cdp, `new Promise((done) => setTimeout(done, ${ms}))`);

async function ready(cdp: Cdp): Promise<void> {
  await evaluate(cdp, CHAT_HELPERS);
  if (!await waitFor(cdp, "__chat.rows().length > 0", 5_000)) fail("the chat list drew no messages");
  // The view settles (the list opens at the bottom, the composer takes its height) over a few frames.
  await frames(cdp, 20);
}

async function listCentre(cdp: Cdp): Promise<Point> {
  return evaluate<Point>(cdp, `(() => { const r = __chat.scroller().getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
}

/** A wheel turn at `at`, with the pointer put there first like a mouse would be. */
async function wheel(cdp: Cdp, at: Point, deltaY: number): Promise<void> {
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  await turnWheel(cdp, at, deltaY);
}

/** A wheel turn without moving the pointer: the list scrolls under it. */
async function turnWheel(cdp: Cdp, at: Point, deltaY: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY });
  await frames(cdp, 4);
}

async function click(cdp: Cdp, at: Point): Promise<void> {
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  await mouse(cdp, "mousePressed", at.x, at.y, true);
  await mouse(cdp, "mouseReleased", at.x, at.y, false);
  await frames(cdp, 3);
}

/** A key that does nothing in the chat but be pressed. */
async function pressKey(cdp: Cdp, key: string, code: string, text?: string): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, text, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
  await frames(cdp, 3);
}

/** Moves to a message's row, with two moves so the pointer has really moved. */
async function hoverRow(cdp: Cdp, id: string): Promise<Point> {
  const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(cdp, `__chat.rowRect(${JSON.stringify(id)})`) ?? fail(`no row ${id}`);
  const at = { x: rect.x + rect.width * 0.4, y: rect.y + rect.height / 2 };
  await mouse(cdp, "mouseMoved", at.x - 8, at.y, false);
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  await frames(cdp, 3);
  return at;
}

/** The id of a row well inside the view, `n` rows down from its top. */
async function visibleRow(cdp: Cdp, n = 3): Promise<string> {
  return evaluate<string>(cdp, `(() => {
    const s = __chat.scroller().getBoundingClientRect();
    const rows = __chat.rows().filter((r) => { const b = r.getBoundingClientRect(); return b.top >= s.top && b.bottom <= s.bottom; });
    return rows[Math.min(${n}, rows.length - 1)].getAttribute('data-gloom-chat-message-id');
  })()`);
}

function expectPlace(before: Anchor, after: Anchor, what: string, tolerance = 1): void {
  if (before.id !== after.id || Math.abs(before.offset - after.offset) > tolerance) {
    fail(`${what} moved the reader off the message they were reading`, { before, after });
  }
}

function expectMarked(actual: string[], expected: string[], what: string): void {
  if (actual.join() !== expected.join()) fail(`${what}: rows marked ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/** The handle prompt's field, its value and whether it has the focus; null once the prompt is gone. */
const handleField = (cdp: Cdp) => evaluate<{ x: number; y: number; value: string; focused: boolean; text: string } | null>(cdp, `(() => {
  const prompt = document.querySelector('[data-gloom-role=chat-handle-prompt]');
  const input = prompt?.querySelector('input');
  if (!input) return null;
  const r = input.getBoundingClientRect();
  return { x: r.x + 24, y: r.y + r.height / 2, value: input.value, focused: document.activeElement === input, text: prompt.textContent };
})()`);

async function backspace(cdp: Cdp, times: number): Promise<void> {
  for (let press = 0; press < times; press += 1) {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  }
  await frames(cdp, 3);
}

interface Edges { rows: number[]; bodies: number[]; quotes: number[]; widths: number[]; fromBottom: number }

/** Each kind's single distance from the pane's right edge, or a failure when its rows do not share one. */
function restGaps(edges: Edges, what: string): Record<"rows" | "bodies" | "quotes", number> {
  const one = (values: number[], kind: string) => {
    if (values.length === 0) fail(`${what}: no ${kind} in view`);
    if (Math.max(...values) - Math.min(...values) > 0.5) fail(`${what}: the ${kind} in view do not end at one place`, values);
    return values[0]!;
  };
  return { rows: one(edges.rows, "rows"), bodies: one(edges.bodies, "message bodies"), quotes: one(edges.quotes, "reply quotes") };
}

/**
 * Resizes the chat pane with real pointer input, one move a frame, from
 * `from` along `path` (t from 0 to 1), and reads the edges after every frame
 * has laid out, just before the release, and once the release has settled.
 */
async function resizeChat(cdp: Cdp, from: Point, path: (t: number) => Point, moves = 45): Promise<{ during: Edges[]; held: Edges; released: Edges }> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  await evaluate(cdp, `(() => {
    window.__edges = [];
    window.__sampling = true;
    const tick = () => {
      if (!window.__sampling) return;
      setTimeout(() => { if (window.__sampling) window.__edges.push(__chat.edges()); }, 0);
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
  const during = await evaluate<Edges[]>(cdp, "(() => { window.__sampling = false; return window.__edges; })()");
  const held = await evaluate<Edges>(cdp, "__chat.edges()");
  await mouse(cdp, "mouseReleased", to.x, to.y, false);
  await frames(cdp, 8);
  await pause(cdp, 250);
  const released = await evaluate<Edges>(cdp, "__chat.edges()");
  return { during, held, released };
}

/** Every row in view, its text and its quote end where they did at rest, on every frame of the drag and after the release. */
function expectFollowed(rest: Edges, result: { during: Edges[]; held: Edges; released: Edges }, what: string): void {
  const expected = restGaps(rest, `${what} at rest`);
  let worst = { px: 0, kind: "", frame: -1 };
  result.during.forEach((edges, frame) => {
    for (const kind of ["rows", "bodies", "quotes"] as const) {
      for (const gap of edges[kind]) {
        const px = Math.abs(gap - expected[kind]);
        if (px > worst.px) worst = { px: Math.round(px * 100) / 100, kind, frame };
      }
    }
  });
  if (worst.px > 0.5) fail(`${what}: the ${worst.kind} in view fell ${worst.px} px behind the pane's edge (frame ${worst.frame} of ${result.during.length})`);
  const jump = Math.max(...(["rows", "bodies", "quotes"] as const).flatMap((kind) => [...result.held[kind], ...result.released[kind]].map((gap) => Math.abs(gap - expected[kind]))));
  if (jump > 0.5) fail(`${what}: the rows in view moved ${Math.round(jump * 100) / 100} px when the pointer let go`, { held: result.held, released: result.released });
}

const dividerPoint = (cdp: Cdp) => evaluate<Point | null>(cdp, `(() => { const d = document.querySelector('[data-gloom-role=dock-divider]')?.getBoundingClientRect(); return d ? { x: d.x + d.width / 2, y: 300 } : null; })()`);
const gripPoint = (cdp: Cdp) => evaluate<Point | null>(cdp, `(() => { const g = document.querySelector('[data-gloom-pane-id="chat:a"] [data-gloom-role=resize-handle]')?.getBoundingClientRect(); return g ? { x: g.x + g.width / 2, y: g.y + g.height / 2 } : null; })()`);

const OPENED_ON = "m60";

/** Opens on a message the way a notification does, with the pointer parked outside the list. */
async function openOnTarget(cdp: Cdp): Promise<void> {
  await ready(cdp);
  const away = await evaluate<Point>(cdp, "__chat.neighbour()");
  await mouse(cdp, "mouseMoved", away.x, away.y, false);
  await frames(cdp, 3);
}

interface PersonIconState { id: string; title: string | null; left: number; drawn: boolean; visible: boolean }

interface NameState {
  id: string | null;
  x: number;
  y: number;
  left: number;
  top: number;
  nameWhole: boolean;
  rowHeight: number;
  statusLeft: number | null;
  color: string;
  icons: PersonIconState[];
  actionsInRow: boolean;
}

const nameOf = (cdp: Cdp, username: string) => evaluate<NameState | null>(cdp, `__chat.name(${JSON.stringify(username)})`);

async function pointAtName(cdp: Cdp, username: string): Promise<void> {
  const name = await nameOf(cdp, username) ?? fail(`no name ${username} drawn`);
  await mouse(cdp, "mouseMoved", name.x - 4, name.y, false);
  await mouse(cdp, "mouseMoved", name.x, name.y, false);
  await frames(cdp, 3);
}

async function parkPointer(cdp: Cdp): Promise<void> {
  const away = await evaluate<Point>(cdp, "__chat.neighbour()");
  await mouse(cdp, "mouseMoved", away.x, away.y, false);
  await frames(cdp, 3);
}

/** The icons a drawn name's header shows, in order, each drawn and inside the row. */
async function iconsOf(cdp: Cdp, username: string): Promise<string> {
  const name = await nameOf(cdp, username) ?? fail(`no name ${username} drawn`);
  const broken = name.icons.filter((icon) => !icon.drawn || !icon.visible);
  if (broken.length > 0) fail(`${username}'s icons are not all drawn inside the row`, name.icons);
  return name.icons.map((icon) => icon.id).join();
}

/** The name, its status and its row stay where they were. */
function expectUnmoved(before: NameState, after: NameState, what: string): void {
  const moved = Math.abs(before.left - after.left) > 0.5 || Math.abs(before.top - after.top) > 0.5
    || Math.abs(before.rowHeight - after.rowHeight) > 0.5
    || (before.statusLeft !== null && after.statusLeft !== null && Math.abs(before.statusLeft - after.statusLeft) > 0.5);
  if (moved) fail(`${what} moved the name, its status or the row`, { before, after });
}

interface Chip { link: string; text: string; picture: boolean; x: number; y: number; height: number }

/** The invented shares and the last three messages the `chips=1` channel ends on. */
const SHARES = { posted: "5ea7c0de".repeat(4), bare: "b0a7c0de".repeat(4) };
const CHIP_ROWS = { wire: "m87", posted: "m88", bare: "m89" };
/** An invented Wire news post from before the wire dropped the publisher's address; it sits above the three. */
const LEGACY_NEWS = { row: "m86", story: "story-sample", address: "news.example.com" };
const chips = (cdp: Cdp, id: string) => evaluate<Chip[]>(cdp, `__chat.chips(${JSON.stringify(id)})`);

async function oneChip(cdp: Cdp, id: string): Promise<Chip> {
  const found = await chips(cdp, id);
  if (found.length !== 1) fail(`message ${id} should draw one chip`, found);
  return found[0]!;
}

const pointFor = (cdp: Cdp, selector: string) => evaluate<Point>(cdp, `(() => {
  const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw Error('Missing pointer target');
  const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
})()`);

export const chatSteps: ChatStep[] = [
  {
    name: "chat window: an offscreen notification target mounts, highlights and copies, and keyboard navigation crosses windows",
    scenario: "chat&count=500&loaded=500&target=m120",
    async run(cdp) {
      await ready(cdp);
      expectMarked(await marked(cdp), ["m120"], "notification target");
      if (await evaluate<number>(cdp, "__chat.rows().length") > 80) fail("opening mounted the history");
      const body = '[data-gloom-chat-message-id="m120"] [data-gloom-role=chat-message-body]';
      const at = await pointFor(cdp, body);
      await evaluate(cdp, "document.addEventListener('copy',e=>{window.__copied=e.clipboardData.getData('text/plain')||getSelection().toString()},{once:true})");
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 3 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 3 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67 });
      if (!await waitFor(cdp, "window.__copied?.trim()==='Morning all.'")) fail("visible message copy did not retain its text");
      await click(cdp, await listCentre(cdp));
      await pressKey(cdp, "ArrowUp", "ArrowUp");
      for (let i = 0; i < 35; i++) await pressKey(cdp, "ArrowUp", "ArrowUp");
      const chosen = await selected(cdp);
      if (chosen[0] !== "m464") fail("keyboard did not cross the mounted window", chosen);
      const view = await evaluate(cdp, "(()=>{const r=__chat.rowRect('m464'),s=__chat.scroller().getBoundingClientRect();return r&&r.y>=s.top&&r.y+r.height<=s.bottom})()");
      if (!view) fail("keyboard target was not brought into view");
      for (const delta of [-50000, 700, 1400, 50000]) {
        await wheel(cdp, await listCentre(cdp), delta);
        await frames(cdp, 6);
        if (await evaluate<number>(cdp, "__chat.rows().length") > 80 || !await anchor(cdp)) fail("scrolling lost the bounded visible window");
      }
    },
  },
  {
    name: "chat window: a pending send, failed-send retry, reply and reaction survive window changes",
    scenario: "chat&count=500&loaded=500&reactions=1&latency=0",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -1800);
      await evaluate(cdp, "__chatFake.holdSends()");
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await cdp.send("Input.insertText", { text: "Windowed send check" });
      await pressKey(cdp, "Enter", "Enter");
      if (!await waitFor(cdp, "__chatFake.sent.length===1 && __chat.rows().some(r=>r.textContent.includes('Windowed send check'))")) fail("pending send is not mounted");
      if ((await state(cdp)).fromBottom > 4) fail("pending send did not go to the bottom");
      await evaluate(cdp, "__chatFake.finishSend(true)");
      const retry = '[data-gloom-role=chat-message-retry-action] button';
      if (!await waitFor(cdp, `document.querySelector('${retry}')`)) fail("failed send has no retry");
      await click(cdp, await pointFor(cdp, retry));
      if (!await waitFor(cdp, "__chatFake.sent.length===2 && __chat.rowRect('m500') && !document.querySelector('[data-gloom-role=chat-message-retry-action]')")) fail("retry did not replace the pending message");
      await click(cdp, await listCentre(cdp));
      await pressKey(cdp, "ArrowUp", "ArrowUp");
      await pressKey(cdp, "ArrowUp", "ArrowUp");
      await pressKey(cdp, "Enter", "Enter");
      await cdp.send("Input.insertText", { text: "Reply across windows" });
      await pressKey(cdp, "Enter", "Enter");
      if (!await waitFor(cdp, "__chatFake.messages.at(-1).replyToId==='m499'")) fail("keyboard reply lost its target");
      const reaction = '[data-gloom-chat-message-id="m499"] [data-gloom-role=chat-message-reactions] button';
      await click(cdp, await pointFor(cdp, reaction));
      if (!await waitFor(cdp, "__chatFake.messages.find(m=>m.id==='m499').reactions[0].me")) fail("reaction did not toggle");
      await wheel(cdp, await listCentre(cdp), -50000);
      await wheel(cdp, await listCentre(cdp), 50000);
      if (!await waitFor(cdp, "__chat.rowText('m499').includes('2') && __chat.rowText('m501').includes('Reply across windows')")) fail("reply or reaction disappeared after remount");
    },
  },
  {
    name: "chat window: an image reserves its measured space before decoding",
    scenario: "chat&count=500&loaded=500",
    async run(cdp) {
      await ready(cdp);
      await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*held-chat-image*" }] });
      try {
        const paused = cdp.once<{ requestId: string }>("Fetch.requestPaused");
        await evaluate(cdp, `(()=>{const m=__chatFake.deliver('Image that arrives later.',{attachment:true});__chatFake.update(m.id,m=>({...m,attachments:m.attachments.map(a=>({...a,url:location.origin+'/held-chat-image.svg'}))}))})()`);
        const request = await paused;
        await frames(cdp, 8);
        const before = await anchor(cdp);
        const rect = await evaluate(cdp, "__chat.rowRect('m500')");
        if (rect.height < 180) fail("image did not reserve its height", rect);
        await cdp.send("Fetch.fulfillRequest", { requestId: request.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "image/svg+xml" }], body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#456"/></svg>').toString("base64") });
        if (!await waitFor(cdp, "document.querySelector('[data-gloom-chat-message-id=m500] img')?.complete")) fail("image never decoded");
        await frames(cdp, 8);
        const after = await evaluate(cdp, "__chat.rowRect('m500')");
        if (Math.abs(rect.height - after.height) > 1) fail("decoding changed the image row's height", { rect, after });
        expectPlace(before, await anchor(cdp), "image decoding");
      } finally { await cdp.send("Fetch.disable"); }
    },
  },
  {
    name: "chat people: a bot's name has its own colour and its icon always, a person's icons wait for the pointer",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await parkPointer(cdp);
      const bot = await nameOf(cdp, "deskbot") ?? fail("no bot message in view");
      const person = await nameOf(cdp, "quill") ?? fail("no member message in view");
      if (bot.color === person.color) fail("the bot's name is drawn like a person's", { bot: bot.color, person: person.color });
      const expected: Record<string, string> = { deskbot: "bot", marlow: "", quill: "" };
      for (const [username, icons] of Object.entries(expected)) {
        const actual = await iconsOf(cdp, username);
        if (actual !== icons) fail(`${username} shows the wrong icons with no pointer on the row`, { actual, expected: icons });
      }
      const title = bot.icons[0]?.title;
      if (title !== "Bot run by Gloom") fail("the bot's icon does not say what it is", { title });
    },
  },
  {
    name: "chat people: Team and Pro show on the row under the pointer and on the selected row, and nothing moves",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await parkPointer(cdp);
      const before = await nameOf(cdp, "marlow") ?? fail("no staff message in view");
      if (before.icons.length > 0) fail("marlow's icons show with no pointer on the row", before.icons);

      // The pointer on the message's text, then on the name.
      const row = await evaluate<{ x: number; y: number; width: number; height: number } | null>(cdp, `__chat.rowRect(${JSON.stringify(before.id)})`) ?? fail("no row for marlow's message");
      await mouse(cdp, "mouseMoved", row.x + row.width * 0.6, row.y + row.height - 6, false);
      await mouse(cdp, "mouseMoved", row.x + row.width * 0.6 + 4, row.y + row.height - 6, false);
      await frames(cdp, 4);
      const onRow = await nameOf(cdp, "marlow") ?? fail("marlow's name went");
      if (await iconsOf(cdp, "marlow") !== "team,pro") fail("the row under the pointer does not show Team and Pro", onRow.icons);
      expectUnmoved(before, onRow, "showing the icons");
      const titles = onRow.icons.map((icon) => icon.title).join();
      if (titles !== "Gloom team,Pro") fail("the icons do not say what they are", { titles });
      await pointAtName(cdp, "marlow");
      if (await iconsOf(cdp, "marlow") !== "team,pro") fail("the name under the pointer does not show Team and Pro");
      expectUnmoved(before, (await nameOf(cdp, "marlow"))!, "pointing at the name");

      // The pointer goes: so do the icons, and nothing moves back either.
      await parkPointer(cdp);
      if (!await waitFor(cdp, "__chat.card() === null", 2_000)) fail("the card stayed after the pointer left");
      if (await iconsOf(cdp, "marlow") !== "") fail("Team and Pro stayed after the pointer left");
      expectUnmoved(before, (await nameOf(cdp, "marlow"))!, "hiding the icons");

      // Without a mouse: the newest message, marlow's, selected.
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await parkPointer(cdp);
      await pressKey(cdp, "ArrowUp", "ArrowUp");
      const selectedNow = await selected(cdp);
      const newest = await nameOf(cdp, "marlow") ?? fail("marlow's name went");
      if (selectedNow.join() !== newest.id) fail("ArrowUp did not select marlow's newest message", { selected: selectedNow, marlow: newest.id });
      if (await iconsOf(cdp, "marlow") !== "team,pro") fail("the selected row does not show Team and Pro");
      expectUnmoved(before, newest, "selecting the row");
    },
  },
  {
    name: "chat people: pointing at a name opens the card with their icons, local time and what they trade, and the keyboard opens the same card",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await pointAtName(cdp, "marlow");
      if (!await waitFor(cdp, "(__chat.card() ?? '').includes('Local time')", 2_000)) fail("pointing at a name opened no card with a local time");
      const card = await evaluate<string>(cdp, "__chat.card()");
      for (const part of ["Gloom team · Pro", "Trades", "Options, Futures"]) {
        if (!card.includes(part)) fail(`the card does not say ${JSON.stringify(part)}`, card);
      }
      if (!/Local time\s*\d\d:\d\d/.test(card)) fail("the card's local time is not a clock reading", card);
      const cardIcons = await evaluate<string>(cdp, "__chat.cardIcons()");
      if (cardIcons !== "team,pro") fail("the card does not show the icons beside the handle", { cardIcons });
      // The pointer leaves for the pane beside: the card goes.
      await parkPointer(cdp);
      if (!await waitFor(cdp, "__chat.card() === null", 2_000)) fail("the card stayed after the pointer left");

      // Without a mouse: the newest message (marlow's), then p.
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await pressKey(cdp, "ArrowUp", "ArrowUp");
      await pressKey(cdp, "p", "KeyP", "p");
      if (!await waitFor(cdp, "(__chat.card() ?? '').includes('Local time')", 2_000)) fail("p on a selected message opened no card with a local time");
    },
  },
  {
    name: "chat people: at phone width the name stays whole and the icons and the row's actions stay inside the row",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      try {
        await frames(cdp, 12);
        for (const username of ["deskbot", "marlow", "quill"]) {
          // Under the pointer, where Team and Pro show and the actions with them.
          await pointAtName(cdp, username);
          const name = await nameOf(cdp, username) ?? fail(`no name ${username} drawn at phone width`);
          const clipped = name.icons.filter((icon) => !icon.visible);
          if (clipped.length > 0) fail(`${username}'s icons run past the row at phone width`, name.icons);
          if (!name.actionsInRow) fail(`${username}'s icons push the row's actions out of it at phone width`, name.icons);
          if (!name.nameWhole) fail(`${username}'s name is cut at phone width`, name);
        }
      } finally {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
      }
    },
  },
  {
    name: "chat list: a message a notification opened on is marked in view, then goes back to normal",
    scenario: `chat&target=${OPENED_ON}`,
    async run(cdp) {
      await openOnTarget(cdp);
      const inView = await evaluate<boolean>(cdp, `(() => { const s = __chat.scroller().getBoundingClientRect(); const r = __chat.rowRect(${JSON.stringify(OPENED_ON)}); return !!r && r.y >= s.top && r.y + r.height <= s.bottom; })()`);
      if (!inView) fail("the message the notification pointed at is not in view");
      expectMarked(await marked(cdp), [OPENED_ON], "just opened");
      // About two seconds, with time to spare for a busy machine.
      await pause(cdp, 3_200);
      expectMarked(await marked(cdp), [], "after the highlight's time");
    },
  },
  {
    name: "chat list: the marked message goes back to normal on the first wheel turn",
    scenario: `chat&target=${OPENED_ON}`,
    async run(cdp) {
      await openOnTarget(cdp);
      expectMarked(await marked(cdp), [OPENED_ON], "just opened");
      await wheel(cdp, await listCentre(cdp), 60);
      // The pointer goes back out of the list, so a hover is not what is looked at.
      const away = await evaluate<Point>(cdp, "__chat.neighbour()");
      await mouse(cdp, "mouseMoved", away.x, away.y, false);
      await frames(cdp, 3);
      expectMarked(await marked(cdp), [], "after a wheel turn");
    },
  },
  {
    name: "chat list: the marked message goes back to normal on a key press",
    scenario: `chat&target=${OPENED_ON}`,
    async run(cdp) {
      await openOnTarget(cdp);
      expectMarked(await marked(cdp), [OPENED_ON], "just opened");
      await pressKey(cdp, "x", "KeyX", "x");
      expectMarked(await marked(cdp), [], "after a key press");
    },
  },
  {
    name: "chat list: the marked message goes back to normal on a click",
    scenario: `chat&target=${OPENED_ON}`,
    async run(cdp) {
      await openOnTarget(cdp);
      expectMarked(await marked(cdp), [OPENED_ON], "just opened");
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      expectMarked(await marked(cdp), [], "after a click");
    },
  },
  {
    name: "chat list: the marked message goes back to normal when a message arrives, and the view stays",
    scenario: `chat&target=${OPENED_ON}`,
    async run(cdp) {
      await openOnTarget(cdp);
      const before = await anchor(cdp);
      await evaluate(cdp, "window.__chatFake.deliver('Something new while the highlight is up.')");
      await frames(cdp, 4);
      expectMarked(await marked(cdp), [], "after a new message");
      expectPlace(before, await anchor(cdp), "a new message");
    },
  },
  {
    // The selection the message used to get was re-revealed on every new message.
    name: "chat list: a new message does not pull a reader who scrolled on from a notification message back to it",
    scenario: `chat&target=${OPENED_ON}`,
    async run(cdp) {
      await openOnTarget(cdp);
      await wheel(cdp, await listCentre(cdp), 380);
      const before = await anchor(cdp);
      await evaluate(cdp, "window.__chatFake.deliver('Something new while reading elsewhere.')");
      await frames(cdp, 5);
      expectPlace(before, await anchor(cdp), "a new message");
    },
  },
  {
    name: "chat list: a notification message at the bottom still follows new messages",
    scenario: "chat&target=m89",
    async run(cdp) {
      await openOnTarget(cdp);
      await evaluate(cdp, "window.__chatFake.deliver('Right after the one the notification pointed at.')");
      await frames(cdp, 4);
      const after = await state(cdp);
      if (after.fromBottom > 4) fail("a new message did not scroll into view for a reader at the bottom", after);
    },
  },
  {
    name: "chat list: a row under the pointer shows its Reply button, and loses it when the pointer leaves the pane",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      const id = await visibleRow(cdp);
      await hoverRow(cdp, id);
      expectMarked(await marked(cdp), [id], "pointer on a row");
      const away = await evaluate<Point>(cdp, "__chat.neighbour()");
      await mouse(cdp, "mouseMoved", away.x, away.y, false);
      await frames(cdp, 3);
      expectMarked(await marked(cdp), [], "pointer in the next pane");
    },
  },
  {
    name: "chat list: the row under a pointer that stays still is let go when the list scrolls, and one row is marked again on the next move",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      const id = await visibleRow(cdp);
      const at = await hoverRow(cdp, id);
      expectMarked(await marked(cdp), [id], "pointer on a row");
      await turnWheel(cdp, at, -120);
      // Time for the browser's own after-scroll hover update, if it sends one.
      await pause(cdp, 400);
      expectMarked(await marked(cdp), [], "the list scrolled under a still pointer");
      await mouse(cdp, "mouseMoved", at.x + 3, at.y + 2, false);
      await frames(cdp, 3);
      const after = await marked(cdp);
      if (after.length !== 1) fail("one row should be marked after the pointer moved again", after);
    },
  },
  {
    name: "chat list: the row under a pointer that stays still is let go when a message arrives",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      const id = await visibleRow(cdp);
      await hoverRow(cdp, id);
      expectMarked(await marked(cdp), [id], "pointer on a row");
      await evaluate(cdp, "window.__chatFake.deliver('Arrives under the pointer.')");
      await pause(cdp, 300);
      expectMarked(await marked(cdp), [], "a message arrived");
    },
  },
  {
    name: "chat list: the row under the pointer is let go when the window loses focus or a key is pressed",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      const id = await visibleRow(cdp);
      await hoverRow(cdp, id);
      expectMarked(await marked(cdp), [id], "pointer on a row");
      await evaluate(cdp, "window.dispatchEvent(new Event('blur'))");
      await frames(cdp, 3);
      expectMarked(await marked(cdp), [], "the window lost focus");
      await hoverRow(cdp, await visibleRow(cdp, 5));
      expectMarked(await marked(cdp), [await visibleRow(cdp, 5)], "pointer on another row");
      await pressKey(cdp, "x", "KeyX", "x");
      expectMarked(await marked(cdp), [], "a key was pressed");
    },
  },
  {
    name: "chat list: a message that arrives behind a reader who scrolled back leaves the view alone and shows a control that goes to it",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -600);
      const before = await anchor(cdp);
      await evaluate(cdp, "window.__chatFake.deliver('First while reading back.')");
      await evaluate(cdp, "window.__chatFake.deliver('Second while reading back.')");
      await frames(cdp, 5);
      expectPlace(before, await anchor(cdp), "two new messages");
      const jump = await evaluate<{ text: string; x: number; y: number } | null>(cdp, "__chat.jump()");
      if (!jump || !/2 new messages/.test(jump.text)) fail("no control offering the 2 new messages", jump);
      await click(cdp, jump);
      if (!await waitFor(cdp, "__chat.state().fromBottom <= 4", 2_000)) fail("the control did not take the reader to the newest message", await state(cdp));
      if (await evaluate(cdp, "__chat.jump()")) fail("the control stayed after the reader reached the bottom");
    },
  },
  {
    name: "chat list: the control goes when the reader scrolls to the bottom themselves",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      const centre = await listCentre(cdp);
      await wheel(cdp, centre, -300);
      await evaluate(cdp, "window.__chatFake.deliver('One while reading back.')");
      await frames(cdp, 4);
      if (!await evaluate(cdp, "__chat.jump()")) fail("no control after a message arrived behind the reader");
      await wheel(cdp, centre, 2_000);
      await pause(cdp, 300);
      if (await evaluate(cdp, "__chat.jump()")) fail("the control stayed after the reader reached the bottom by scrolling", await state(cdp));
    },
  },
  {
    name: "chat list: a reader at, or a few pixels from, the bottom follows a new message",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await evaluate(cdp, "window.__chatFake.deliver('A new message for a reader at the bottom.')");
      await frames(cdp, 4);
      const atBottom = await state(cdp);
      if (atBottom.fromBottom > 4) fail("the list did not follow a new message from the bottom", atBottom);
      await wheel(cdp, await listCentre(cdp), -3);
      const near = await state(cdp);
      if (near.fromBottom < 1 || near.fromBottom > 4) fail("the wheel did not leave the reader a few pixels short of the bottom", near);
      await evaluate(cdp, "window.__chatFake.deliver('A new message for a reader a few pixels short.')");
      await frames(cdp, 4);
      const after = await state(cdp);
      if (after.fromBottom > 4) fail("the list did not follow a new message for a reader a few pixels short of the bottom", after);
      if (await evaluate(cdp, "__chat.jump()")) fail("a control was offered to a reader who was following");
    },
  },
  {
    name: "chat list: a reader at the bottom stays there when the last message grows later, as an image loading would make it",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await evaluate(cdp, `window.__chatFake.update('m89', (m) => ({ ...m, content: m.content + '\\n' + 'a late addition '.repeat(40) }))`);
      await frames(cdp, 4);
      const after = await state(cdp);
      if (after.fromBottom > 4) fail("the list did not keep the bottom in view as the last message grew", after);
    },
  },
  {
    name: "chat list: a message changing above the view does not move the reader, with no help from the browser",
    scenario: "chat&anchoring=off",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -400);
      const before = await anchor(cdp);
      await evaluate(cdp, `window.__chatFake.update('m41', (m) => ({ ...m, content: m.content + ' and more words that make this one wrap onto further lines than it did'.repeat(3), editedAt: '2026-01-06T00:00:00.000Z' }))`);
      await frames(cdp, 4);
      expectPlace(before, await anchor(cdp), "a message above the view growing");
    },
  },
  {
    name: "chat list: older messages arriving above keep the reader on the same message, even if they scrolled while waiting",
    scenario: "chat&anchoring=off",
    async run(cdp) {
      await ready(cdp);
      await evaluate(cdp, "window.__chatFake.holdHistory()");
      await wheel(cdp, await listCentre(cdp), -5_000);
      if (!await waitFor(cdp, "window.__chatFake.historyRequests >= 1", 2_000)) fail("reaching the top did not ask for older messages", await state(cdp));
      // Reading on while the page is on its way.
      await wheel(cdp, await listCentre(cdp), 130);
      const before = await anchor(cdp);
      const heightBefore = (await state(cdp)).height;
      await evaluate(cdp, "window.__chatFake.release()");
      if (!await waitFor(cdp, `__chat.state().height > ${heightBefore}`, 3_000)) fail("the older messages never arrived");
      await frames(cdp, 6);
      expectPlace(before, await anchor(cdp), "older messages arriving");
    },
  },
  {
    // The oldest message was selected when older ones arrived, with a nudge of the wheel and no key
    // pressed: its band and Reply button stayed until Esc, which no mouse reader presses.
    name: "chat list: older messages arriving select no message",
    scenario: "chat&latency=200",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -5_000);
      if (!await waitFor(cdp, "window.__chatFake.historyRequests >= 1", 2_000)) fail("reaching the top did not ask for older messages", await state(cdp));
      if (!await waitFor(cdp, "__chat.state().top > 500", 3_000)) fail("the older messages never arrived above the reader");
      await pause(cdp, 300);
      const chosen = await selected(cdp);
      if (chosen.length > 0) fail("older messages arriving selected a message nobody selected", chosen);
      // And with the pointer gone from the list, nothing in it stays marked.
      const away = await evaluate<Point>(cdp, "__chat.neighbour()");
      await mouse(cdp, "mouseMoved", away.x, away.y, false);
      await frames(cdp, 3);
      expectMarked(await marked(cdp), [], "pointer out of the list after older messages arrived");
    },
  },
  {
    name: "chat list: clicking into the composer does not move a reader who scrolled back",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -700);
      const before = await anchor(cdp);
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      expectPlace(before, await anchor(cdp), "clicking into the composer");
    },
  },
  {
    name: "chat list: a message of your own goes to the bottom, from wherever the reader was",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -900);
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await cdp.send("Input.insertText", { text: "Back at the bottom with this." });
      await pressKey(cdp, "Enter", "Enter", "\r");
      if (!await waitFor(cdp, "window.__chatFake.sent.length === 1", 3_000)) fail("the message was not sent");
      if (!await waitFor(cdp, "__chat.state().fromBottom <= 4", 2_000)) fail("a message of your own did not scroll into view", await state(cdp));
      if (await evaluate(cdp, "__chat.jump()")) fail("a control was offered for a message of your own");
    },
  },
  {
    name: "chat list: a growing composer keeps a reader at the bottom there",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await cdp.send("Input.insertText", { text: "one\ntwo\nthree\nfour" });
      await frames(cdp, 6);
      const after = await state(cdp);
      if (after.fromBottom > 4) fail("the list left the bottom when the composer grew", after);
    },
  },
  {
    name: "chat list: narrowing the pane to a stack keeps a reader who scrolled back on the same message",
    scenario: "chat",
    async run(cdp) {
      await ready(cdp);
      await wheel(cdp, await listCentre(cdp), -800);
      // A message starting at the top of the view: its own re-wrapping then moves nothing above it.
      await evaluate(cdp, `(() => { const s = __chat.scroller(); const top = s.getBoundingClientRect().top; s.scrollTop += __chat.rows().find((r) => r.getBoundingClientRect().top >= top + 40).getBoundingClientRect().top - top; })()`);
      await frames(cdp, 4);
      const before = await anchor(cdp);
      const divider = await evaluate<Point | null>(cdp, `(() => { const d = document.querySelector('[data-gloom-role=dock-divider]')?.getBoundingClientRect(); return d ? { x: d.x + d.width / 2, y: 300 } : null; })()`) ?? fail("no divider");
      const to = { x: 330, y: divider.y };
      await mouse(cdp, "mouseMoved", divider.x, divider.y, false);
      await mouse(cdp, "mousePressed", divider.x, divider.y, true);
      for (let step = 1; step <= 12; step += 1) {
        await mouse(cdp, "mouseMoved", divider.x + ((to.x - divider.x) * step) / 12, divider.y, true);
        await frames(cdp);
      }
      await mouse(cdp, "mouseReleased", to.x, to.y, false);
      await frames(cdp, 12);
      const width = await evaluate<number>(cdp, `document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="chat:a"]').getBoundingClientRect().width`);
      if (width > 400) fail("the pane did not narrow", { width });
      // The message the reader was on, wherever the narrower text put it.
      const offset = await evaluate<number | null>(cdp, `__chat.offsetOf(${JSON.stringify(before.id)})`);
      if (offset === null) fail("narrowing the pane took the message the reader was on out of the list", { before });
      expectPlace(before, { id: before.id, offset }, "narrowing the pane");
    },
  },
  {
    name: "chat resize: messages, reply quotes and wrapped text follow a divider drag to the pixel, and stay put when it lets go",
    scenario: "chat&replies=1",
    async run(cdp) {
      await ready(cdp);
      const rest = await evaluate<Edges>(cdp, "__chat.edges()");
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      // In and back out, ending between cells rather than where it started.
      const result = await resizeChat(cdp, divider, (t) => ({ x: divider.x - Math.sin(t * Math.PI * 0.8) * 230, y: divider.y }));
      expectFollowed(rest, result, "a divider drag");
      if (result.released.fromBottom > 4) fail("the list left the bottom", result.released);
    },
  },
  {
    name: "chat resize: messages, reply quotes and wrapped text follow a floating pane's corner to the pixel, and stay put when it lets go",
    scenario: "chat&replies=1&float=1",
    async run(cdp) {
      await ready(cdp);
      const rest = await evaluate<Edges>(cdp, "__chat.edges()");
      const grip = await gripPoint(cdp) ?? fail("no resize grip");
      const result = await resizeChat(cdp, grip, (t) => ({ x: grip.x - 181 * t, y: grip.y - 66 * t }));
      expectFollowed(rest, result, "a corner drag");
      if (result.released.fromBottom > 4) fail("the list left the bottom", result.released);
    },
  },
  {
    name: "chat resize: a reader who scrolled back stays on the message they are reading through a drag and its release",
    scenario: "chat&count=300&loaded=300&replies=1",
    async run(cdp) {
      await ready(cdp);
      await evaluate(cdp, `(() => { const s = __chat.scroller(); s.scrollTop = Math.round((s.scrollHeight - s.clientHeight) / 2); })()`);
      await frames(cdp, 6);
      const before = await anchor(cdp);
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      await mouse(cdp, "mouseMoved", divider.x, divider.y, false);
      await mouse(cdp, "mousePressed", divider.x, divider.y, true);
      for (let move = 1; move <= 30; move += 1) {
        await mouse(cdp, "mouseMoved", divider.x - move * 6, divider.y, true);
        await frames(cdp);
        if (move % 10 === 0) expectPlace(before, await anchor(cdp), `step ${move} of the drag`);
      }
      await mouse(cdp, "mouseReleased", divider.x - 180, divider.y, false);
      await frames(cdp, 8);
      await pause(cdp, 250);
      expectPlace(before, await anchor(cdp), "the release");
    },
  },
  {
    name: "chat resize: over 500 loaded messages, every row in view follows a drag, every row takes the new width on release, and the list keeps its bottom",
    scenario: "chat&count=500&loaded=500&replies=1",
    async run(cdp) {
      await ready(cdp);
      const rest = await evaluate<Edges>(cdp, "__chat.edges()");
      if (await evaluate<number>(cdp, "__chatFake.messages.length") !== 500) fail("the fixture did not load 500 messages");
      if (!await evaluate(cdp, "__chat.rowRect('m499')")) fail("the latest message is not mounted");
      const divider = await dividerPoint(cdp) ?? fail("no divider");
      const result = await resizeChat(cdp, divider, (t) => ({ x: divider.x - Math.sin(t * Math.PI * 0.8) * 230, y: divider.y }));
      expectFollowed(rest, result, "a divider drag over 500 messages");
      const behind = result.during.map((edges) => edges.fromBottom).filter((px) => px > 4);
      if (behind.length > 0) fail("the list left the bottom during the drag", behind);
      if (result.released.widths.length !== 1) fail("rows out of view kept another width after the release", result.released.widths);
      if (result.released.fromBottom > 4) fail("the list left the bottom", result.released);
    },
  },
  {
    name: "chat chips: a share link is a chip with the share's title and pane, and its row keeps its height while the share is read",
    scenario: "chat&chips=1&shares=held",
    async run(cdp) {
      await ready(cdp);
      if (!await waitFor(cdp, "window.__chatFake.shareReads >= 2", 3_000)) fail("the chips never asked for their shares");
      const rowsBefore = await Promise.all(Object.values(CHIP_ROWS).map((id) => evaluate<{ height: number }>(cdp, `__chat.rowRect(${JSON.stringify(id)})`)));
      const bare = await oneChip(cdp, CHIP_ROWS.bare);
      if (bare.link !== `share:${SHARES.bare}`) fail("the bare link's chip opens the wrong share", bare);
      // The link is the chip now: no bare address in the text, and a message that was only a link has no text row.
      if (await evaluate<string>(cdp, `__chat.bodyText(${JSON.stringify(CHIP_ROWS.bare)})`)) fail("a message that was only a share link still draws a text row");
      const postedText = await evaluate<string>(cdp, `__chat.bodyText(${JSON.stringify(CHIP_ROWS.posted)})`);
      if (postedText.includes("gloom.sh") || !postedText.includes("Chain for the week")) fail("the caption should stay and the share link should go", postedText);
      // A share posted with its picture shows the picture in the chip, not again below it.
      const posted = await oneChip(cdp, CHIP_ROWS.posted);
      if (!posted.picture) fail("the posted picture is not the chip's preview", posted);
      if (await evaluate<number>(cdp, `__chat.rows().find((r) => r.getAttribute('data-gloom-chat-message-id') === ${JSON.stringify(CHIP_ROWS.posted)}).querySelectorAll('[data-gloom-role=chat-message-image]').length`) !== 0) {
        fail("the posted picture is drawn twice");
      }
      const wire = await oneChip(cdp, CHIP_ROWS.wire);
      if (wire.link !== "economic-calendar" || !/Economic Calendar/.test(wire.text) || !/Jan 8/.test(wire.text)) fail("the Wire post's chip does not name its calendar and day", wire);

      await evaluate(cdp, "window.__chatFake.releaseShares()");
      if (!await waitFor(cdp, `__chat.chips(${JSON.stringify(CHIP_ROWS.bare)})[0]?.text.includes("DES SAMPL Options")`, 3_000)) fail("the chip never showed the share's title", await chips(cdp, CHIP_ROWS.bare));
      await frames(cdp, 4);
      const readChip = await oneChip(cdp, CHIP_ROWS.bare);
      if (!readChip.text.includes("Research")) fail("the chip does not say which pane the share holds", readChip);
      const rowsAfter = await Promise.all(Object.values(CHIP_ROWS).map((id) => evaluate<{ height: number }>(cdp, `__chat.rowRect(${JSON.stringify(id)})`)));
      rowsBefore.forEach((before, index) => {
        if (Math.abs(before.height - rowsAfter[index]!.height) > 0.5) fail("a chip's row changed height when its share was read", { before, after: rowsAfter[index] });
      });
      const after = await state(cdp);
      if (after.fromBottom > 4) fail("reading the shares moved a reader at the bottom", after);
    },
  },
  {
    name: "chat chips: a click on a share chip opens the shared pane and a Wire post's chip opens its calendar, without selecting the row",
    scenario: "chat&chips=1",
    async run(cdp) {
      await ready(cdp);
      await click(cdp, await oneChip(cdp, CHIP_ROWS.bare));
      if (!await waitFor(cdp, `window.__chatFake.opened.includes("share:${SHARES.bare}")`, 2_000)) fail("a click on the chip did not open its share", await evaluate(cdp, "window.__chatFake.opened"));
      await click(cdp, await oneChip(cdp, CHIP_ROWS.posted));
      if (!await waitFor(cdp, `window.__chatFake.opened.includes("share:${SHARES.posted}")`, 2_000)) fail("a click on the picture chip did not open its share", await evaluate(cdp, "window.__chatFake.opened"));
      await click(cdp, await oneChip(cdp, CHIP_ROWS.wire));
      if (!await waitFor(cdp, `window.__chatFake.opened.includes("template:econ-calendar-pane")`, 2_000)) fail("a click on the Wire chip did not open its calendar", await evaluate(cdp, "window.__chatFake.opened"));
      const chosen = await selected(cdp);
      if (chosen.length > 0) fail("a click on a chip selected its message", chosen);
      if (await evaluate<number>(cdp, "document.querySelectorAll('[data-gloom-role=chat-image-lightbox]').length") !== 0) fail("a click on the picture chip opened the image viewer instead");
    },
  },
  {
    name: "chat chips: the keyboard opens the chip of the selected message",
    scenario: "chat&chips=1",
    async run(cdp) {
      await ready(cdp);
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await pressKey(cdp, "Escape", "Escape");
      await pressKey(cdp, "k", "KeyK", "k");
      const chosen = await selected(cdp);
      if (chosen.join() !== CHIP_ROWS.bare) fail("k did not select the newest message", chosen);
      await pressKey(cdp, "o", "KeyO", "o");
      if (!await waitFor(cdp, `window.__chatFake.opened.includes("share:${SHARES.bare}")`, 2_000)) fail("o did not open the selected message's chip", await evaluate(cdp, "window.__chatFake.opened"));
    },
  },
  {
    name: "chat chips: a news post that still ends in the publisher's address draws no address, and its chip opens the story in Gloom",
    scenario: "chat&chips=1",
    async run(cdp) {
      await ready(cdp);
      const row = JSON.stringify(LEGACY_NEWS.row);
      const text = await evaluate<string>(cdp, `__chat.rowText(${row})`);
      if (!text.includes("Sample Corp expands packaging deal")) fail("the news post lost its headline", text);
      if (text.includes(LEGACY_NEWS.address) || text.includes("https://")) fail("the news post still draws the publisher's address", text);
      const chip = await oneChip(cdp, LEGACY_NEWS.row);
      if (chip.link !== "news-story" || !/Story/.test(chip.text)) fail("the news post's chip does not name the story", chip);
      await click(cdp, chip);
      if (!await waitFor(cdp, `window.__chatFake.opened.includes("template:news-story-pane:${LEGACY_NEWS.story}")`, 2_000)) {
        fail("a click on the chip did not open the story in Gloom", await evaluate(cdp, "window.__chatFake.opened"));
      }
      const outside = await evaluate<string[]>(cdp, "window.__paneChrome.externalOpens");
      if (outside.length > 0) fail("a click on the chip opened a page outside Gloom", outside);
      const chosen = await selected(cdp);
      if (chosen.length > 0) fail("a click on a chip selected its message", chosen);
    },
  },
  {
    name: "chat chips: o on that news post opens the story at once, with no publisher address to choose",
    scenario: "chat&chips=1",
    async run(cdp) {
      await ready(cdp);
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await pressKey(cdp, "Escape", "Escape");
      // Newest first: the bare share, the posted share, the calendar post, then the news post.
      for (let step = 0; step < 4; step += 1) await pressKey(cdp, "k", "KeyK", "k");
      const chosen = await selected(cdp);
      if (chosen.join() !== LEGACY_NEWS.row) fail("k did not reach the news post", chosen);
      await pressKey(cdp, "o", "KeyO", "o");
      if (!await waitFor(cdp, `window.__chatFake.opened.includes("template:news-story-pane:${LEGACY_NEWS.story}")`, 2_000)) {
        fail("o did not open the story: it asked which of several targets instead", await evaluate(cdp, "document.body.innerText.slice(-400)"));
      }
      const outside = await evaluate<string[]>(cdp, "window.__paneChrome.externalOpens");
      if (outside.length > 0) fail("o opened a page outside Gloom", outside);
      if (await evaluate<boolean>(cdp, `document.body.innerText.includes(${JSON.stringify(LEGACY_NEWS.address)})`)) fail("the publisher's address is still on screen");
    },
  },
  {
    name: "chat handle: the first-chat prompt keeps a refused handle in its field, gives the chat its keys back when the pointer leaves, and saves into the composer with the draft kept",
    scenario: "chat&handle=placeholder&latency=50",
    async run(cdp) {
      await ready(cdp);
      await click(cdp, await evaluate<Point>(cdp, "__chat.composer()"));
      await cdp.send("Input.insertText", { text: "draft stays" });
      await pressKey(cdp, "Escape", "Escape");
      const field = await handleField(cdp) ?? fail("no handle prompt for an account on its signup placeholder");
      await click(cdp, field);
      await cdp.send("Input.insertText", { text: "taken" });
      await pressKey(cdp, "Enter", "Enter", "\r");
      if (!await waitFor(cdp, "document.querySelector('[data-gloom-role=chat-handle-prompt]')?.textContent.includes('is taken')", 3_000)) fail("a taken handle did not say so", await handleField(cdp));
      const refused = await handleField(cdp);
      if (!refused?.focused || refused.value !== "taken") fail("a refused handle left its field", refused);
      // A click on a message takes the keyboard back to the chat.
      await click(cdp, await listCentre(cdp));
      await pressKey(cdp, "k", "KeyK", "k");
      if ((await selected(cdp)).length !== 1) fail("after a click away from the field, k selected no message", await handleField(cdp));
      // The reason under the field moved it up.
      await click(cdp, await handleField(cdp) ?? fail("the handle prompt went away after a click outside it"));
      await backspace(cdp, 5);
      await cdp.send("Input.insertText", { text: "vince" });
      await pressKey(cdp, "Enter", "Enter", "\r");
      if (!await waitFor(cdp, "!document.querySelector('[data-gloom-role=chat-handle-prompt]')", 3_000)) fail("a free handle did not save", await handleField(cdp));
      const composer = await evaluate<{ focused: boolean; value: string }>(cdp, "(() => { const t = document.querySelector('textarea'); return { focused: document.activeElement === t, value: t?.value ?? '' }; })()");
      if (!composer.focused || composer.value !== "draft stays") fail("saving from the field did not hand the keyboard to the composer with its draft", composer);
    },
  },
];
