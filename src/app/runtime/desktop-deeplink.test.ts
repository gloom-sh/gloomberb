import { describe, expect, spyOn, test } from "bun:test";
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

  test("links that change something wait for a click on the toast that says what they ask", async () => {
    const ran: Array<{ command: string; values: unknown }> = [];
    const notices: Array<{ body: string; type: string; action?: { label: string; onClick: () => void } }> = [];
    const commands = new Map(["set-alert", "direct-message"].map((id) => [id, {
      execute: (values: unknown) => { ran.push({ command: id, values }); },
    }]));
    const dispatched: unknown[] = [];
    const registry = {
      commands,
      notify: (notice: (typeof notices)[number]) => { notices.push(notice); },
    } as unknown as PluginRegistry;
    const options = { pluginRegistry: registry, dispatch: (action: unknown) => { dispatched.push(action); }, stateRef: { current: {} as AppState } };

    handleDesktopDeepLink("gloomberb://alert/new?symbol=AAPL&condition=above&price=200", options);
    handleDesktopDeepLink("gloomberb://chat/dm?users=alice,@bob", options);
    handleDesktopDeepLink(`gloomberb://layout/${"a".repeat(32)}`, options);
    expect(ran).toEqual([]);
    expect(dispatched).toEqual([]);
    expect(notices.map(({ body, action }) => [body, action?.label])).toEqual([
      ["Create an alert for AAPL above 200?", "Create alert"],
      ["Open a conversation with @alice, @bob?", "Open"],
      ["Add the shared layout this link points to?", "Add layout"],
    ]);

    notices[0]!.action!.onClick();
    notices[1]!.action!.onClick();
    await Promise.resolve();
    expect(ran).toEqual([
      { command: "set-alert", values: { symbol: "AAPL", condition: "above", price: "200" } },
      { command: "direct-message", values: { participants: "alice,@bob" } },
    ]);

    // A shared pane only adds a view of what was clicked: it opens at once.
    const fetched: string[] = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      throw new Error("offline");
    }) as typeof fetch);
    const before = notices.length;
    try {
      handleDesktopDeepLink(`gloomberb://share/${"b".repeat(32)}`, options);
      expect(fetched).toEqual([expect.stringContaining("b".repeat(32))]);
      expect(notices.slice(before).filter((notice) => notice.action)).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }

    // Words that are not usernames are never put in the toast.
    handleDesktopDeepLink("gloomberb://chat/dm?users=Your%20account%20is%20locked", options);
    expect(notices.at(-1)).toMatchObject({ body: "DM links need usernames.", type: "error" });
    expect(notices.at(-1)?.action).toBeUndefined();
  });

  test.each([
    ["gloomberb://cloud/roundup?week=2026-07-03", { kind: "cloud-roundup", week: "2026-07-03" }],
    ["gloomberb://cloud/alerts", { kind: "cloud-alerts", week: null }],
    ["gloomberb://cloud/success", { kind: "cloud-success", week: null }],
    ["gloomberb://cloud/emails", { kind: "cloud-emails", week: null }],
  ])("routes %s to account management", (url, route) => {
    expect(resolveDesktopDeepLinkAction(url)).toMatchObject({ type: "open-account-management", route });
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
    expect(resolveDesktopDeepLinkAction("gloomberb://chat/dm?users=@ada,@alex")).toEqual({
      type: "open-chat-dm",
      participants: "@ada,@alex",
      message: "Opened DM.",
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

  test("function links open only a code that opens a pane, on one argument", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://fn/ern?arg=nvda")).toMatchObject({ type: "open-function", code: "ERN", arg: "NVDA" });
    expect(resolveDesktopDeepLinkAction("gloomberb://fn/PERP?arg=BTC-USD")).toMatchObject({ code: "PERP", arg: "BTC-USD" });
    expect(resolveDesktopDeepLinkAction("gloomberb://fn/13F")).toMatchObject({ code: "13F", arg: null });
    expect(resolveDesktopDeepLinkAction("gloomberb://fn/ERN?arg=")).toMatchObject({ code: "ERN", arg: null });
    // One word: a link never carries a second command.
    for (const link of ["gloomberb://fn/ERN?arg=NVDA%20QUIT", "gloomberb://fn/ERN?arg=NVDA;QUIT", "gloomberb://fn/ERN%20NVDA", "gloomberb://fn?arg=NVDA"]) {
      expect(resolveDesktopDeepLinkAction(link).type).toBe("unsupported");
    }

    const ran: string[] = [];
    const notices: Array<{ body: string; type: string }> = [];
    const registry = {
      paneTemplates: new Map([
        ["earnings-pane", { shortcut: { prefix: "ERN" } }],
        ["perps-pane", { shortcut: { prefix: "PERP", aliases: ["FUND"] } }],
        ["no-shortcut", {}],
      ]),
      runCommandBarQuery: (query: string) => { ran.push(query); },
      notify: (notice: { body: string; type: string }) => { notices.push(notice); },
    } as unknown as PluginRegistry;
    const options = { pluginRegistry: registry, dispatch: () => {}, stateRef: { current: {} as AppState } };
    handleDesktopDeepLink("gloomberb://fn/ERN?arg=nvda", options);
    handleDesktopDeepLink("gloomberb://fn/fund?arg=BTC", options);
    // A command's code (settings, sign out) is not a pane: refused, never run.
    handleDesktopDeepLink("gloomberb://fn/LOGOUT", options);
    expect(ran).toEqual(["ERN NVDA", "FUND BTC"]);
    expect(notices).toEqual([{ body: "LOGOUT is not a function this version of Gloom opens from a link.", type: "error" }]);
  });

  test("rejects command-bar, non-gloomberb, and malformed links", () => {
    expect(resolveDesktopDeepLinkAction("gloomberb://command?query=profile").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("gloomberb://search/NVDA").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("https://gloom.sh/cloud").type).toBe("unsupported");
    expect(resolveDesktopDeepLinkAction("not a url").type).toBe("unsupported");
  });
});
