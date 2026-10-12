import { join } from "path";
import { createDefaultConfig, cloneLayout } from "../../src/types/config";
import { buildPriceChartPreset } from "../../src/plugins/builtin/chart-composer/presets";

/** Invented data only. No request is forwarded to a real service. Also used by the terminal smoke. */
export function shareFixtureConfig(dataDir: string) {
  const config = createDefaultConfig(dataDir);
  const layout = {
    dockRoot: { kind: "pane" as const, instanceId: "chart:share" },
    instances: [{ instanceId: "chart:share", paneId: "chart-composer", title: "G EXAMPLE", binding: { kind: "fixed" as const, symbol: "EXAMPLE" },
      settings: { chartSpec: buildPriceChartPreset("EXAMPLE") } }],
    floating: [], detached: [],
  };
  return { ...config, onboardingComplete: true, telemetry: { crashReports: false, usage: false, attention: false },
    layout, layouts: [{ name: "Share check", layout: cloneLayout(layout), focusedPaneId: "chart:share" }], activeLayoutIndex: 0 };
}

export function startShareServer(root: string) {
  const shares: unknown[] = [];
  const messages: Array<Record<string, unknown>> = [];
  const uploads: Uint8Array[] = [];
  const requests: string[] = [];
  const user = { id: "share-fixture", email: "reader@example.invalid", emailVerified: true, name: "Example Reader", username: "example", displayName: "Example Reader", plan: "pro" };
  const channels = [{ id: "everyone", name: "everyone", kind: "public", created_at: "2026-01-01T00:00:00Z" }];
  const quote = { symbol: "EXAMPLE", name: "Example Company", price: 104, previousClose: 102, change: 2, changePercent: 1.96, currency: "USD", exchange: "NASDAQ", marketCap: 1e9, timestamp: Date.now(), type: "Common Stock" };
  const history = Array.from({ length: 260 }, (_, i) => {
    const close = 80 + i / 10 + Math.sin(i / 8) * 3;
    return { date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), open: close - 1, high: close + 2, low: close - 2, close, volume: 100000 + i * 100 };
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api(?=\/)/, "");
    const json = (data: unknown) => Response.json(data);
    if (url.pathname.startsWith("/api/") || !url.pathname.includes(".") && url.pathname !== "/") {
      requests.push(`${request.method} ${path}`);
      if (path === "/auth/get-session") return Response.json({ user, session: { id: "invented" } }, { headers: { "Set-Cookie": "gloomberb.session_token=stand-in-only; Path=/; HttpOnly; SameSite=Lax" } });
      if (path === "/chat/channels") return json(channels);
      if (path === "/chat/state") return json({ channels: channels.map(channel => ({ channel, unreadCount: 0, mentionCount: 0, notificationsEnabled: true })), notifications: [] });
      if (path === "/chat/presence") return json({ onlineCount: 1 });
      if (path.endsWith("/attachments") && request.method === "POST") {
        const bytes = new Uint8Array(await request.arrayBuffer());
        uploads.push(bytes);
        return json({ id: `img_${uploads.length}`, mime: "image/png", width: 1400, height: 800, size: bytes.length, url: `${url.origin}/fixture-image.png` });
      }
      if (path.endsWith("/messages")) {
        if (request.method === "POST") {
          const body = await request.json() as Record<string, unknown>;
          const message = { ...body, id: `m${messages.length + 1}`, channelId: "everyone", user, createdAt: new Date().toISOString(), replyToId: null, attachments: [] };
          messages.push(message);
          return json(message);
        }
        return json(messages);
      }
      if (path === "/shares" && request.method === "POST") {
        shares.push(await request.json());
        return json({ id: shares.length.toString(16).padStart(32, "a"), expiresAt: "2027-01-01T00:00:00Z" });
      }
      if (/history/.test(path)) return json({ status: "success", data: history, currency: "USD", asOf: "2026-10-12T00:00:00Z" });
      if (/financials|quote/.test(path)) return json({ status: "success", data: { ...quote, quote } });
      if (/search|symbol/.test(path)) return json([{ ...quote, ticker: "EXAMPLE" }]);
      if (path === "/theses") return json({ items: [] });
      if (/sync/.test(path)) return json({});
      if (/session|account|subscription/.test(path)) return json({ user, plan: "pro" });
      return json([]);
    }
    if (url.pathname === "/fixture-image.png" && uploads[0]) return new Response(new Uint8Array(uploads[0]).buffer, { headers: { "Content-Type": "image/png" } });
    const file = Bun.file(join(root, "dist/web", url.pathname === "/" ? "index.html" : url.pathname.slice(1)));
    return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
  } });
  return { server, url: `http://127.0.0.1:${server.port}`, shares, messages, uploads, requests };
}
