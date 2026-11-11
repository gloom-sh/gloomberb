import { expect, test } from "bun:test";
import { act, useReducer } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, appReducer, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { QueryBar } from "./query-bar";

const tui = createOpenTuiTestHarness({ width: 120, height: 3 });

/** FA's bar: the statement as inline segments, the period view, and the as-of and growth basis at the right. */
function Bar({ width }: { width: number }) {
  const [state, dispatch] = useReducer(appReducer, createInitialState(createDefaultConfig("/tmp/gloom-query-bar")));
  return (
    <AppContext value={createStaticAppStore(state, dispatch)}>
      <PaneInstanceProvider paneId="query-bar:test">
        <QueryBar
          width={width}
          filters={[{
            id: "statement",
            label: "Statement",
            inline: true,
            value: "income",
            options: ["Income", "Cash Flow", "Balance Sheet", "Ratios"].map((label) => ({ label, value: label.toLowerCase() })),
            onChange: () => {},
          }]}
          view={{ value: "annual", options: [{ label: "Annual", value: "annual" }, { label: "Quarterly", value: "quarterly" }], onChange: () => {} }}
          asOf="as of 2026-06-30"
          meta="USD bn · YoY"
        />
      </PaneInstanceProvider>
    </AppContext>
  );
}

async function row(width: number): Promise<string> {
  await tui.render(<Bar width={width} />, { width, height: 3 });
  await act(async () => tui.setup().renderOnce());
  return tui.setup().captureCharFrame().split("\n")[0]!;
}

test("short of room, the inline segments become a menu so the as-of stays whole; the context gives way", async () => {
  const wide = await row(120);
  expect(wide).toContain("Cash Flow");
  expect(wide).toMatch(/as of 2026-06-30 +USD bn · YoY/);
  const narrow = await row(64);
  expect(narrow).not.toContain("Cash Flow");
  expect(narrow).toContain("Statement");
  expect(narrow).toContain("Income");
  expect(narrow).toContain("as of 2026-06-30");
  expect(narrow).toContain("Quarterly");
});
