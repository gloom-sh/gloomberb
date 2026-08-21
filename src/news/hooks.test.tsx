import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../renderers/opentui/test-utils";
import type { NewsService } from "./aggregator";
import { setSharedNewsService, useNewsArticles } from "./hooks";
import type { NewsQueryState } from "./types";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let rerenderHarness: (() => void) | null = null;

function NewsHookHarness() {
  const [renderCount, setRenderCount] = useState(0);
  rerenderHarness = () => setRenderCount((current) => current + 1);
  const state = useNewsArticles({ feed: "latest", limit: 20 });
  return <text>{state.phase}:{renderCount}</text>;
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => testSetup?.renderer.destroy());
    testSetup = undefined;
  }
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

  testSetup = await testRender(<NewsHookHarness />, { width: 20, height: 1 });
  await act(async () => testSetup?.renderOnce());

  expect(watchCount).toBe(1);
  expect(unwatchCount).toBe(0);

  await act(async () => {
    rerenderHarness?.();
    await Promise.resolve();
    await testSetup?.renderOnce();
  });
  expect(watchCount).toBe(1);

  await act(async () => testSetup?.renderer.destroy());
  testSetup = undefined;
  expect(unwatchCount).toBe(1);
});
