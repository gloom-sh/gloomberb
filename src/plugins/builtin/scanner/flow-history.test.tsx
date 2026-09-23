import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ScannerFlowEvent, ScannerFlowHistoryPage, ScannerFlowHistoryQuery } from "../../../api-client";
import { testRender } from "../../../renderers/opentui/test-utils";
import { nextFlowCursor, useFlowHistory, type FlowHistoryLoader } from "./flow-history";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(() => {
  setup?.renderer.destroy();
  setup = undefined;
});

function print(id: string, at: number): ScannerFlowEvent {
  return {
    id, at, underlying: "NVDA", contract: "NVDA261218C00200000", right: "C", strike: 200,
    expiry: "2026-12-18", side: "ask", kind: "sweep", size: 100, price: 10, premium: 100_000,
    volume: 1_000, openInterest: 500, volOi: 2, iv: 0.5,
  };
}

type Probe = ReturnType<typeof useFlowHistory>;

async function mount(
  props: { query: ScannerFlowHistoryQuery; oldestLive: { at: number; id: string } | null },
  load: FlowHistoryLoader,
) {
  const ref: { current: Probe | null; setProps: ((next: typeof props) => void) | null } = {
    current: null,
    setProps: null,
  };
  function Harness() {
    const [current, setProps] = useState(props);
    ref.setProps = setProps;
    ref.current = useFlowHistory(current.query, current.oldestLive, true, load);
    return <text>{String(ref.current.events.length)}</text>;
  }
  setup = await testRender(<Harness />, { width: 20, height: 3 });
  await act(async () => {
    await setup!.renderOnce();
  });
  return {
    ref,
    rerender: async (next: typeof props) => {
      await act(async () => {
        ref.setProps!(next);
        await setup!.renderOnce();
      });
    },
    flush: async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await setup!.renderOnce();
      });
    },
  };
}

test("the first page starts under the oldest live print and later pages continue from the last", async () => {
  const requests: ScannerFlowHistoryQuery[] = [];
  const pages: ScannerFlowHistoryPage[] = [
    { events: [print("b", 900), print("a", 800)], hasMore: true },
    { events: [print("z", 700)], hasMore: false },
  ];
  const view = await mount(
    { query: { limit: 2, minPremium: 250_000 }, oldestLive: { at: 1_000, id: "live" } },
    async (query) => {
      requests.push(query);
      return pages.shift()!;
    },
  );

  await act(async () => view.ref.current!.loadMore());
  await view.flush();
  await act(async () => view.ref.current!.loadMore());
  await view.flush();
  // Nothing further once the server says the log is exhausted.
  await act(async () => view.ref.current!.loadMore());
  await view.flush();

  expect(requests).toEqual([
    { limit: 2, minPremium: 250_000, before: { at: 1_000, id: "live" } },
    { limit: 2, minPremium: 250_000, before: { at: 800, id: "a" } },
  ]);
  expect(view.ref.current!.events.map((event) => event.id)).toEqual(["b", "a", "z"]);
  expect(view.ref.current!.hasMore).toBe(false);
});

test("a filter change drops the pages and ignores the answer to the old query", async () => {
  let resolveOld: ((page: ScannerFlowHistoryPage) => void) | undefined;
  const view = await mount(
    { query: { limit: 2 }, oldestLive: null },
    (query) => query.right === "P"
      ? Promise.resolve({ events: [print("put", 500)], hasMore: false })
      : new Promise((resolve) => { resolveOld = resolve; }),
  );

  await act(async () => view.ref.current!.loadMore());
  await view.rerender({ query: { limit: 2, right: "P" }, oldestLive: null });
  expect(view.ref.current!.loading).toBe(false);

  await act(async () => resolveOld!({ events: [print("stale", 600)], hasMore: true }));
  await view.flush();
  expect(view.ref.current!.events).toEqual([]);

  await act(async () => view.ref.current!.loadMore());
  await view.flush();
  expect(view.ref.current!.events.map((event) => event.id)).toEqual(["put"]);
});

test("a failed page stops loading until retried", async () => {
  let fail = true;
  let calls = 0;
  const view = await mount({ query: { limit: 1 }, oldestLive: null }, async () => {
    calls += 1;
    if (fail) throw new Error("Cloud unavailable");
    return { events: [print("x", 1)], hasMore: false };
  });

  await act(async () => view.ref.current!.loadMore());
  await view.flush();
  expect(view.ref.current!.error).toBe("Cloud unavailable");
  await act(async () => view.ref.current!.loadMore());
  await view.flush();
  expect(calls).toBe(1);

  fail = false;
  await act(async () => view.ref.current!.retry());
  await view.flush();
  await act(async () => view.ref.current!.loadMore());
  await view.flush();
  expect(calls).toBe(2);
  expect(view.ref.current!.events.map((event) => event.id)).toEqual(["x"]);
});

test("with nothing live yet, the first page is the latest recorded prints", () => {
  expect(nextFlowCursor([], null)).toBeUndefined();
  expect(nextFlowCursor([print("p", 5)], { at: 9, id: "live" })).toEqual({ at: 5, id: "p" });
});
