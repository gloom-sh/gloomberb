import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import type { NewsService } from "./aggregator";
import { setSharedNewsService, useNewsArticles } from "./hooks";
import type { NewsQueryState } from "./types";

const tui = createOpenTuiTestHarness();
let rerenderHarness: (() => void) | null = null;

function NewsHookHarness() {
  const [renderCount, setRenderCount] = useState(0);
  rerenderHarness = () => setRenderCount((current) => current + 1);
  const state = useNewsArticles({ feed: "latest", limit: 20 });
  return <text>{state.phase}:{renderCount}</text>;
}

afterEach(() => {
  rerenderHarness = null;
  setSharedNewsService(null);
});

test("useNewsArticles watches once and unwatches on unmount", async () => {
  let watchCount = 0;
  let unwatchCount = 0;
  const readyState: NewsQueryState = {
    phase: "ready",
    articles: [],
    error: null,
    updatedAt: 1,
    sourceIds: [],
    nextCursor: null,
    loadingMore: false,
  };
  const service = {
    getQueryState: () => readyState,
    watchQuery: () => {
      watchCount++;
      return () => {
        unwatchCount++;
      };
    },
  } as unknown as NewsService;
  setSharedNewsService(service);

  await tui.render(<NewsHookHarness />, { width: 20, height: 1 });
  await act(async () => tui.setup().renderOnce());

  expect(watchCount).toBe(1);
  expect(unwatchCount).toBe(0);

  await act(async () => {
    rerenderHarness?.();
    await Promise.resolve();
    await tui.setup().renderOnce();
  });
  expect(watchCount).toBe(1);

  await tui.destroy();
  expect(unwatchCount).toBe(1);
});
