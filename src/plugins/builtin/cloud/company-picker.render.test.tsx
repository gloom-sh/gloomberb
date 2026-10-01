import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppProvider } from "../../../state/app/context";
import { createDefaultConfig } from "../../../types/config";
import { CompanyPicker, type CompanyPick } from "./company-picker";

const tui = createOpenTuiTestHarness();

describe("CompanyPicker in the terminal", () => {
  test("picks with the arrows and Space, then follows with Enter", async () => {
    let done: CompanyPick[] | null = null;
    await tui.render(
      <AppProvider config={createDefaultConfig("/tmp/gloom-picker-test")}>
        <CompanyPicker searchCompanies={async () => []} onDone={(picks) => { done = picks; }} />
      </AppProvider>,
      { width: 100, height: 30 },
    );
    await tui.setup().renderOnce();
    const first = tui.frame();
    expect(first).toContain("Which companies do you follow?");
    expect(first).toContain("NVDA");
    expect(first).toContain("BTC-USD");
    expect(first).toContain("Pick at least 2 to continue.");

    const keys = [
      { name: "right" }, { name: "space", sequence: " " },
      { name: "right" }, { name: "space", sequence: " " },
    ];
    for (const key of keys) await tui.emitKeypress(key);
    await tui.setup().renderOnce();
    const picked = tui.frame();
    expect(picked).toContain("✓NVDA");
    expect(picked).toContain("✓AAPL");
    expect(picked).toContain("Follow 2 companies");
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await tui.setup().renderOnce();
    expect(done!.map((pick) => pick.symbol)).toEqual(["NVDA", "AAPL"]);
  });

  test("searches for a company that is not suggested", async () => {
    const queries: string[] = [];
    await tui.render(
      <AppProvider config={createDefaultConfig("/tmp/gloom-picker-test")}>
        <CompanyPicker
          searchCompanies={async (query) => {
            queries.push(query);
            return [{ providerId: "test", symbol: "ASML", name: "ASML Holding N.V.", exchange: "NASDAQ", type: "EQUITY" }];
          }}
          onDone={() => {}}
        />
      </AppProvider>,
      { width: 100, height: 30 },
    );
    await act(async () => {
      await tui.setup().mockInput.typeText("asml");
      await tui.setup().renderOnce();
    });
    // The search is debounced; wait for the answer rather than a fixed time.
    let frame = "";
    for (let attempt = 0; attempt < 40 && !frame.includes("ASML Holding"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      await tui.setup().renderOnce();
      frame = tui.frame();
    }
    if (process.env.PRINT_PICKER_FRAME) console.log(frame);
    expect(queries.at(-1)).toBe("asml");
    expect(frame).toContain("ASML Holding N.V.");
    await tui.emitKeypress({ name: "return", sequence: "\r" });
    await tui.setup().renderOnce();
    expect(tui.frame()).toContain("ASML. 1 more to go.");
  });
});
