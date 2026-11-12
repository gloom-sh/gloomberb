/** @jsxImportSource react */
import { afterEach, expect, jest, test } from "bun:test";
import { act, useState } from "react";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { PaneInstanceProvider } from "./app/context";
import { PANE_SESSION_GRACE_MS, resetPaneSessionsForTests, usePaneSession, usePaneSessionState } from "./pane-session";

const dom = createDomTestHarness({ withUi: false });
afterEach(() => {
  resetPaneSessionsForTests();
});

interface Seen {
  session: { id: number } | null;
  setDraft: (value: string) => void;
}

/** A pane drawn in the dock or in a floating window: the two are different places in the tree, so each mounts the pane's view anew. */
function mountedPane() {
  const seen: Seen = { session: null, setDraft: () => {} };
  const disposed: number[] = [];
  let created = 0;
  let place: (place: "dock" | "float" | "closed") => void = () => {};
  function View() {
    const session = usePaneSession("test:session", () => ({ id: ++created }), (value) => { disposed.push(value.id); });
    const [draft, setDraft] = usePaneSessionState("test:draft", "");
    seen.session = session;
    seen.setDraft = setDraft;
    return <span data-testid="draft">{draft}</span>;
  }
  function Host() {
    const [where, setWhere] = useState<"dock" | "float" | "closed">("dock");
    place = setWhere;
    if (where === "closed") return null;
    return (
      <div key={where}>
        <PaneInstanceProvider paneId="pane-a"><View /></PaneInstanceProvider>
      </div>
    );
  }
  return {
    seen,
    disposed,
    created: () => created,
    render: () => dom.render(<Host />),
    place: (next: "dock" | "float" | "closed") => act(async () => { place(next); }),
  };
}

test("a pane's session and state stay the same across a dock change, and a setter from the view it left still lands", async () => {
  const pane = mountedPane();
  const container = await pane.render();
  const first = pane.seen.session;
  const setFromFirstView = pane.seen.setDraft;
  await act(async () => { pane.seen.setDraft("and AMD?"); });

  await pane.place("float");
  expect(pane.seen.session).toBe(first);
  expect(pane.created()).toBe(1);
  // The new view's first frame already holds what the old one had.
  expect(container.textContent).toBe("and AMD?");

  await act(async () => { setFromFirstView("and TSLA?"); });
  expect(container.textContent).toBe("and TSLA?");
  expect(pane.disposed).toEqual([]);
});

test("a pane's session is released once the pane has had no view for the grace period, not before", async () => {
  const pane = mountedPane();
  await pane.render();
  const first = pane.seen.session;
  jest.useFakeTimers();
  try {
    await pane.place("closed");
    await act(async () => { jest.advanceTimersByTime(PANE_SESSION_GRACE_MS - 1); });
    expect(pane.disposed).toEqual([]);

    // A pane that comes back in time is the same pane.
    await pane.place("dock");
    await act(async () => { jest.advanceTimersByTime(PANE_SESSION_GRACE_MS * 2); });
    expect(pane.seen.session).toBe(first);
    expect(pane.disposed).toEqual([]);

    await pane.place("closed");
    await act(async () => { jest.advanceTimersByTime(PANE_SESSION_GRACE_MS); });
    expect(pane.disposed).toEqual([1]);

    await pane.place("dock");
    expect(pane.seen.session).not.toBe(first);
    expect(pane.created()).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});
