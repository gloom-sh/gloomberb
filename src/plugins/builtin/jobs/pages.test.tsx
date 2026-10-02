import { expect, test } from "bun:test";
import { act, useEffect, useRef, useSyncExternalStore } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import { useAppendedPages } from "./pages";

const tui = createOpenTuiTestHarness();

async function frames(count = 4) {
  for (let index = 0; index < count; index++) {
    await act(async () => { await Bun.sleep(5); await tui.setup().renderOnce(); });
  }
}

interface Scene {
  requestKey: string;
  firstCount: number;
  total: number;
  /** Each bump stands in for the reader scrolling to the end once. */
  pulls: number;
}

/** A tiny store so a test can change the hook's inputs without a rerender API. */
function createScene(initial: Scene) {
  let scene = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => scene,
    set: (next: Partial<Scene>) => {
      scene = { ...scene, ...next };
      for (const listener of listeners) listener();
    },
  };
}

function Harness({ store, loadPage }: { store: ReturnType<typeof createScene>; loadPage: (offset: number) => Promise<string[]> }) {
  const scene = useSyncExternalStore(store.subscribe, store.get);
  const { items, hasMore, loadingMore, loadMore } = useAppendedPages(scene.requestKey, scene.firstCount, scene.total, loadPage);
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  useEffect(() => { if (scene.pulls > 0) loadMoreRef.current(); }, [scene.pulls]);
  return <Text>{`items=${items.length} more=${hasMore} loading=${loadingMore}`}</Text>;
}

async function mount(store: ReturnType<typeof createScene>, loadPage: (offset: number) => Promise<string[]>) {
  await act(async () => {
    await tui.render(<Harness store={store} loadPage={loadPage} />, { width: 60, height: 2 });
  });
  await frames();
}

async function pull(store: ReturnType<typeof createScene>) {
  await act(async () => { store.set({ pulls: store.get().pulls + 1 }); });
  await frames();
}

test("pages append from the first response's end and stop at the total", async () => {
  const offsets: number[] = [];
  const loadPage = async (offset: number) => {
    offsets.push(offset);
    return Array.from({ length: Math.min(2, 5 - offset) }, (_, index) => `row-${offset + index}`);
  };
  const store = createScene({ requestKey: "a", firstCount: 3, total: 5, pulls: 0 });
  await mount(store, loadPage);
  expect(tui.frame()).toContain("items=0 more=true");

  await pull(store);
  expect(offsets).toEqual([3]);
  expect(tui.frame()).toContain("items=2 more=false");

  // Nothing left to ask for, so another pull is a no-op.
  await pull(store);
  expect(offsets).toEqual([3]);
});

test("a new first response drops the pages appended to the old one", async () => {
  const loadPage = async (offset: number) => [`row-${offset}`];
  const store = createScene({ requestKey: "a", firstCount: 1, total: 10, pulls: 0 });
  await mount(store, loadPage);
  await pull(store);
  expect(tui.frame()).toContain("items=1 more=true");

  await act(async () => { store.set({ requestKey: "b" }); });
  await frames();
  expect(tui.frame()).toContain("items=0 more=true");
});

test("an empty page ends the list even when the total says otherwise", async () => {
  const loadPage = async () => [];
  const store = createScene({ requestKey: "a", firstCount: 1, total: 10, pulls: 0 });
  await mount(store, loadPage);
  await pull(store);
  expect(tui.frame()).toContain("items=0 more=false");
});
