import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import type { ScreenDefinition, ScreenPayload } from "../../../api-client/equity-screener";
import { DEFAULT_SCREEN } from "./model";
import { screenFixture } from "./test-fixture";
import { useScreenResults } from "./results";

const tui = createOpenTuiTestHarness();
async function settle(action?: () => void) { await act(async () => { action?.(); await tui.setup().renderOnce(); }); }
test("late pagination and refreshes cannot repopulate a changed query or account", async () => {
  const requests: Array<{ signal?: AbortSignal; definition: ScreenDefinition; resolve: (data: ScreenPayload) => void }> = [];
  const fetcher = (definition: ScreenDefinition, _cursor?: string | null, signal?: AbortSignal) => new Promise<ScreenPayload>(resolve => requests.push({ definition, signal, resolve }));
  let latest!: ReturnType<typeof useScreenResults>, changeDefinition!: (definition: ScreenDefinition) => void, changeSession!: (id: string) => void;
  function Harness() {
    const [definition, setDefinition] = useState(DEFAULT_SCREEN), [session, setSession] = useState("account-one");
    changeDefinition = setDefinition; changeSession = setSession;
    latest = useScreenResults(definition, session, fetcher);
    return <Text>{latest.data?.rows.map(row => row.symbol).join(",") ?? "pending"}</Text>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 50, height: 4 }); });
  const first = screenFixture(); first.nextCursor = "page-two";
  await settle(() => requests[0]!.resolve(first));
  expect(latest.data?.rows[0]?.symbol).toBe("AAPL");
  await settle(() => latest.loadMore());
  const oldPage = requests[1]!;
  await settle(() => changeDefinition({ ...DEFAULT_SCREEN, criteria: [] }));
  expect(oldPage.signal?.aborted).toBe(true);
  expect(latest.data).toBeNull();
  const late = screenFixture(); late.rows[0]!.symbol = "MSFT";
  await settle(() => oldPage.resolve(late));
  expect(latest.data).toBeNull();
  const current = screenFixture(); current.definition = requests[2]!.definition; current.rows[0]!.symbol = "NVDA";
  await settle(() => requests[2]!.resolve(current));
  expect(latest.data?.rows[0]?.symbol).toBe("NVDA");
  await settle(() => latest.load());
  const oldRefresh = requests[3]!;
  await settle(() => changeSession("account-two"));
  await settle(() => oldRefresh.resolve(current));
  expect(oldRefresh.signal?.aborted).toBe(true);
  expect(latest.data).toBeNull();
});

/** A screen of `count` rows in pages of `size`, as one snapshot serves them. */
function pagedScreen(snapshotId: string, count: number, size: number, cursor: string | null): ScreenPayload {
  const start = cursor ? Number(cursor) : 0;
  const page = screenFixture();
  page.snapshot!.id = snapshotId;
  page.universe.matched = count;
  page.rows = Array.from({ length: Math.min(size, count - start) }, (_, index) => ({ ...screenFixture().rows[0]!, symbol: `S${start + index}` }));
  page.nextCursor = start + size < count ? String(start + size) : null;
  return page;
}

test("a refresh swaps in the new snapshot's rows at the length the list had, and keeps the pages when the snapshot is the same", async () => {
  let snapshot = "one";
  const asked: Array<string | null> = [];
  const fetcher = async (_definition: ScreenDefinition, cursor?: string | null) => { asked.push(cursor ?? null); return pagedScreen(snapshot, 250, 100, cursor ?? null); };
  let latest!: ReturnType<typeof useScreenResults>;
  function Harness() {
    latest = useScreenResults(DEFAULT_SCREEN, "account", fetcher);
    return <Text>{latest.data?.rows.length ?? "pending"}</Text>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 50, height: 4 }); });
  await settle();
  await settle(() => latest.loadMore());
  await settle(() => latest.loadMore());
  expect(latest.data?.rows).toHaveLength(250);

  // The same snapshot: one request, and the loaded pages stay as they are.
  const loaded = latest.data;
  asked.length = 0;
  await settle(() => latest.load());
  expect(asked).toEqual([null]);
  expect(latest.data).toBe(loaded);

  // A new snapshot: its pages are read until the list is as long as it was, and replace the rows together.
  snapshot = "two";
  asked.length = 0;
  await settle(() => latest.load());
  expect(asked).toEqual([null, "100", "200"]);
  expect(latest.data?.snapshot?.id).toBe("two");
  expect(latest.data?.rows).toHaveLength(250);
  expect(latest.data?.nextCursor).toBeNull();
});

test("a refresh that fails halfway keeps the rows on screen", async () => {
  let snapshot = "one", failAt: string | null = null;
  const fetcher = async (_definition: ScreenDefinition, cursor?: string | null) => {
    if (cursor && cursor === failAt) throw new Error("Screen unavailable.");
    return pagedScreen(snapshot, 250, 100, cursor ?? null);
  };
  let latest!: ReturnType<typeof useScreenResults>;
  function Harness() {
    latest = useScreenResults(DEFAULT_SCREEN, "account", fetcher);
    return <Text>{latest.data?.rows.length ?? "pending"}</Text>;
  }
  await act(async () => { await tui.render(<Harness />, { width: 50, height: 4 }); });
  await settle();
  await settle(() => latest.loadMore());
  await settle(() => latest.loadMore());
  const loaded = latest.data;
  snapshot = "two"; failAt = "200";
  await settle(() => latest.load());
  expect(latest.data).toBe(loaded);
  expect(latest.error).toBe("Screen unavailable.");
  expect(latest.loading).toBe(false);
});
