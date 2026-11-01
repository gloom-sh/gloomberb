import { expect, setSystemTime, test } from "bun:test";
import { BATCH_ROUTE_REPROBE_MS } from "./coalesce";
import { CloudDataApi } from "./data";
import { ApiRequestError } from "./errors";

/** Asked with others, as a board asks its rows. */
const BATCH = { batch: true };
const bars = (close: number) => ({ status: "success", data: [{ date: "2026-10-30", close }] });

/** A data API whose service answers each request through `answer`, a thrown error for an Error. */
function service(answer: (path: string, body: any) => unknown) {
  const asked: Array<{ path: string; body?: any }> = [];
  const api = new CloudDataApi((async (path: string, options?: { body?: string }) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    asked.push({ path, ...(body ? { body } : {}) });
    const reply = answer(path, body);
    if (reply instanceof Error) throw reply;
    return structuredClone(reply);
  }) as never, 0);
  return { api, asked };
}

// Seventy-odd board rows each asked for their terms and their bars, once a request apiece.
test("reads asked with others in the same moment go out in batches, each answered as its own request would be", async () => {
  const { api, asked } = service((path, body) => {
    if (path.startsWith("/cloud/futures/contracts?")) {
      const symbols = new URLSearchParams(path.split("?")[1]).get("symbols")!.split(",");
      if (new Set(symbols).size !== symbols.length) throw new Error("the server answers each symbol once");
      return { items: symbols.map((symbol) => symbol === "XXZ26"
        ? { symbol, terms: null }
        : symbol === "BADZ26" ? { symbol, terms: null, error: "Futures terms are temporarily unavailable" } : { symbol, terms: { symbol, root: symbol.slice(0, 2) } }) };
    }
    if (path.startsWith("/cloud/futures/contract/")) return { symbol: decodeURIComponent(path.split("/").pop()!), root: "XX" };
    if (path.startsWith("/market/history?symbol=YMZ26")) return bars(99);
    if (path === "/market/history/batch") return { status: "success", data: { items: body.targets.map(({ symbol }: { symbol: string }) => bars(Number(symbol.slice(1, -3)))) } };
    throw new Error(`unexpected ${path}`);
  });
  const symbols = Array.from({ length: 70 }, (_, index) => `C${index}Z26`);
  const [twice, terms, unknown, failed, histories, dated, alone, aloneTerms] = await Promise.all([
    // Another pane asking for a row's terms in the same moment: the server answers each symbol once.
    api.getCloudFuturesContract(symbols[0]!, BATCH),
    Promise.all(symbols.map((symbol) => api.getCloudFuturesContract(symbol, BATCH))),
    api.getCloudFuturesContract("XXZ26", BATCH).catch((error: unknown) => error),
    api.getCloudFuturesContract("BADZ26", BATCH),
    Promise.all(symbols.map((symbol) => api.getCloudHistory(symbol, "NYM", { interval: "1day", outputsize: 366, rangeKey: "1Y" }, BATCH))),
    // Its own window: asked on its own.
    api.getCloudHistory("ES", "", { interval: "1day", startDate: "2026-01-01", endDate: "2026-02-01" }, BATCH).catch(() => null),
    // Not asked with others (a chart, a quote's unit): on its own, as before.
    api.getCloudHistory("YMZ26", "CBT", { interval: "1day", outputsize: 366, rangeKey: "1Y" }),
    api.getCloudFuturesContract("YM=F"),
  ]);
  expect(terms.map((item) => item.symbol)).toEqual(symbols);
  expect(twice.symbol).toBe(symbols[0]);
  // A symbol without known terms fails as its own request does; one the batch failed is asked on its own.
  expect(unknown).toBeInstanceOf(ApiRequestError);
  expect((unknown as ApiRequestError).status).toBe(404);
  expect(failed.symbol).toBe("BADZ26");
  expect(histories.map((history) => history.data?.[0]?.close)).toEqual(symbols.map((_, index) => index));
  expect(dated).toBeNull();
  expect([alone.data?.[0]?.close, aloneTerms.symbol]).toEqual([99, "YM=F"]);
  // Sixteen a request, side by side.
  const history = asked.filter((request) => request.path === "/market/history/batch");
  expect(history.map((request) => request.body.targets.length)).toEqual([16, 16, 16, 16, 6]);
  expect(history.flatMap((request) => request.body.targets)).toEqual(symbols.map((symbol) => ({ symbol, exchange: "NYM" })));
  expect(history[0]!.body).toMatchObject({ interval: "1day", outputsize: "366", rangeKey: "1Y" });
  const paths = asked.map((request) => request.path.split("?")[0]);
  expect(paths.filter((path) => path === "/cloud/futures/contracts")).toHaveLength(5);
  expect(paths.filter((path) => path !== "/cloud/futures/contracts" && path !== "/market/history/batch").sort())
    .toEqual(["/cloud/futures/contract/BADZ26", "/cloud/futures/contract/YM%3DF", "/market/history", "/market/history"]);
});

