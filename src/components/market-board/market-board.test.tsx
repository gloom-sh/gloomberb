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

// A narrow pane in a 100-column terminal showed a board of names alone (SOVR without its 5Y) or without AS OF (CBR):
// the value and its date are the last columns a board gives up.
test("a narrow board keeps the value and its date, giving up the change and the pane's own columns first", async () => {
  const extra = [{ column: { id: "ccy", label: "CCY 1M", width: 11, align: "right" as const }, sortValue: () => 0, renderCell: () => ({ text: "BRL -1.0%" }) }];
  for (const width of [44, 34]) {
    await tui.render(
      <AppContext value={store}>
        <MarketBoardStack rows={[row("DGS10", "available"), { ...row("Brazil long name", "available"), valueText: "1276.6bp" }]}
          width={width} height={8} focused selectedId={null} onSelectedIdChange={() => {}} labelWidth={18} valueLabel="5Y"
          extraColumns={extra} openId={null} onOpenIdChange={() => {}} renderDetail={() => null} />
      </AppContext>,
      { width, height: 8 },
    );
    const frame = await tui.waitForFrameToContain("DGS");
    expect(frame).toContain("5Y");
    expect(frame).toContain("1276.6bp");
    expect(frame).toContain("AS OF");
    expect(frame).toMatch(/(2026-)?10-09/);
  }
});
