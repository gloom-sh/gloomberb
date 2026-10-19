import { describe, expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { MarketBoardStack, type MarketBoardRow } from "./index";

const tui = createOpenTuiTestHarness();
const store = createStaticAppStore(createInitialState(createDefaultConfig("/tmp/gloomberb-market-board")));

function row(id: string, status: MarketBoardRow["status"]): MarketBoardRow {
  return {
    id, label: id, value: 4.1, valueText: "4.10", change: 0.1, changeText: "+0.10", percentile: 50, asOf: "2026-10-09", history: [], status,
  };
}

async function board(width: number, rows: MarketBoardRow[]) {
  await tui.render(
    <AppContext value={store}>
      <MarketBoardStack rows={rows} width={width} height={8} focused selectedId={null} onSelectedIdChange={() => {}}
        openId={null} onOpenIdChange={() => {}} renderDetail={() => null} />
    </AppContext>,
    { width, height: 8 },
  );
  return tui.waitForFrameToContain("DGS");
}

describe("MarketBoardStack", () => {
  // A stale row, or a day still trading, carries its word beside its date, in a
  // column made wide enough for both, so a narrow board never cuts the date to fit the word.
  test("a stale or partial row reads its whole date and the word at wide and narrow widths", async () => {
    for (const width of [100, 64, 56]) {
      const frame = await board(width, [row("DGS2", "stale"), row("DGS10", "available")]);
      expect(frame).toMatch(/(2026-)?10-09 stale/);
      expect(frame).not.toContain("…");
      const partial = await board(width, [row("DGS2", "partial"), row("DGS10", "available")]);
      expect(partial).toMatch(/(2026-)?10-09 so far/);
      expect(partial).not.toContain("…");
    }
    const fresh = await board(100, [row("DGS2", "available")]);
    expect(fresh).toContain("2026-10-09");
    expect(fresh).not.toContain("stale");
  });
});
