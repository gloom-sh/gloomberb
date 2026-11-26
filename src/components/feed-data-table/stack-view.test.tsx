import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { FeedDataTableStackView, type FeedDataTableTimeColumn } from "./stack-view";
import { useTabCursorLink, type TabCursorLink } from "../../state/app/tab-cursor";
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

// A feed follows the tab's pinned crosshair only when its times are instants:
// a filing day cannot say whether it came before a moment in it.
test("an instant feed selects the item out by the pinned moment, and a feed of days does not follow it", async () => {
  const items = [
    { id: "late", eyebrow: "Wire", title: "Late item", timestamp: "2026-04-18T16:00:00Z" },
    { id: "mid", eyebrow: "Wire", title: "Mid item", timestamp: "2026-04-18T14:30:00Z" },
    { id: "early", eyebrow: "Wire", title: "Early item", timestamp: "2026-04-18T12:00:00Z" },
  ];
  const day: FeedDataTableTimeColumn = { label: "Filed", width: 10, format: (value) => String(value).slice(0, 10) };
  const selectedFor = async (timeColumn?: FeedDataTableTimeColumn) => {
    let link: TabCursorLink | undefined;
    const picks: number[] = [];
    function Chart() {
      link = useTabCursorLink("chart");
      return null;
    }
    const state = createInitialState(createDefaultConfig("/tmp/gloomberb-feed-table-pin"));
    await tui.render(
      <AppContext value={createStaticAppStore(state)}>
        <PaneInstanceProvider paneId="feed:pin">
          <Chart />
          <FeedDataTableStackView width={80} height={8} focused items={items} selectedIdx={0} onSelect={(index) => picks.push(index)}
            sourceLabel="Source" titleLabel="Headline" timeColumn={timeColumn} />
        </PaneInstanceProvider>
      </AppContext>,
      { width: 80, height: 8 },
    );
    try {
      await act(async () => link!.pin!(Date.parse("2026-04-18T15:00:00Z")));
      await act(async () => tui.setup().renderOnce());
      return picks.at(-1) ?? null;
    } finally {
      await act(async () => link?.pin?.(null));
    }
  };
  expect(await selectedFor()).toBe(1);
  expect(await selectedFor(day)).toBeNull();
});
