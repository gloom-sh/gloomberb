import { afterEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createOpenTuiTestHarness } from "../../renderers/opentui/test-utils";
import { AppContext, PaneInstanceProvider, createInitialState } from "../../state/app/context";
import { createStaticAppStore } from "../../test-support/app-store";
import { createDefaultConfig } from "../../types/config";
import { FeedDataTableStackView, type FeedDataTableItem, type FeedDataTableTimeColumn } from "./stack-view";
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

const streamed = (id: string, time: string): FeedDataTableItem => ({ id, eyebrow: "Wire", title: `Item ${id}`, timestamp: `2026-04-18T${time}:00Z` });

/** A feed whose owner keeps the selected index, beside a chart that pins the tab's crosshair. */
async function mountStreamingFeed(first: FeedDataTableItem[], timeColumn?: FeedDataTableTimeColumn) {
  let link: TabCursorLink | undefined;
  let stream!: (items: FeedDataTableItem[]) => void;
  let pick!: (index: number) => void;
  let selected: () => string | undefined = () => undefined;
  function Chart() {
    link = useTabCursorLink("chart");
    return null;
  }
  function Feed() {
    const [items, setItems] = useState(first);
    const [selectedIdx, setSelectedIdx] = useState(0);
    stream = setItems;
    pick = setSelectedIdx;
    selected = () => items[selectedIdx]?.id;
    return <FeedDataTableStackView width={80} height={10} focused items={items} selectedIdx={selectedIdx} onSelect={setSelectedIdx}
      sourceLabel="Source" titleLabel="Headline" timeColumn={timeColumn} />;
  }
  const state = createInitialState(createDefaultConfig("/tmp/gloomberb-feed-table-stream"));
  await tui.render(
    <AppContext value={createStaticAppStore(state)}>
      <PaneInstanceProvider paneId="feed:stream">
        <Chart />
        <Feed />
      </PaneInstanceProvider>
    </AppContext>,
    { width: 80, height: 10 },
  );
  const settle = () => act(async () => { await tui.setup().renderOnce(); });
  return {
    selected: () => selected(),
    async send(items: FeedDataTableItem[]) {
      await act(async () => stream(items));
      await settle();
    },
    async pick(index: number) {
      await act(async () => pick(index));
      await settle();
    },
    async pin(time: string | null) {
      await act(async () => link!.pin!(time === null ? null : Date.parse(`2026-04-18T${time}:00Z`)));
      await settle();
    },
  };
}

// The owner keeps an index, but the selection is the item's: items streaming
// in above it move its index, not the selection, and a selected item that
// goes out of the feed gives way to the pin's.
test("a streaming feed keeps the selected item as items arrive, and the pin's when the selected one goes out", async () => {
  const a = streamed("A", "16:00"), b = streamed("B", "14:30"), c = streamed("C", "12:00");
  const feed = await mountStreamingFeed([a, b, c]);
  try {
    await feed.pick(1);
    await feed.send([streamed("X", "17:00"), a, b, c]);
    expect(feed.selected()).toBe("B");

    // Under a pin at 16:30, the selection goes to A, the item out by then.
    await feed.pin("16:30");
    expect(feed.selected()).toBe("A");
    await feed.pick(2);
    expect(feed.selected()).toBe("B");
    await feed.send([streamed("Y", "17:30"), streamed("X", "17:00"), a, b, c]);
    expect(feed.selected()).toBe("B");

    // Not the top row (Y), nor C, which takes B's place.
    await feed.send([streamed("Y", "17:30"), streamed("X", "17:00"), a, c]);
    expect(feed.selected()).toBe("A");
  } finally {
    await feed.pin(null);
  }
});

// The first row is the selection before any pick; a pin on it holds it as
// the item it is, so an item arriving above cannot take its place.
test("a feed holds the pin's item when it was the first row shown, as an item arrives above it", async () => {
  const a = streamed("A", "16:00"), b = streamed("B", "14:30");
  const feed = await mountStreamingFeed([a, b]);
  try {
    await feed.pin("16:30");
    expect(feed.selected()).toBe("A");
    await feed.send([streamed("X", "17:00"), a, b]);
    expect(feed.selected()).toBe("A");
  } finally {
    await feed.pin(null);
  }
});

// A list of filings by day does not stream: its owner resets the index when a
// filter changes the list, and the reset is what it gets.
test("a feed dated by day keeps the owner's index as its items change", async () => {
  const a = streamed("A", "16:00"), b = streamed("B", "14:30"), c = streamed("C", "12:00");
  const feed = await mountStreamingFeed([b, c], { label: "Filed", width: 10, format: (value) => String(value).slice(0, 10) });
  await feed.send([a, b, c]);
  expect(feed.selected()).toBe("A");
});
