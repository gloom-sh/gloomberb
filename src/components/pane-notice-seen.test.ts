import { beforeEach, expect, test } from "bun:test";
import {
  arePaneNoticesSeen,
  attachSeenPaneNotices,
  markPaneNoticesSeen,
  resetSeenPaneNoticesForTest,
  SEEN_PANE_NOTICE_LIMIT,
} from "./pane-notice-seen";

beforeEach(resetSeenPaneNoticesForTest);

function fakeState(initial: unknown = undefined) {
  const rows = new Map<string, unknown>(initial === undefined ? [] : [["core.pane-notices:seen", initial]]);
  const writes: unknown[] = [];
  return {
    rows,
    writes,
    state: {
      get: <T,>(owner: string, key: string) => rows.has(`${owner}:${key}`) ? { value: rows.get(`${owner}:${key}`) as T, schemaVersion: 1, updatedAt: 0 } : null,
      set: (owner: string, key: string, value: unknown) => { rows.set(`${owner}:${key}`, value); writes.push(value); },
    },
  };
}

test("a warning counts as opened by its text, and a changed or added one does not", () => {
  markPaneNoticesSeen(["  Volume unit unknown: BTC-USD Close. "]);
  expect(arePaneNoticesSeen(["Volume unit unknown: BTC-USD Close."])).toBe(true);
  expect(arePaneNoticesSeen(["Volume unit unknown: ETH-USD Close."])).toBe(false);
  expect(arePaneNoticesSeen(["Volume unit unknown: BTC-USD Close.", "Quote is delayed."])).toBe(false);
  expect(arePaneNoticesSeen([])).toBe(false);
});

test("the set survives a restart, holds no warning text, and is rewritten only with what it gained", () => {
  const first = fakeState();
  const detach = attachSeenPaneNotices(first.state);
  markPaneNoticesSeen(["AAPL: publication dates unavailable."]);
  detach();
  const [saved] = first.writes.slice(-1) as [string[]];
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatch(/^[0-9a-f]{16}$/);

  resetSeenPaneNoticesForTest();
  const second = fakeState(saved);
  attachSeenPaneNotices(second.state);
  expect(arePaneNoticesSeen(["AAPL: publication dates unavailable."])).toBe(true);
  expect(second.writes).toEqual([]);
});

test("warnings opened before the store attached are kept with the stored ones", () => {
  const stored = fakeState();
  attachSeenPaneNotices(stored.state);
  markPaneNoticesSeen(["Old warning."]);
  resetSeenPaneNoticesForTest();
  const later = fakeState(stored.writes.at(-1));
  markPaneNoticesSeen(["Early warning."]);
  attachSeenPaneNotices(later.state);
  expect(arePaneNoticesSeen(["Old warning.", "Early warning."])).toBe(true);
  expect(later.writes).toHaveLength(1);
});

test("the oldest warnings are forgotten past the limit, and one opened again stays", () => {
  const stored = fakeState();
  attachSeenPaneNotices(stored.state);
  markPaneNoticesSeen(["first"]);
  for (let index = 0; index < SEEN_PANE_NOTICE_LIMIT - 1; index += 1) markPaneNoticesSeen([`warning ${index}`]);
  expect(stored.writes.at(-1)).toHaveLength(SEEN_PANE_NOTICE_LIMIT);
  markPaneNoticesSeen(["first"]);
  markPaneNoticesSeen(["one more"]);
  expect(stored.writes.at(-1)).toHaveLength(SEEN_PANE_NOTICE_LIMIT);
  expect(arePaneNoticesSeen(["first"])).toBe(true);
  expect(arePaneNoticesSeen(["warning 0"])).toBe(false);
  expect(arePaneNoticesSeen(["warning 1", "one more"])).toBe(true);
});

test("unreadable stored rows are ignored, and a failed read never overwrites what is stored", () => {
  const junk = fakeState(["not-an-id", 7, null, "0123456789abcdef"]);
  attachSeenPaneNotices(junk.state);
  expect(junk.writes).toEqual([]);
  markPaneNoticesSeen(["Fresh warning."]);
  expect((junk.writes.at(-1) as string[]).includes("0123456789abcdef")).toBe(true);

  resetSeenPaneNoticesForTest();
  const writes: unknown[] = [];
  attachSeenPaneNotices({
    get: () => { throw new Error("locked"); },
    set: (_owner, _key, value) => { writes.push(value); },
  });
  expect(writes).toEqual([]);
});
