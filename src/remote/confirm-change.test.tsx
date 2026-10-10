import { describe, expect, test } from "bun:test";
import { createOpenTuiTestHarness, type TestKeyEvent } from "../renderers/opentui/test-utils";
import { RemoteChangeDialog } from "./confirm-change";

const tui = createOpenTuiTestHarness();
const press = (event: TestKeyEvent) => tui.emitKeypress(event, { frames: 2, afterCommit: true });
const prompt = {
  title: "Add MSFT to Tech?",
  lines: [
    { label: "Watchlist", value: "Tech" },
    { label: "Ticker", value: "MSFT" },
    { label: "Exchange", value: "NASDAQ" },
    { label: "Name", value: "Microsoft Corporation" },
  ],
  confirmLabel: "Add",
};

describe("remote change confirmation", () => {
  test("Enter typed as it opens does not approve; the Add button, y and n answer", async () => {
    const answers: boolean[] = [];
    await tui.render(
      <RemoteChangeDialog resolve={(answer) => answers.push(answer)} dismiss={() => {}} prompt={prompt} keyGraceMs={60_000} />,
      { width: 70, height: 20 },
    );
    await tui.waitForFrameToContain("Add MSFT to Tech?");
    expect(tui.frame()).toContain("NASDAQ");
    await press({ name: "return" });
    await press({ name: "y", sequence: "y" });
    expect(answers).toEqual([]);
    // The button, not the title.
    await tui.clickFrameText(" Add ");
    await press({ name: "n", sequence: "n" });
    expect(answers).toEqual([true, false]);
  });

  test("a narrow terminal gets a narrower dialog, and an aborted caller declines", async () => {
    const answers: boolean[] = [];
    const abort = new AbortController();
    await tui.render(
      <RemoteChangeDialog resolve={(answer) => answers.push(answer)} dismiss={() => {}} prompt={prompt} signal={abort.signal} keyGraceMs={0} />,
      { width: 40, height: 20 },
    );
    await tui.waitForFrameToContain("Exchange");
    expect(tui.frame().split("\n").every((line) => line.trimEnd().length <= 40)).toBe(true);
    expect(tui.frame()).toContain("NASDAQ");
    expect(tui.frame()).toContain("Microsoft Corporation");
    abort.abort();
    await tui.renderFrames(2);
    expect(answers).toEqual([false]);
  });
});
