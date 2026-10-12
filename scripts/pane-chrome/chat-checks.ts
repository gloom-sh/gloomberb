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
    return row ? row.parentElement : null;
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
  neighbour() {
    const r = document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="plain:a"]')?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
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

const OPENED_ON = "m60";

/** Opens on a message the way a notification does, with the pointer parked outside the list. */
async function openOnTarget(cdp: Cdp): Promise<void> {
  await ready(cdp);
  const away = await evaluate<Point>(cdp, "__chat.neighbour()");
  await mouse(cdp, "mouseMoved", away.x, away.y, false);
  await frames(cdp, 3);
}

export const chatSteps: ChatStep[] = [
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
      const rowsBefore = await evaluate<number>(cdp, "__chat.rows().length");
      await evaluate(cdp, "window.__chatFake.release()");
      if (!await waitFor(cdp, `__chat.rows().length > ${rowsBefore}`, 3_000)) fail("the older messages never arrived");
      await frames(cdp, 6);
      expectPlace(before, await anchor(cdp), "older messages arriving");
      // The reader pressed no key, so no message is selected (the oldest one used to be).
      const chosen = await selected(cdp);
      if (chosen.length > 0) fail("older messages arriving selected a message nobody selected", chosen);
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
];
