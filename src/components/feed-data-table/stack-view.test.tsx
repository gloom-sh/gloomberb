import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createDefaultConfig } from "../../types/config";
import { FeedDataTableStackView } from "./stack-view";
import { setLanguage } from "../../i18n";

let testSetup: Awaited<ReturnType<typeof testRender>> | undefined;

afterEach(async () => {
  await act(async () => testSetup?.renderer.destroy());
  testSetup = undefined;
  setLanguage("en");
});

test("rebuilds translated columns when the app language changes", async () => {
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-feed-table-language"));
  const items = [{ id: "story", eyebrow: "Wire", title: "Story", timestamp: "2026-01-01" }];
  testSetup = await testRender(
    <AppContext value={{ state, dispatch: () => {} }}>
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
  await act(async () => testSetup?.renderOnce());
  expect(testSetup.captureCharFrame()).toContain("Source");

  await act(async () => {
    setLanguage("zh-CN");
    await testSetup?.renderOnce();
    await testSetup?.renderOnce();
  });
  expect(testSetup.captureCharFrame()).toContain("来源");
});
