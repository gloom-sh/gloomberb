import { expect, test } from "bun:test";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { AppContext, createInitialState, PaneInstanceProvider } from "../../../state/app/context";
import { createStaticAppStore } from "../../../test-support/app-store";
import { createTestPaneConfig } from "../../../test-support/pane";
import type { PaneSettingsContext, PaneTemplateContext } from "../../../types/plugin";
import { earningsModule } from "./index";
import { scopedSymbolsFromSettings } from "./model";

const symbols = Array.from({ length: 11 }, (_, i) => `TEST${i}`);
const text = symbols.join(", ");
const pane = earningsModule.panes![0]!;
const template = earningsModule.paneTemplates![0]!;
const context = {} as PaneTemplateContext;
const tui = createOpenTuiTestHarness({ width: 90, height: 16 });

test("invalid saved scopes and template arguments remain editable instead of opening the market", async () => {
  const instances = await Promise.all([
    template.createInstance!(context, { arg: text }),
    template.createInstance!(context, { symbols }),
  ]);
  for (const settings of [{ symbolsText: text }, { symbols }, ...instances.map((instance) => instance!.settings)]) {
    const scope = scopedSymbolsFromSettings(settings);
    expect(scope).toMatchObject({ symbols: null, error: expect.stringContaining("10") });
    const definition = typeof pane.settings === "function"
      ? pane.settings({ settings } as PaneSettingsContext) : pane.settings;
    expect(definition?.values?.symbolsText).toBe(text);
  }
  const corrected = scopedSymbolsFromSettings({ symbolsText: symbols.slice(0, 10).join(" ") });
  expect(corrected).toMatchObject({ symbols: symbols.slice(0, 10), error: null });
  expect(scopedSymbolsFromSettings({ symbols: [" test0 ", "TEST0", "test1"] }))
    .toMatchObject({ symbols: ["TEST0", "TEST1"], error: null });
});

test("an over-limit saved scope renders the shared invalid-settings state", async () => {
  const id = "earnings:invalid";
  const config = createTestPaneConfig("/unused/earnings-scope-test", {
    instanceId: id, paneId: pane.id, binding: { kind: "none" }, settings: { symbolsText: text },
  });
  const Component = pane.component;
  await tui.render(<AppContext value={createStaticAppStore(createInitialState(config), () => {})}>
    <PaneInstanceProvider paneId={id}>
      <Component paneId={id} paneType={pane.id} focused width={90} height={16} />
    </PaneInstanceProvider>
  </AppContext>);
  const frame = await tui.waitForFrameToContain("You can compare up to 10 tickers.");
  expect(frame).toContain("Earnings scope unavailable.");
  expect(frame).not.toContain("Loading earnings");
});
