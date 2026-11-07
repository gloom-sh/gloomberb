import { expect, test } from "bun:test";
import { act } from "react";
import { Text } from "../ui";
import { PaneFooterProvider } from "../components/layout/pane/footer";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { shareItem, shareItemExcerpt } from "./item";
import { paneShareItemFor, resolvePaneShareItem, usePaneShareItem, type PaneShareItemPart } from "./pane-item";

const tui = createOpenTuiTestHarness();

function Says({ item, kit = false, paneId = "p1" }: { item: PaneShareItemPart | null | (() => PaneShareItemPart | null); kit?: boolean; paneId?: string }) {
  usePaneShareItem(item, { paneId, kit });
  return null;
}

const shown = (children: React.ReactNode) => <PaneFooterProvider>{() => <>{children}<Text>pane</Text></>}</PaneFooterProvider>;

test("a pane's own item outranks the kit's, takes the kit's excerpt when it has none, and a hidden pane says nothing", async () => {
  const resolve = () => resolvePaneShareItem({ paneId: "p1", paneName: "Top News" });

  await act(async () => {
    await tui.render(shown(<>
      <Says kit item={{ title: "Stack detail title", excerpt: "The reader's opening." }} />
      <Says item={() => ({ title: "Iran reviewing proposals to curb nuclear program" })} />
    </>));
  });
  expect(resolve()).toEqual({
    pane: "Top News",
    title: "Iran reviewing proposals to curb nuclear program",
    excerpt: "The reader's opening.",
  });

  // Rendered outside a shown pane (a tab in the background), nothing is said.
  await act(async () => {
    await tui.render(<Says item={{ title: "Background tab story" }} />);
  });
  expect(resolve()).toBeNull();
});

test("without a word from the pane, its ticker, then its function's argument, is the item; a personal pane keeps none", () => {
  expect(resolvePaneShareItem({
    paneId: "none",
    paneName: "Research",
    ticker: { symbol: "NVDA:XNAS", name: "NVIDIA Corporation", exchange: "NASDAQ", sector: "Technology", industry: "Semiconductors" },
    argument: { label: "Crypto" },
  })).toEqual({ pane: "Research", title: "NVIDIA Corporation (NVDA)", excerpt: "NASDAQ · Technology · Semiconductors" });
  expect(resolvePaneShareItem({ paneId: "none", paneName: "News", argument: { label: "Crypto", description: "Headlines by topic" } }))
    .toEqual({ pane: "News", title: "Crypto", excerpt: "Headlines by topic" });
  expect(resolvePaneShareItem({ paneId: "none", paneName: "Top News" })).toBeNull();

  // A long story keeps its opening paragraph as plain text, cut at a word within the limit the service checks.
  const excerpt = shareItemExcerpt(`**Iran** is [reviewing](https://example.com) ${"proposals to curb its program ".repeat(20)}\n\nSecond paragraph.`, { markdown: true })!;
  expect(excerpt).toStartWith("Iran is reviewing proposals");
  expect(excerpt).toEndWith("…");
  expect(excerpt.length).toBeLessThanOrEqual(240);
  expect(excerpt).not.toContain("Second");

  // Nothing the share service cannot store: control characters and a broken surrogate pair go.
  expect(shareItem("Top\u0000 News", { title: "A\ud800 story\u0007", excerpt: "\udc00" })).toEqual({ pane: "Top News", title: "A story" });

  const pane = { instance: { instanceId: "p2", paneId: "portfolio" }, def: { id: "portfolio", name: "Portfolio" } } as never;
  expect(paneShareItemFor({ pane, state: {} as never, templates: new Map(), personal: true })).toBeNull();
});
