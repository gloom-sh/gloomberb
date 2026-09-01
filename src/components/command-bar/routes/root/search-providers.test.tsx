import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../../../renderers/opentui/test-utils";
import type { CommandBarResultDef, CommandBarSearchProvider } from "../../../../types/plugin";
import type { ResultItem } from "../../list/model";
import { toProviderResultItem, useCommandBarSearchProviders } from "./search-providers";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;
let setHarnessQuery: ((query: string) => void) | null = null;
let latestItems: ResultItem[] = [];
let latestSearching = false;

function ProvidersHarness({
  providers,
  initialQuery,
}: {
  providers: CommandBarSearchProvider[];
  initialQuery: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  setHarnessQuery = setQuery;
  const { providerResultItems, providerSearching } = useCommandBarSearchProviders({
    providers,
    query,
    enabled: true,
    context: { activeTicker: null, activeCollectionId: null },
    onExecuted: () => {},
  });
  latestItems = providerResultItems;
  latestSearching = providerSearching;
  return <text>{String(providerResultItems.length)}</text>;
}

async function renderHarness(providers: CommandBarSearchProvider[], initialQuery = ""): Promise<void> {
  testSetup = await testRender(
    <ProvidersHarness providers={providers} initialQuery={initialQuery} />,
    { width: 20, height: 1 },
  );
  await act(async () => {
    await testSetup!.renderOnce();
  });
}

async function typeQuery(query: string): Promise<void> {
  await act(async () => {
    setHarnessQuery?.(query);
    await testSetup!.renderOnce();
  });
}

async function settle(ms = 20): Promise<void> {
  await act(async () => {
    await Bun.sleep(ms);
    await testSetup!.renderOnce();
  });
}

function makeResult(id: string): CommandBarResultDef {
  return { id, label: id, execute: () => {} };
}

afterEach(async () => {
  if (testSetup) {
    await act(async () => {
      testSetup!.renderer.destroy();
    });
    testSetup = undefined;
  }
  setHarnessQuery = null;
  latestItems = [];
  latestSearching = false;
});

describe("command bar search providers", () => {
  test("shows only the answer to the query still in the bar, and aborts the rest", async () => {
    const asked: string[] = [];
    const aborted: string[] = [];
    const provider: CommandBarSearchProvider = {
      id: "docs",
      category: "Documents",
      debounceMs: 0,
      async provide(query, _context, signal) {
        asked.push(query);
        signal.addEventListener("abort", () => aborted.push(query));
        // The slower first request would otherwise land on top of the newer one.
        await Bun.sleep(query === "margin" ? 40 : 0);
        return [makeResult(query)];
      },
    };

    await renderHarness([provider], "margin");
    await settle(5);
    await typeQuery("margin pressure");
    await settle(60);

    expect(asked).toEqual(["margin", "margin pressure"]);
    expect(aborted).toEqual(["margin"]);
    expect(latestItems.map((item) => item.label)).toEqual(["margin pressure"]);
  });

  test("does not ask again for a query it has already answered", async () => {
    let calls = 0;
    const provider: CommandBarSearchProvider = {
      id: "docs",
      category: "Documents",
      debounceMs: 0,
      async provide(query) {
        calls += 1;
        return [makeResult(query)];
      },
    };

    await renderHarness([provider], "margin");
    await settle();
    await typeQuery("margin pressure");
    await settle();
    await typeQuery("margin");
    await settle();

    expect(calls).toBe(2);
    expect(latestItems.map((item) => item.label)).toEqual(["margin"]);
  });

  test("contributes nothing when it fails, and stops reporting itself as loading", async () => {
    const provider: CommandBarSearchProvider = {
      id: "docs",
      category: "Documents",
      debounceMs: 0,
      async provide() {
        throw new Error("402");
      },
    };

    await renderHarness([provider], "margin");
    await settle();

    expect(latestItems).toEqual([]);
    expect(latestSearching).toBe(false);
  });

  test("stays quiet below the provider's minimum query length", async () => {
    let calls = 0;
    const provider: CommandBarSearchProvider = {
      id: "docs",
      category: "Documents",
      debounceMs: 0,
      minQueryLength: 4,
      async provide(query) {
        calls += 1;
        return [makeResult(query)];
      },
    };

    await renderHarness([provider], "mar");
    await settle();
    expect(calls).toBe(0);
    expect(latestSearching).toBe(false);

    await typeQuery("marg");
    await settle();
    expect(calls).toBe(1);
  });

  test("orders sections by provider priority", async () => {
    const provider = (id: string, priority: number): CommandBarSearchProvider => ({
      id,
      category: id,
      priority,
      debounceMs: 0,
      async provide() {
        return [makeResult(id)];
      },
    });

    await renderHarness([provider("late", 50), provider("early", 10)], "margin");
    await settle();

    expect(latestItems.map((item) => item.category)).toEqual(["early", "late"]);
  });
});

describe("toProviderResultItem", () => {
  test("namespaces the row, keeps its lines, and closes the bar after it runs", async () => {
    let executed = 0;
    let closed = 0;
    const item = toProviderResultItem(
      { id: "docs", category: "Documents", provide: async () => [] },
      {
        id: "hit-1",
        label: "Q3 call",
        detail: "CALL · Feb 02, 26",
        right: "AAPL",
        keywords: ["transcript"],
        lines: [{ segments: [{ text: "margin ", emphasis: "muted" }, { text: "pressure", emphasis: "match" }] }],
        execute: () => { executed += 1; },
      },
      () => { closed += 1; },
    );

    expect(item.id).toBe("search-provider:docs:hit-1");
    expect(item.category).toBe("Documents");
    expect(item.right).toBe("AAPL");
    expect(item.lines?.[0]?.segments[1]?.emphasis).toBe("match");
    expect(item.searchText).toContain("transcript");

    await item.action();
    expect(executed).toBe(1);
    expect(closed).toBe(1);
  });

  test("does not run or close for a disabled row", async () => {
    let executed = 0;
    let closed = 0;
    const item = toProviderResultItem(
      { id: "docs", category: "Documents", provide: async () => [] },
      { id: "gate", label: "Upgrade", disabled: true, execute: () => { executed += 1; } },
      () => { closed += 1; },
    );

    await item.action();
    expect(executed).toBe(0);
    expect(closed).toBe(0);
  });
});
