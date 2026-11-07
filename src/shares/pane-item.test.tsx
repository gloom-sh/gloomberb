import { expect, test } from "bun:test";
import { act } from "react";
import { Text } from "../ui";
import { PaneFooterProvider } from "../components/layout/pane/footer";
import { PageStackView } from "../components/ui/page-stack-view";
import { removeExternalPlugin, upsertExternalPlugin } from "../plugins/external-runtime";
import { createOpenTuiTestHarness } from "../renderers/opentui/test-utils";
import { PaneInstanceProvider } from "../state/app/context";
import type { PaneDef, PaneTemplateDef } from "../types/plugin";
import { parseShareItem, shareItem, shareItemExcerpt } from "./item";
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

test("without a word from the pane, its ticker, then its function's argument, is the item", () => {
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
});

test("an item read from a share draws as plain text: no escape sequence, control, bidi or zero-width character survives", () => {
  expect(parseShareItem({
    pane: "Top\u200b News",
    title: "\u001b[2J\u001b[31mRed\u001b[0m alert\u0007 \u202egnp.exe\u202c \u001b]8;;https://evil.example\u0007here\u001b]8;;\u0007",
    excerpt: "line\r\nnext\u009b31m \u2066isolated\u2069\ufeff",
  })).toEqual({ pane: "Top News", title: "Red alert gnp.exe here", excerpt: "line next isolated" });
  // Nothing left to show is no item.
  expect(parseShareItem({ pane: "Top News", title: "\u001b[31m\u200b" })).toBeNull();
});

/** The pane Share reads, rendered as a pane: a stack with its detail open, as the Alerts pane draws an alert. */
async function renderAlertStack(paneId: string) {
  await act(async () => {
    await tui.render(
      <PaneInstanceProvider paneId={paneId}>
        <PaneFooterProvider>{() => (
          <PageStackView focused detailOpen onBack={() => {}} rootContent={null} detailContent={<Text>rule</Text>} detailTitle="AAPL above $190" />
        )}</PaneFooterProvider>
      </PaneInstanceProvider>,
    );
  });
}

function itemFor(paneId: string, def: Partial<PaneDef>, options: { personal?: boolean; owner?: string; title?: string; templates?: PaneTemplateDef[] } = {}) {
  return paneShareItemFor({
    pane: { instance: { instanceId: paneId, paneId: def.id ?? "alerts", title: options.title }, def: { id: "alerts", name: "Alerts", ...def } } as never,
    state: {} as never,
    registry: {
      paneTemplates: new Map((options.templates ?? []).map((template) => [template.id, template])),
      getPanePluginId: () => options.owner,
    },
    personal: options.personal ?? false,
  });
}

test("the kit's guess reaches a link only from a pane that opts in: not an undeclared pane, a personal one, or an outside plugin's", async () => {
  await renderAlertStack("alerts:1");
  // The Alerts pane says nothing about sharing what it has open: its alert stays off the link.
  expect(itemFor("alerts:1", {})).toBeNull();
  expect(itemFor("alerts:1", { shareItem: { ticker: true, argument: true } })).toBeNull();
  // Opted in but showing the person's own data now: none either.
  expect(itemFor("alerts:1", { shareItem: { open: true } }, { personal: true })).toBeNull();
  // A plugin loaded from outside the app names nothing, whatever it declares.
  upsertExternalPlugin({ plugin: { id: "outside" }, path: "/plugins/outside" } as never);
  try {
    expect(itemFor("alerts:1", { shareItem: { open: true } }, { owner: "outside" })).toBeNull();
  } finally {
    removeExternalPlugin("outside");
  }
  // The same stack in a pane that opts in is named, so the kit did say it.
  expect(itemFor("alerts:1", { shareItem: { open: true } }, { owner: "builtin-news" })).toEqual({ pane: "Alerts", title: "AAPL above $190" });
});

test("a function's argument names the item only as an option it lists, never the words typed after it", () => {
  const template = {
    id: "news-industry-pane",
    paneId: "news-industry",
    label: "Topic News",
    description: "Headlines by topic",
    shortcut: { prefix: "NI", argKind: "text", argOptions: () => [{ value: "CRYPTO", label: "Crypto" }] },
  } as unknown as PaneTemplateDef;
  const def = { id: "news-industry", name: "Topic News", shareItem: { argument: true as const } };
  expect(itemFor("ni:1", def, { title: "NI crypto", templates: [template] })).toEqual({ pane: "Topic News", title: "Crypto", excerpt: "Headlines by topic" });
  expect(itemFor("ni:1", def, { title: "NI my own words", templates: [template] })).toBeNull();
  expect(itemFor("ni:1", { ...def, shareItem: { open: true } }, { title: "NI crypto", templates: [template] })).toBeNull();
});
