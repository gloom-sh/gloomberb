import { expect, test } from "bun:test";
import { CloudDataApi } from "./data";
import { ApiRequestError } from "./errors";

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
test("reads asked in the same moment go out as one batch, each answered as its own request would be", async () => {
  const { api, asked } = service((path, body) => {
    if (path.startsWith("/cloud/futures/contracts?")) {
      const symbols = new URLSearchParams(path.split("?")[1]).get("symbols")!.split(",");
      if (new Set(symbols).size !== symbols.length) throw new Error("the server answers each symbol once");
      return { items: symbols.map((symbol) => symbol === "XXZ26"
        ? { symbol, terms: null }
        : symbol === "BADZ26" ? { symbol, terms: null, error: "Futures terms are temporarily unavailable" } : { symbol, terms: { symbol, root: symbol.slice(0, 2) } }) };
    }
    if (path.startsWith("/cloud/futures/contract/BADZ26")) return { symbol: "BADZ26", root: "BA" };
    if (path === "/market/history/batch") return { status: "success", data: { items: body.targets.map(({ symbol }: { symbol: string }) => bars(Number(symbol.slice(1, -3)))) } };
    throw new Error(`unexpected ${path}`);
  });
  const symbols = Array.from({ length: 70 }, (_, index) => `C${index}Z26`);
  const [twice, terms, unknown, failed, histories, dated] = await Promise.all([
    // Another pane asking for a row's terms in the same moment: the server answers each symbol once.
    api.getCloudFuturesContract(symbols[0]!),
    Promise.all(symbols.map((symbol) => api.getCloudFuturesContract(symbol))),
    api.getCloudFuturesContract("XXZ26").catch((error: unknown) => error),
    api.getCloudFuturesContract("BADZ26"),
    Promise.all(symbols.map((symbol) => api.getCloudHistory(symbol, "NYM", { interval: "1day", outputsize: 366, rangeKey: "1Y" }))),
    // Its own window: asked on its own.
    api.getCloudHistory("ES", "", { interval: "1day", startDate: "2026-01-01", endDate: "2026-02-01" }).catch(() => null),
  ]);
  expect(terms.map((item) => item.symbol)).toEqual(symbols);
  expect(twice.symbol).toBe(symbols[0]);
  // A symbol without known terms fails as its own request does; one the batch failed is asked on its own.
  expect(unknown).toBeInstanceOf(ApiRequestError);
  expect((unknown as ApiRequestError).status).toBe(404);
  expect(failed.symbol).toBe("BADZ26");
  expect(histories.map((history) => history.data?.[0]?.close)).toEqual(symbols.map((_, index) => index));
  expect(dated).toBeNull();
  // Sixteen a request, side by side.
  const history = asked.filter((request) => request.path === "/market/history/batch");
  expect(history.map((request) => request.body.targets.length)).toEqual([16, 16, 16, 16, 6]);
  expect(history.flatMap((request) => request.body.targets)).toEqual(symbols.map((symbol) => ({ symbol, exchange: "NYM" })));
  expect(history[0]!.body).toMatchObject({ interval: "1day", outputsize: "366", rangeKey: "1Y" });
  const paths = asked.map((request) => request.path.split("?")[0]);
  expect(paths.filter((path) => path === "/cloud/futures/contracts")).toHaveLength(5);
  expect(paths.filter((path) => path !== "/cloud/futures/contracts" && path !== "/market/history/batch").sort())
    .toEqual(["/cloud/futures/contract/BADZ26", "/market/history"]);
});

// The app updates before the service does; a 404 batch route is a service without it.
test("against a service without the batch route, reads go one at a time, a few at once, and the route is not asked again", async () => {
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
  await Promise.all(expiries.map((expiry) => api.getCloudOptionsChain("AAPL", "NASDAQ", expiry)));
  await Promise.all(expiries.slice(0, 6).map((expiry) => api.getCloudOptionsChain("MSFT", "NASDAQ", expiry)));
  const paths = asked.map((item) => item.path.split("?")[0]);
  // AAPL's eighteen went out as three batches of six at once; MSFT's are not batched again.
  expect(paths.filter((path) => path === "/market/options/batch")).toHaveLength(3);
  expect(paths.filter((path) => path === "/market/options")).toHaveLength(24);
  expect(most).toBe(4);
});