// The app updates before the service does, or reaches an instance a deploy has not replaced yet: a 404 batch route is a
// service without it for now.
test("against a service without the batch route, reads go one at a time, a few at once, until the route is asked again", async () => {
  let running = 0;
  let most = 0;
  const { api, asked } = service((path) => {
    if (path.startsWith("/market/options/batch")) return new ApiRequestError("Not found", 404);
    return { status: "success", data: { expirationDates: [], calls: [], puts: [] } };
  });
  const request = (api as unknown as { request: (path: string) => Promise<unknown> }).request;
  (api as unknown as { request: (path: string) => Promise<unknown> }).request = async (path) => {
    const single = !path.startsWith("/market/options/batch");
    if (single) running += 1;
    most = Math.max(most, running);
    try {
      await Bun.sleep(2);
      return await request(path);
    } finally {
      if (single) running -= 1;
    }
  };
  const expiries = Array.from({ length: 18 }, (_, index) => 1_790_000_000 + index * 86_400);
  const started = Date.now();
  try {
    await Promise.all(expiries.map((expiry) => api.getCloudOptionsChain("AAPL", "NASDAQ", expiry, BATCH)));
    expect(api.batchesReads("options")).toBe(false);
    await Promise.all(expiries.slice(0, 6).map((expiry) => api.getCloudOptionsChain("MSFT", "NASDAQ", expiry, BATCH)));
    const paths = () => asked.map((item) => item.path.split("?")[0]);
    // AAPL's eighteen went out as three batches of six at once; MSFT's are not batched again.
    expect(paths().filter((path) => path === "/market/options/batch")).toHaveLength(3);
    expect(paths().filter((path) => path === "/market/options")).toHaveLength(24);
    expect(most).toBe(4);
    // Once the service may have the route, it is asked again.
    setSystemTime(new Date(started + BATCH_ROUTE_REPROBE_MS + 60_000));
    expect(api.batchesReads("options")).toBe(true);
    await Promise.all(expiries.slice(0, 6).map((expiry) => api.getCloudOptionsChain("NVDA", "NASDAQ", expiry, BATCH)));
    expect(paths().filter((path) => path === "/market/options/batch")).toHaveLength(4);
  } finally {
    setSystemTime();
  }
});

// A batch the service refused for load is not asked again as sixteen requests.
test("a batch failed by a rate limit, an overloaded service or no answer fails its reads with that error, and none is asked alone", async () => {
  for (const failure of [new ApiRequestError("Too many requests", 429), new ApiRequestError("Service unavailable", 503), new Error("socket hang up")]) {
    const { api, asked } = service((path) => path.startsWith("/market/options/batch") || path.startsWith("/cloud/futures/contracts?")
      ? failure
      : new Error(`unexpected ${path}`));
    const expiries = Array.from({ length: 6 }, (_, index) => 1_790_000_000 + index * 86_400);
    const outcomes = await Promise.all([
      ...expiries.map((expiry) => api.getCloudOptionsChain("AAPL", "NASDAQ", expiry, BATCH).catch((error: unknown) => error)),
      ...["CLZ26", "GCZ26"].map((symbol) => api.getCloudFuturesContract(symbol, BATCH).catch((error: unknown) => error)),
    ]);
    expect(outcomes.every((outcome) => outcome === failure)).toBe(true);
    expect(asked.map((request) => request.path.split("?")[0]).sort()).toEqual(["/cloud/futures/contracts", "/market/options/batch"]);
    // Still batching: the route is there, it was the load.
    expect(api.batchesReads("options")).toBe(true);
  }
});

test("a history batch asks a listing asked twice once, and an answer that does not line up with its targets is not matched by place", async () => {
  let short = false;
  const { api, asked } = service((path, body) => {
    if (path === "/market/history/batch") {
      const items = body.targets.map(({ symbol }: { symbol: string }) => bars(symbol === "ESZ26" ? 1 : 2));
      return { status: "success", data: { items: short ? items.slice(1) : items } };
    }
    if (path.startsWith("/market/history?")) return bars(new URLSearchParams(path.split("?")[1]).get("symbol") === "ESZ26" ? 1 : 2);
    throw new Error(`unexpected ${path}`);
  });
  const read = (symbol: string) => api.getCloudHistory(symbol, "CME", { interval: "1day", outputsize: 366, rangeKey: "1Y" }, BATCH).then((history) => history.data?.[0]?.close);
  expect(await Promise.all([read("ESZ26"), read("NQZ26"), read("ESZ26")])).toEqual([1, 2, 1]);
  expect(asked.map((request) => request.body?.targets)).toEqual([[{ symbol: "ESZ26", exchange: "CME" }, { symbol: "NQZ26", exchange: "CME" }]]);
  // One item short: each read is asked on its own rather than given its neighbour's bars.
  short = true;
  expect(await Promise.all([read("ESZ26"), read("NQZ26")])).toEqual([1, 2]);
  expect(asked.slice(1).map((request) => request.path.split("?")[0]).sort()).toEqual(["/market/history", "/market/history", "/market/history/batch"]);
});
