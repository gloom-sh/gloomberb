import { expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../../../../renderers/opentui/test-utils";
import { parsePositionsFile } from "../../../../portfolio/positions-import/parse";
import type { PositionsImportPlan } from "../../../../portfolio/positions-import/plan";
import { AppContext, createInitialState } from "../../../../state/app/context";
import { createTestTicker } from "../../../../test-support/ticker";
import { createDefaultConfig } from "../../../../types/config";
import { PositionsImportDialog, type PositionsImportTarget } from "./dialog";
import type { PositionSymbolLookup } from "./lookup";

const tui = createOpenTuiTestHarness();
const press = (event: TestKeyEvent) => tui.emitKeypress(event, { frames: 2, afterCommit: true });

test("the preview follows the target, and Import saves the plan shown", async () => {
  const file = parsePositionsFile("Symbol,Quantity,Avg Cost\nAAPL,10,150\nSPAXX**,500,\n");
  const aapl = createTestTicker("AAPL", "Apple Inc.", { exchange: "NASDAQ" });
  const held = createTestTicker("XOM", "Exxon Mobil", {
    exchange: "NYSE", portfolios: ["main"], positions: [{ portfolio: "main", shares: 5, avgCost: 100, currency: "USD", broker: "manual" }],
  });
  const lookup: PositionSymbolLookup = { resolutions: new Map([["AAPL", { ticker: aapl }]]), unsaved: new Set() };
  const commits: Array<{ plan: PositionsImportPlan; target: PositionsImportTarget }> = [];
  const answers: boolean[] = [];
  let answerLookup: (value: PositionSymbolLookup) => void = () => {};
  const looked = new Promise<PositionSymbolLookup>((resolve) => { answerLookup = resolve; });
  await tui.render(
    <AppContext value={{ state: createInitialState(createDefaultConfig("/tmp/gloomberb-positions-import-test")), dispatch: () => {} }}>
    <PositionsImportDialog
      dialogId="positions-import-test"
      resolve={(answer) => answers.push(answer)}
      dismiss={() => {}}
      preview={{
        file,
        source: "holdings.csv",
        newPortfolio: { id: "holdings", name: "holdings", currency: "USD" },
        existing: { portfolio: { id: "main", name: "Main", currency: "USD" }, holdings: [held] },
        initialTarget: "new",
        baseCurrency: "USD",
      }}
      lookUp={() => looked}
      commit={async (plan, _lookup, target) => { commits.push({ plan, target }); }}
    />
    </AppContext>,
    { width: 100, height: 32 },
  );

  await tui.waitForFrameToContain("Looking up 1 symbol...");
  await act(async () => { answerLookup(lookup); });
  await tui.waitForFrameToContain('Creates portfolio "holdings" with 1 position.');
  expect(tui.frame()).toContain("cash or money market");
  await press({ name: "right" });
  await tui.waitForFrameToContain('Adds 1 position to "Main".');
  await press({ name: "right" });
  await tui.waitForFrameToContain('Replaces the holdings of "Main" with 1 position, removing 1.');
  expect(tui.frame()).toContain("Removes XOM: not in the file.");

  await press({ name: "return" });
  expect(commits.map(({ plan, target }) => [target, plan.mode, plan.rows.map((row) => row.ticker.metadata.ticker), plan.removed.map((ticker) => ticker.metadata.ticker)]))
    .toEqual([["replace", "replace", ["AAPL"], ["XOM"]]]);
  expect(answers).toEqual([true]);
});
