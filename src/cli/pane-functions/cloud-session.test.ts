import { describe, expect, setSystemTime, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../api-client";
import { AppPersistence } from "../../data/app-persistence";
import { getLoadablePlugins } from "../../plugins/catalog";
import { GloomberbCloudProvider } from "../../sources/gloomberb-cloud";
import { AssetDataRouter } from "../../sources/provider-router";
import { createTestCliContext } from "../../test-support/cli-context";
import { createDefaultConfig } from "../../types/config";
import type { MarketContext } from "../types";
import { runPaneFunction } from ".";
import {
  resolvePersistedCloudSessionToken,
  withPersistedCloudSession,
} from "./cloud-session";

function contextWithSession(
  key: string,
  sessionToken: string,
): Pick<MarketContext, "persistence"> {
  return {
    persistence: {
      pluginState: {
        get: (_pluginId: string, candidate: string) => candidate === key
          ? { value: { sessionToken }, schemaVersion: 1, updatedAt: 1 }
          : null,
      },
    },
  } as Pick<MarketContext, "persistence">;
}

describe("pane function Cloud session", () => {
  test("restores the current and legacy persisted session keys", () => {
    expect(resolvePersistedCloudSessionToken(
      contextWithSession("resume:session", "current-session"),
    )).toBe("current-session");
    expect(resolvePersistedCloudSessionToken(
      contextWithSession("session", "legacy-session"),
    )).toBe("legacy-session");
  });

  test("scopes the persisted session to one report load", async () => {
    const initial = apiClient.getSessionToken();
    apiClient.setSessionToken("previous-session");
    try {
      let activeSession: string | null = null;
      const result = await withPersistedCloudSession(
        contextWithSession("resume:session", "report-session"),
        async () => {
          activeSession = apiClient.getSessionToken();
          return 42;
        },
      );

      expect(result).toBe(42);
      expect(activeSession).toBe("report-session");
      expect(apiClient.getSessionToken()).toBe("previous-session");
    } finally {
      apiClient.setSessionToken(initial);
    }
  });
});

describe("cloud session token from the environment", () => {
  test("QQ keeps the paid feed for a listing lookup and a direct quote in the same report", async () => {
    const persistence = new AppPersistence(":memory:");
    const provider = new GloomberbCloudProvider();
    const dataProvider = new AssetDataRouter(provider, [], persistence.resources);
    const config = createDefaultConfig("fixture");
    const cli = createTestCliContext({ persistence, dataProvider, config });
    Object.assign(cli.context, { plugins: getLoadablePlugins() });
    const initialToken = apiClient.getSessionToken();
    const previous = process.env.GLOOMBERB_SESSION_TOKEN;
    const session = "pro-quote-fixture";
    const reads: Array<{ symbol: string; authenticated: boolean }> = [];
    setSystemTime(new Date("2026-11-19T19:00:00Z"));
    process.env.GLOOMBERB_SESSION_TOKEN = session;
    apiClient.setSessionToken(session);
    setCloudApiFetchTransport(async (url, init) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname !== "/market/quote") return Response.json({ message: "No fixture for this route" }, { status: 404 });
      const symbol = searchParams.get("symbol")!;
      const authenticated = new Headers(init.headers).get("cookie")?.includes(`=${session}`) ?? false;
      reads.push({ symbol, authenticated });
      const firstSession = symbol === "NEW";
      return Response.json({ status: "success", data: {
        symbol, name: symbol, price: 101, currency: "USD", changeSessionDate: "2026-11-19",
        ...(firstSession ? { change: null, changePercent: null, changeBasis: "none" }
          : { change: 1, changePercent: 1, previousClose: 100, previousCloseDate: "2026-11-18" }),
        listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "REGULAR",
        instrumentType: symbol === "QQQ" ? "ETF" : "EQUITY",
        dataSource: authenticated ? "live" : "delayed", lastUpdated: Date.now() - (authenticated ? 0 : 15 * 60_000),
      } });
    });
    try {
      await runPaneFunction(["QQ", "QQQ,MU:NASDAQ,NEW:NASDAQ"], cli.context);
      expect(reads.map(({ symbol }) => symbol).sort()).toEqual(["MU", "NEW", "QQQ"]);
      expect(reads.every(({ authenticated }) => authenticated)).toBe(true);
      const rows = cli.printed[0]?.result.data.rows as Array<{ change: unknown; changePercent: unknown }>;
      expect(rows).toMatchObject([
        { symbol: "QQQ", feed: "live" },
        { symbol: "MU:NASDAQ", feed: "live" },
        { symbol: "NEW:NASDAQ", feed: "live", changeBasis: "No previous close" },
      ]);
      // No change on a first session: NaN as read, null once read again from the saved copy; both print as missing.
      expect([rows[2]!.change, rows[2]!.changePercent].some((value) => typeof value === "number" && Number.isFinite(value))).toBe(false);
    } finally {
      apiClient.setSessionToken(initialToken);
      setCloudApiFetchTransport(null);
      setSystemTime();
      if (previous === undefined) delete process.env.GLOOMBERB_SESSION_TOKEN;
      else process.env.GLOOMBERB_SESSION_TOKEN = previous;
    }
  });

  test("QQ reads an ETF again for a session when its saved copy is a signed-out read's delayed one", async () => {
    // The service answers a Pro account live, and a free account delayed as it answers a read with no session.
    const feeds: Record<string, "live" | "delayed"> = { "pro-fixture": "live", "free-fixture": "delayed" };
    const reads: string[] = [];
    const initialToken = apiClient.getSessionToken();
    const previous = process.env.GLOOMBERB_SESSION_TOKEN;
    setSystemTime(new Date("2026-11-19T19:00:00Z"));
    setCloudApiFetchTransport(async (url, init) => {
      if (new URL(url).pathname !== "/market/quote") return Response.json({ message: "No fixture for this route" }, { status: 404 });
      const cookie = new Headers(init.headers).get("cookie") ?? "";
      const session = Object.keys(feeds).find((token) => cookie.includes(`=${token}`));
      reads.push(session ?? "signed out");
      const feed = session ? feeds[session]! : "delayed";
      return Response.json({ status: "success", data: {
        symbol: "QQQ", name: "Invesco QQQ Trust", price: 101, currency: "USD", change: 1, changePercent: 1,
        previousClose: 100, previousCloseDate: "2026-11-18", changeSessionDate: "2026-11-19",
        listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", marketState: "REGULAR", instrumentType: "ETF",
        dataSource: feed, lastUpdated: Date.now() - (feed === "live" ? 0 : 15 * 60_000),
      } });
    });
    // One profile, read by a `fn QQ QQQ` command under each session in turn: each command its own router, as each
    // process has, over the quotes the earlier ones saved.
    const profile = () => {
      const saved = new AppPersistence(":memory:");
      const persistence = Object.assign(Object.create(saved) as AppPersistence, { close: () => {} });
      return async (session: string | null) => {
        if (session) process.env.GLOOMBERB_SESSION_TOKEN = session;
        else delete process.env.GLOOMBERB_SESSION_TOKEN;
        apiClient.setSessionToken(session);
        const dataProvider = new AssetDataRouter(new GloomberbCloudProvider(), [], saved.resources);
        const cli = createTestCliContext({ persistence, dataProvider, config: createDefaultConfig("fixture") });
        Object.assign(cli.context, { plugins: getLoadablePlugins() });
        await runPaneFunction(["QQ", "QQQ"], cli.context);
        return (cli.printed[0]?.result.data.rows as Array<{ feed: string }>)[0]?.feed;
      };
    };
    try {
      const pro = profile();
      expect(await pro(null)).toBe("delayed");
      expect(await pro("pro-fixture")).toBe("live");
      expect(reads.splice(0)).toEqual(["signed out", "pro-fixture"]);

      // A free account's own delayed copy answers it again: it is read once after the signed-out copy, not every time.
      const free = profile();
      expect(await free(null)).toBe("delayed");
      expect(await free("free-fixture")).toBe("delayed");
      expect(await free("free-fixture")).toBe("delayed");
      expect(reads).toEqual(["signed out", "free-fixture"]);
    } finally {
      apiClient.setSessionToken(initialToken);
      setCloudApiFetchTransport(null);
      setSystemTime();
      if (previous === undefined) delete process.env.GLOOMBERB_SESSION_TOKEN;
      else process.env.GLOOMBERB_SESSION_TOKEN = previous;
    }
  });

  test("prefers GLOOMBERB_SESSION_TOKEN over persisted state so containers can authenticate", () => {
    const context = {
      persistence: {
        pluginState: {
          get: () => ({ value: { sessionToken: "persisted-token" } }),
        },
      },
    } as unknown as Parameters<typeof resolvePersistedCloudSessionToken>[0];

    const previous = process.env.GLOOMBERB_SESSION_TOKEN;
    try {
      process.env.GLOOMBERB_SESSION_TOKEN = "env-token";
      expect(resolvePersistedCloudSessionToken(context)).toBe("env-token");
      delete process.env.GLOOMBERB_SESSION_TOKEN;
      expect(resolvePersistedCloudSessionToken(context)).toBe("persisted-token");
    } finally {
      if (previous === undefined) delete process.env.GLOOMBERB_SESSION_TOKEN;
      else process.env.GLOOMBERB_SESSION_TOKEN = previous;
    }
  });
});
