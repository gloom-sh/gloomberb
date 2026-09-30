import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { apiClient } from "../../../api-client";
import type { SocialMentionsPayload } from "../../../api-client/social-mentions";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { createInitialState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig, createTestTicker } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { SocialMentionsPane } from "./pane";

const DAY_MS = 86_400_000;
function payload(): SocialMentionsPayload {
  const start = Date.parse("2025-09-27T00:00:00Z");
  const days = Array.from({ length: 366 }, (_, index) => {
    const day = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
    return { day, mentions: day === "2026-01-09" ? 1_592 : 60 + (index * 37) % 40, closed: index < 365 };
  });
  return {
    symbol: "SOUN", range: "1y", asOf: "2026-09-27T12:00:00.000Z",
    x: { days, historyFrom: "2025-09-27", completeThrough: "2026-09-26", baseline: 77, refreshedAt: "2026-09-27T12:00:00.000Z" },
    stance: [{ day: "2026-09-26", score: .42, posts: 17 }],
    topPosts: [{ id: "1971000000000000001", day: "2026-09-26", author: "AIStockSavvy", text: "JUST IN: $SOUN launches OASYS Edge for on-device voice AI",
      postedAt: "2026-09-26T15:00:00.000Z", views: 4_901, likes: 88, reposts: 12, replies: 4, url: "https://x.com/AIStockSavvy/status/1971000000000000001", stance: .7 }],
    wikipedia: { article: "SoundHound_AI", baseline: 1_200,
      days: days.slice(-120).map((row, index) => ({ day: row.day, views: row.day === "2026-09-26" ? 3_600 : 1_000 + (index * 53) % 400 })) },
    reddit: { baseline: 12, days: days.slice(-40, -1).map((row, index) => ({ day: row.day, mentions: row.day === "2026-09-26" ? 48 : 8 + index % 9 })) },
    pending: [], warnings: [],
  };
}

const tui = createOpenTuiTestHarness();
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); await tui.setup().renderOnce(); });
}

async function render(width: number, height: number, open?: string, tickerKey = "SOUN"): Promise<string> {
  const state = createInitialState(createTestPaneConfig("/tmp/gloom-social-test", { instanceId: "buzz", paneId: "social-mentions" }));
  state.focusedPaneId = "buzz";
  state.paneState.buzz = { cursorSymbol: tickerKey,
    pluginState: open ? { "social-mentions": { "social-mentions:open": `1y:SOUN:${open}` } } : {} };
  state.tickers.set(tickerKey, createTestTicker(tickerKey, tickerKey === "SOUN" ? "SoundHound AI" : "Planoptik AG",
    { assetCategory: "STK", exchange: tickerKey === "SOUN" ? "NASDAQ" : "XETR", currency: tickerKey === "SOUN" ? "USD" : "EUR" }));
  await act(async () => { await tui.render(<TestPaneFrame state={state} paneId="buzz" pluginId="social-mentions" runtime={createTestPluginRuntime()} width={width} height={height}>
    {(body) => <SocialMentionsPane focused {...body} />}
  </TestPaneFrame>, { width, height }); });
  await settle();
  return tui.frame();
}

test("the pane leads with the last closed day against its median, then the daily table", async () => {
  spies.push(spyOn(apiClient, "getCloudSocialMentions").mockImplementation(async () => payload()));
  const frame = await render(96, 30);
  if (process.env.SOCIAL_PANE_PRINT) console.log(frame);
  expect(frame).toContain("30D median");
  expect(frame).toContain("1,592");
  expect(frame).toContain("2026-09-27");
  expect(frame).toContain("@AIStockSavvy");
  expect(frame).toContain("+0.42");
  expect(frame).toContain("Wiki views");
  expect(frame).toContain("REDDIT");
  expect(frame).toContain("4.0x median · 09-26");
  expect(frame).toContain("3,600");
});

test("an alphanumeric overseas ticker requests its cashtag history", async () => {
  const request = spyOn(apiClient, "getCloudSocialMentions").mockImplementation(async () => ({
    ...payload(), symbol: "P4O", wikipedia: undefined, reddit: undefined, topPosts: [],
  }));
  spies.push(request);
  const frame = await render(96, 30, undefined, "P4O:XETR");
  expect(request).toHaveBeenCalledWith("P4O", "1y");
  expect(frame).toContain("30D median");
});

test("opening a closed day loads its top posts", async () => {
  spies.push(spyOn(apiClient, "getCloudSocialMentions").mockImplementation(async () => payload()));
  const posts = spyOn(apiClient, "getCloudSocialMentionPosts").mockImplementation(async (symbol, day) => ({
    symbol, day, posts: [{ ...payload().topPosts[0]!, day, id: "1971000000000000009", text: "Spike day post about $SOUN" }],
  }));
  spies.push(posts);
  const frame = await render(96, 30, "2026-09-26");
  if (process.env.SOCIAL_PANE_PRINT) console.log(frame);
  expect(posts).toHaveBeenCalledWith("SOUN", "2026-09-26");
  expect(frame).toContain("Spike day post about $SOUN");
  expect(frame).toContain("4,901 views");
});
