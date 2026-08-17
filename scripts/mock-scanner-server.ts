/**
 * Dev-only stand-in for the cloud scanner feed, so HILO and FLOW can be built and
 * smoke-tested before the server branch lands. Never imported by app code.
 *
 * Usage:
 *   bun run scripts/mock-scanner-server.ts &
 *   GLOOMBERB_API_URL=http://localhost:8791 bun run dev
 *
 * Pass --freeze to send one snapshot and stop, which keeps rows stable while
 * checking interactions, --delayed for the free-tier 15m HILO instance (FLOW is
 * then denied), or --anon for the signed-out `auth_required` refusal.
 */
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.MOCK_SCANNER_PORT ?? 8791);
const FREEZE = process.argv.includes("--freeze");
const ANON = process.argv.includes("--anon");
const DELAYED = process.argv.includes("--delayed");
// Free accounts get the delayed HILO instance and no options entitlement at all.
const ACCESS = DELAYED
  ? { access: "delayed" as const, delayMinutes: 15 }
  : { access: "realtime" as const, delayMinutes: 0 };

function denialFor(scanner: Scanner): string | null {
  if (ANON) return "auth_required";
  return DELAYED && scanner === "flow" ? "pro_required" : null;
}

type Scanner = "hilo" | "flow";
type SocketData = { scanners: Set<Scanner> };

const HILO_SYMBOLS = [
  "RKLX", "ASTX", "PM", "AXSM", "NVDA", "SMCI", "CRWV", "PLTR", "HOOD", "SOFI",
  "IONQ", "RGTI", "BBAI", "LUNR", "ACHR", "JOBY", "TSLA", "AMD", "MU", "AVGO",
];
const FLOW_SYMBOLS = ["NVDA", "TSLA", "SPY", "QQQ", "AAPL", "META", "AMD", "MSTR", "PLTR", "COIN"];
const KINDS = ["sweep", "block", "split", "trade"] as const;
const SIDES = ["ask", "bid", "mid", "unknown"] as const;

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

const counts = new Map<string, number>();

function hiloRow(symbol: string) {
  const count = (counts.get(symbol) ?? Math.floor(Math.random() * 40)) + 1;
  counts.set(symbol, count);
  return {
    symbol,
    price: Number((Math.random() * 400 + 0.4).toFixed(4)),
    volume: Math.floor(Math.random() * 900_000),
    count,
    at: Date.now() - Math.floor(Math.random() * 60_000),
  };
}

function hiloPayload() {
  const rows = (n: number) => Array.from({ length: n }, () => hiloRow(pick(HILO_SYMBOLS)))
    .sort((left, right) => right.at - left.at);
  const scale = 0.6 + Math.random() * 0.8;
  return {
    type: "scanner.hilo",
    status: "live",
    ...ACCESS,
    asOf: Date.now(),
    windows: {
      s30: { highs: Math.round(42 * scale), lows: Math.round(11 * scale) },
      m1: { highs: Math.round(118 * scale), lows: Math.round(37 * scale) },
      m5: { highs: Math.round(512 * scale), lows: Math.round(203 * scale) },
    },
    highs: rows(28),
    lows: rows(28),
  };
}

let flowEvents: unknown[] = [];

function flowEvent() {
  const underlying = pick(FLOW_SYMBOLS);
  const right = Math.random() > 0.45 ? "C" : "P";
  const strike = Math.round((Math.random() * 500 + 20) / 5) * 5;
  const size = Math.floor(Math.random() * 4000) + 50;
  const price = Number((Math.random() * 20 + 0.4).toFixed(2));
  const openInterest = Math.floor(Math.random() * 6000) + 1;
  const volume = Math.floor(Math.random() * 20_000);
  const expiryDays = pick([2, 5, 9, 16, 30, 45, 120, 400]);
  const expiry = new Date(Date.now() + expiryDays * 86_400_000).toISOString().slice(0, 10);
  return {
    id: `opt-${Date.now()}-${underlying}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    underlying,
    contract: `${underlying}${expiry.replaceAll("-", "").slice(2)}${right}${String(strike * 1000).padStart(8, "0")}`,
    right,
    strike,
    expiry,
    side: pick(SIDES),
    kind: pick(KINDS),
    size,
    price,
    premium: Math.round(price * size * 100),
    volume,
    openInterest,
    volOi: Number((volume / openInterest).toFixed(2)),
    iv: Number((Math.random() * 1.2).toFixed(2)),
  };
}

function flowPayload(newEvents: number) {
  flowEvents = [...Array.from({ length: newEvents }, flowEvent), ...flowEvents].slice(0, 200);
  return { type: "scanner.flow", status: "live", ...ACCESS, asOf: Date.now(), events: flowEvents };
}

const clients = new Set<ServerWebSocket<SocketData>>();

function broadcast(scanner: Scanner, payload: unknown): void {
  const message = JSON.stringify(payload);
  for (const client of clients) {
    if (client.data.scanners.has(scanner)) client.send(message);
  }
}

const server = Bun.serve<SocketData, never>({
  port: PORT,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    if (url.pathname === "/cloud/ws") {
      if (bunServer.upgrade(request, { data: { scanners: new Set<Scanner>() } })) return undefined;
      return new Response("upgrade failed", { status: 400 });
    }
    for (const scanner of ["hilo", "flow"] as const) {
      if (url.pathname !== `/market/scanner/${scanner}`) continue;
      const reason = denialFor(scanner);
      if (reason) {
        return Response.json({ status: "denied", reason }, { status: reason === "auth_required" ? 401 : 402 });
      }
      const { type: _type, ...rest } = scanner === "hilo" ? hiloPayload() : flowPayload(5);
      return Response.json(rest);
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      ws.send(JSON.stringify(ANON
        ? { type: "ready", user: null }
        : {
          type: "ready",
          user: {
            id: "mock",
            username: "mock",
            emailVerified: true,
            plan: DELAYED ? "free" : "pro",
            effectivePlan: DELAYED ? "free" : "pro",
          },
        }));
    },
    close(ws) {
      clients.delete(ws);
    },
    message(ws, raw) {
      let parsed: any;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      const scanner: Scanner | undefined = parsed?.scanner === "hilo" || parsed?.scanner === "flow"
        ? parsed.scanner
        : undefined;
      if (!scanner) return;
      if (parsed.type === "scanner.subscribe") {
        const reason = denialFor(scanner);
        if (reason) {
          ws.send(JSON.stringify({ type: "scanner.denied", scanner, reason }));
          return;
        }
        ws.data.scanners.add(scanner);
        console.log(`[mock] subscribe ${scanner} (${clients.size} clients)`);
        ws.send(JSON.stringify(scanner === "hilo" ? hiloPayload() : flowPayload(24)));
      } else if (parsed.type === "scanner.unsubscribe") {
        ws.data.scanners.delete(scanner);
        console.log(`[mock] unsubscribe ${scanner}`);
      }
    },
  },
});

if (!FREEZE) {
  setInterval(() => {
    broadcast("hilo", hiloPayload());
    broadcast("flow", flowPayload(2));
  }, 1000);
}

console.log(`[mock] scanner feed on http://localhost:${server.port} (anon=${ANON} delayed=${DELAYED} freeze=${FREEZE})`);
