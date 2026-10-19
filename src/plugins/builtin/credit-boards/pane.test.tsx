import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { setCloudApiFetchTransport } from "../../../api-client";
import type { CdxBoardPayload, CreditBoardPoint, SovrBoardPayload } from "../../../api-client/credit-boards";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction } from "../../../state/app/context";
import { createTestPaneConfig, TestPaneFrame } from "../../../test-support/pane";
import { MemoryPluginPersistence } from "../../../test-support/plugin-persistence";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { FIXED_INCOME_PANE_ID } from "../fixed-income/model";
import { cdxBoardCache, sovrBoardCache } from "./client";
import { CdxPane } from "./cdx-pane";
import { SovrPane } from "./sovr-pane";

const points = (level: number): CreditBoardPoint[] => ["2026-10-07", "2026-10-08", "2026-10-09"]
  .map((date, step) => ({ date, level: level + step, prints: 100, maturity: "2031-12-20" }));

const cdx = { source: "DTCC PPD", asOf: "2026-10-10T00:00:00Z", tenor: "5Y", indexes: [
  { id: "IG", name: "CDX IG", quote: "spread", currency: "USD", couponBp: 100, date: "2026-10-09", maturity: "2031-12-20", level: 58, prints: 100, change1D: 1, change1W: 1, points: points(56) },
  { id: "HY", name: "CDX HY", quote: "price", currency: "USD", couponBp: 500, date: "2026-10-09", maturity: "2031-12-20", level: 106, prints: 100, change1D: 1, change1W: 1, points: points(104) },
  { id: "XOVER", name: "iTraxx Crossover", quote: "spread", currency: "EUR", couponBp: 500, date: "2026-10-09", maturity: "2031-12-20", level: 312, prints: 100, change1D: 1, change1W: 1, points: points(310) },
] } as CdxBoardPayload;

const sovereign = (id: string, name: string, currency: string, level: number) => (
  { id, name, currency, date: "2026-10-09", maturity: "2031-12-20", level, prints: 40, reported: 30, change1W: 1, change1M: 2, points: points(level - 2) }
);
const sovr: SovrBoardPayload = { source: "DTCC PPD", asOf: "2026-10-10T00:00:00Z", tenor: "5Y",
  sovereigns: [sovereign("AR", "Argentina", "ARS", 755), sovereign("CI", "Ivory Coast", "XOF", 246), sovereign("BR", "Brazil", "BRL", 119)] };

const tui = createOpenTuiTestHarness();
afterEach(() => {
  setCloudApiFetchTransport(null);
  cdxBoardCache.reset();
  sovrBoardCache.reset();
});

/** The row the board's history is drawn for, on the board as Fixed Income hosts it, opened with what the command put in its params. */
async function openedOn(view: "index" | "sovereign", params: Record<string, string>, board: CdxBoardPayload = cdx, width = 100): Promise<string> {
  cdxBoardCache.attach(new MemoryPluginPersistence());
  sovrBoardCache.attach(new MemoryPluginPersistence());
  setCloudApiFetchTransport(async (url) => Response.json(String(url).includes("/sovr") ? sovr : board));
  const initial = createInitialState(createTestPaneConfig(":memory:", {
    instanceId: FIXED_INCOME_PANE_ID, paneId: FIXED_INCOME_PANE_ID, binding: { kind: "none" }, params: { view, ...params },
  }));
  const Board = view === "index" ? CdxPane : SovrPane;
  function Harness() {
    const [state, setState] = useState(initial);
    const dispatch = (action: AppAction) => setState((current) => appReducer(current, action));
    return (
      <TestPaneFrame state={state} dispatch={dispatch} paneId={FIXED_INCOME_PANE_ID} pluginId="credit-boards"
        runtime={createTestPluginRuntime({ getMarketData: () => null })} width={width} height={30}>
        {(body) => <Board paneId={FIXED_INCOME_PANE_ID} paneType="cdx-board" focused {...body} />}
      </TestPaneFrame>
    );
  }
  await act(async () => { await tui.render(<Harness />, { width, height: 30 }); });
  await tui.waitForFrameToContain("● ");
  return tui.frame().split("\n")[0]!.trim();
}

test("the index CDX opens on is the one the command names, by its code or name, and the first when it names none the board has", async () => {
  expect(await openedOn("index", { index: "hy" })).toContain("CDX HY 5Y");
  expect(await openedOn("index", { index: "itraxx crossover" })).toContain("iTraxx Crossover 5Y");
  expect(await openedOn("index", { index: "" })).toContain("CDX IG 5Y");
  expect(await openedOn("index", { index: "nonsense" })).toContain("CDX IG 5Y");
});

test("the country SOVR opens on is the one the command names, by its name or code, and the first when it names none the board has", async () => {
  expect(await openedOn("sovereign", { country: "ivory coast" })).toContain("Ivory Coast 5Y");
  expect(await openedOn("sovereign", { country: "BR" })).toContain("Brazil 5Y");
  expect(await openedOn("sovereign", { country: "" })).toContain("Argentina 5Y");
  expect(await openedOn("sovereign", { country: "Narnia" })).toContain("Argentina 5Y");
});

test("a server with the spread equivalent adds HY's beside its price, and a day still trading reads so far beside its whole date", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const board = { ...cdx, indexes: cdx.indexes.map((index) => index.id === "HY"
    ? { ...index, spreadBp: 357.5, recovery: 0.3, partial: false }
    : index.id === "XOVER" ? { ...index, date: today, partial: true, lastPrintAt: `${today}T08:09:41.000Z`, changeDate: "2026-10-09",
      points: [...index.points, { date: today, level: 312, prints: 38, maturity: "2031-12-20" }] } : { ...index, partial: false }) } as CdxBoardPayload;
  for (const width of [100, 140]) {
    await openedOn("index", {}, board, width);
    const frame = tui.frame();
    expect(frame).toContain("SPREAD EQ");
    expect(frame).toMatch(/CDX HY .*357\.5bp/);
    expect(frame).toMatch(new RegExp(`iTraxx Crossover .*(${today.slice(0, 5)})?${today.slice(5)} so far`));
  }
});
