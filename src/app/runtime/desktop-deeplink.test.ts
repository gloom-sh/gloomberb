import { describe, expect, test } from "bun:test";
import { handleDesktopDeepLink, resolveDesktopDeepLinkAction } from "./desktop-deeplink";
import type { PluginRegistry } from "../../plugins/registry";
import type { AppState } from "../../state/app/context";

describe("desktop deeplinks", () => {
  test("opens a valid ticker on overview when a requested tab is unavailable, preserving registered tabs and rejected links", () => {
    const pinned: Array<{ symbol: string; options: unknown }> = [];
    const notices: Array<{ body: string; type: string }> = [];
    const panes = new Map([["ticker-research", {}]]);
    const registry = {
      panes,
      getTickerResearchTabPluginId: (id: string) => ["overview", "corporate-actions"].includes(id) ? "research" : undefined,
      pinTicker: (symbol: string, options: unknown) => { pinned.push({ symbol, options }); },
      notify: (notice: { body: string; type: string }) => { notices.push(notice); },
    } as unknown as PluginRegistry;
    const options = { pluginRegistry: registry, dispatch: () => {}, stateRef: { current: {} as AppState } };

    handleDesktopDeepLink("gloomberb://ticker/RIVN?tab=events", options);
    expect(pinned).toEqual([{ symbol: "RIVN", options: { floating: true, paneType: "ticker-research", tabId: "overview" } }]);
    expect(notices.at(-1)).toEqual({ body: 'Ticker tab "events" is unavailable. Opening RIVN overview.', type: "info" });

    handleDesktopDeepLink("gloomberb://ticker/RIVN?tab=corporate-actions", options);
    expect(pinned.at(-1)?.options).toMatchObject({ tabId: "corporate-actions" });
    handleDesktopDeepLink("gloomberb://ticker?tab=events", options);
    expect(pinned).toHaveLength(2);
    expect(notices.at(-1)?.type).toBe("error");
    panes.clear();
    handleDesktopDeepLink("gloomberb://ticker/RIVN?tab=events", options);
    expect(pinned).toHaveLength(2);
    expect(notices.at(-1)?.body).toBe("Ticker research is unavailable.");
  });

  test("routes cloud roundup links to account management", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://cloud/roundup?week=2026-07-03")).toEqual({
      type: "open-account-management",
      route: { kind: "cloud-roundup", week: "2026-07-03" },
      message: "Opened weekly roundup settings for 2026-07-03.",
    });
  });

  test("routes cloud alert links to account management", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://cloud/alerts")).toEqual({
      type: "open-account-management",
      route: { kind: "cloud-alerts", week: null },
      message: "Opened portfolio alert settings.",
    });
  });

  test("routes the post-checkout success link to account management", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://cloud/success")).toEqual({
      type: "open-account-management",
      route: { kind: "cloud-success", week: null },
      message: "Pro is active.",
    });
  });

  test("ignores the website's analytics handoff parameters", () => {
    const handoff =
      "_gloom=0f1e2d3c-4b5a-4968-8776-655443322110&utm_source=x&twclid=click_1&first_touch_at=2026-09-10T11:00:00.000Z&first_touch_referrer=https%3A%2F%2Ft.co%2Fabc";
    expect(resolveDesktopDeepLinkAction(`gloomberb://cloud/success?${handoff}`)).toEqual(
      resolveDesktopDeepLinkAction("gloomberb://cloud/success"),
    );
    expect(resolveDesktopDeepLinkAction(`gloomberb://ticker/NVDA?tab=chart&${handoff}`)).toEqual(
      resolveDesktopDeepLinkAction("gloomberb://ticker/NVDA?tab=chart"),
    );
    expect(resolveDesktopDeepLinkAction(`gloomberb://cloud/roundup?week=2026-07-03&${handoff}`)).toEqual(
      resolveDesktopDeepLinkAction("gloomberb://cloud/roundup?week=2026-07-03"),
    );
  });

  test("routes ticker links with arbitrary registered tab ids", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://ticker/NVDA?tab=analyst-research")).toEqual({
      type: "open-ticker",
      symbol: "NVDA",
      tabId: "analyst-research",
      message: "Opened NVDA analyst-research tab.",
    });
  });

  test("routes portfolio and watchlist links", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://portfolio/main")).toEqual({
      type: "open-collection",
      kind: "portfolio",
      collectionId: "main",
      message: "Opened portfolio main.",
    });
    expect(resolveDesktopDeepLinkAction("gloomberb://watchlist/favorites")).toEqual({
      type: "open-collection",
      kind: "watchlist",
      collectionId: "favorites",
      message: "Opened watchlist favorites.",
    });
  });

  test("routes alert links with structured values", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://alert/new?symbol=nvda&side=above&price=$200")).toEqual({
      type: "create-alert",
      values: { symbol: "NVDA", condition: "above", price: "200" },
      message: "Created NVDA above 200 alert.",
    });
  });

  test("routes chat links", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://chat/channel/everyone")).toEqual({
      type: "open-chat-channel",
      channelId: "everyone",
      messageId: null,
      message: "Opened chat everyone.",
    });
    expect(resolveDesktopDeepLinkAction("gloomberb://chat/channel/dm%3Aabc?message=m%3A2")).toEqual({
      type: "open-chat-channel",
      channelId: "dm:abc",
      messageId: "m:2",
      message: "Opened chat dm:abc.",
    });
    expect(resolveDesktopDeepLinkAction("gloomberb://chat/dm?users=@vince,@alex")).toEqual({
      type: "open-chat-dm",
      participants: "@vince,@alex",
      message: "Opened DM.",
    });
  });

  test("routes email preference links to account management", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://cloud/emails")).toEqual({
      type: "open-account-management",
      route: { kind: "cloud-emails", week: null },
      message: "Opened email settings.",
    });
  });

  test("routes news links", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://news?ticker=7203.T")).toEqual({
      type: "open-news",
      kind: "ticker",
      symbol: "7203.T",
      message: "Opened 7203.T news.",
    });
    expect(resolveDesktopDeepLinkAction("gloomberb://news/breaking")).toEqual({
      type: "open-news",
      kind: "breaking",
      symbol: null,
      message: "Opened breaking news.",
    });
  });

  test("routes only opaque 32-character social share ids", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(resolveDesktopDeepLinkAction(`gloomberb://share/${id}`)).toEqual({
      type: "open-share",
      id,
      message: "Opened shared pane.",
    });
    expect(resolveDesktopDeepLinkAction(`gloomberb://layout/${id}`)).toEqual({
      type: "open-layout",
      id,
      message: "Added shared layout.",
    });
    expect(resolveDesktopDeepLinkAction("gloomberb://share/not-valid").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("gloomberb://layout/not-valid").type).toBe("unsupported");
  });

  test("rejects command-bar, non-gloomberb, and malformed links", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://command?query=profile").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("gloomberb://search/NVDA").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("https://gloom.sh/cloud").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("not a url").type).toBe("unsupported");
  });
});
