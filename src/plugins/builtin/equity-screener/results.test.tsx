import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { testRender } from "../../../renderers/opentui/test-utils";
import { Text } from "../../../ui";
import type { ScreenDefinition, ScreenPayload } from "../../../api-client/equity-screener";
import { DEFAULT_SCREEN } from "./model";
import { screenFixture } from "./test-fixture";
import { useScreenResults } from "./results";

let setup: Awaited<ReturnType<typeof testRender>> | undefined;
afterEach(async () => { if (setup) await act(async () => setup!.renderer.destroy()); setup = undefined; });
async function settle(action?: () => void) { await act(async () => { action?.(); await setup!.renderOnce(); }); }
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
  await act(async () => { setup = await testRender(<Harness />, { width: 50, height: 4 }); });
  const first = screenFixture(); first.nextCursor = "page-two";
  await settle(() => requests[0]!.resolve(first));
  expect(latest.data?.rows[0]?.symbol).toBe("AAPL");
  await settle(() => { void latest.loadMore(); });
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
  await settle(() => { void latest.load(); });
  const oldRefresh = requests[3]!;
  await settle(() => changeSession("account-two"));
  await settle(() => oldRefresh.resolve(current));
  expect(oldRefresh.signal?.aborted).toBe(true);
  expect(latest.data).toBeNull();
});
