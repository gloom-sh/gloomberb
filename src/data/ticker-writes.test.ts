import { describe, expect, test } from "bun:test";
import { createTestTicker } from "../test-support/ticker";
import { AppPersistence } from "./app-persistence";
import { JsonTickerRepository } from "./json-ticker-repository";
import { TickerRepository } from "./ticker-repository";
import { hasPendingTickerWrites, runTickerWrite, settleTickerWrites, tickerWriteRevision } from "./ticker-writes";

describe("ticker writes", () => {
  test("drains acknowledgement-time edits and writes started by their callers", async () => {
    const repository = {};
    const firstAck = Promise.withResolvers<void>();
    const secondAck = Promise.withResolvers<void>();
    const secondStarted = Promise.withResolvers<void>();
    let shares = 1;
    let settled = false;
    const edit = (async () => {
      await runTickerWrite(repository, "AAPL", () => firstAck.promise);
      shares = 9;
      const next = runTickerWrite(repository, "MSFT", () => secondAck.promise);
      secondStarted.resolve();
      await next;
    })();
    const cleanup = settleTickerWrites(repository).then(() => { settled = true; });
    firstAck.resolve();
    await secondStarted.promise;
    expect(shares).toBe(9);
    expect(settled).toBe(false);
    secondAck.resolve();
    await cleanup;
    await edit;
    expect(settled).toBe(true);
  });

  test("a failed acknowledgement does not poison a queued retry or another ticker", async () => {
    const repository = {};
    const acknowledgement = Promise.withResolvers<void>();
    const calls: string[] = [];
    const failed = runTickerWrite(repository, "aapl", () => acknowledgement.promise);
    const retry = runTickerWrite(repository, " AAPL ", () => { calls.push("retry"); });
    const unrelated = runTickerWrite(repository, "MSFT", () => { calls.push("unrelated"); });
    expect(tickerWriteRevision(repository, "AAPL")).toBe(2);
    expect(hasPendingTickerWrites(repository)).toBe(true);
    expect(calls).toEqual(["unrelated"]);
    acknowledgement.reject(new Error("write failed"));
    await expect(failed).rejects.toThrow("write failed");
    await Promise.all([retry, unrelated, settleTickerWrites(repository)]);
    expect(calls).toEqual(["unrelated", "retry"]);
    expect(hasPendingTickerWrites(repository)).toBe(false);
  });

  test("native batches reserve every ticker until the shared transaction finishes", async () => {
    const persistence = new AppPersistence(":memory:");
    try {
      const repository = new TickerRepository(persistence.tickers);
      const acknowledgement = Promise.withResolvers<void>();
      const first = runTickerWrite(repository, "AAPL", () => acknowledgement.promise);
      const aapl = createTestTicker("AAPL", "Apple");
      const msft = createTestTicker("MSFT", "Microsoft");
      const batch = repository.saveTickers([aapl, msft]);
      const edited = { ...msft, metadata: { ...msft.metadata, tags: ["edited"] } };
      const edit = repository.saveTicker(edited);
      expect(tickerWriteRevision(repository, "AAPL")).toBe(2);
      expect(tickerWriteRevision(repository, "MSFT")).toBe(2);
      expect(await repository.loadAllTickers()).toEqual([]);
      acknowledgement.resolve();
      await Promise.all([first, batch, edit, settleTickerWrites(repository)]);
      expect(await repository.loadTicker("AAPL")).toMatchObject(aapl);
      expect(await repository.loadTicker("MSFT")).toMatchObject(edited);
    } finally {
      persistence.close();
    }
  });

  test("browser create, save and delete requests stay ordered behind a pending write", async () => {
    const repository = new JsonTickerRepository();
    const acknowledgement = Promise.withResolvers<void>();
    const first = runTickerWrite(repository, "AAPL", () => acknowledgement.promise);
    const ticker = createTestTicker("AAPL", "Apple");
    const create = repository.createTicker(ticker.metadata);
    const edit = repository.saveTicker({ ...ticker, metadata: { ...ticker.metadata, tags: ["edited"] } });
    const removal = repository.deleteTicker("aapl");
    expect(tickerWriteRevision(repository, "AAPL")).toBe(4);
    expect(await repository.loadTicker("AAPL")).toBeNull();
    acknowledgement.resolve();
    expect(await create).toEqual(ticker);
    await Promise.all([first, edit, removal, settleTickerWrites(repository)]);
    expect(await repository.loadTicker("AAPL")).toBeNull();
  });
});
