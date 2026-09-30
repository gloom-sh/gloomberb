import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { FeedDataTableStackView } from "./stack-view";
import { setLanguage } from "../../i18n";

const tui = createOpenTuiTestHarness();

afterEach(() => {
  setLanguage("en");
});

test("rebuilds translated columns when the app language changes", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-feed-table-language"));
  const items = [{ id: "story", eyebrow: "Wire", title: "Story", timestamp: "2026-01-01" }];
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="news:test">
        <FeedDataTableStackView
          width={80}
          height={8}
          focused
          items={items}
          selectedIdx={0}
          onSelect={() => {}}
          sourceLabel="Source"
          titleLabel="Headline"
        />
      </PaneInstanceProvider>
    </AppContext>,
    { width: 80, height: 8 },
  );
  await act(async () => tui.setup().renderOnce());
  expect(tui.frame()).toContain("SOURCE");

  await act(async () => {
    setLanguage("zh-CN");
    await tui.setup().renderOnce();
    await tui.setup().renderOnce();
  });
  expect(tui.frame()).toContain("来源");
});
