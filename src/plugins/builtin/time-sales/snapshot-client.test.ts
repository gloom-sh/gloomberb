import { expect, test } from "bun:test";
import { createSnapshotTapeClient } from "./snapshot-client";
import { tapeFixture } from "./test-fixture";

test("captured tape preserves exact source stamps and IDs without opening a live subscription", async () => {
  const data=tapeFixture();
  data.trades[0]!.id="18446744073709551615";
  const stamp=data.trades[0]!.timestamp;
  let calls=0;
  const client=createSnapshotTapeClient([["AAPL","NASDAQ",data]],async()=>{calls++;throw new Error("Unexpected live request");});
  const unsubscribe=client.subscribeTape("AAPL","NASDAQ",()=>{throw new Error("Unexpected socket event");});
  const result=await client.getCloudTape("aapl","XNAS");
  expect(result.trades[0]!.id).toBe("18446744073709551615");
  expect(result.trades[0]!.timestamp).toBe(stamp);
  expect(result.feed).toBe(data.feed);
  expect(calls).toBe(0);
  unsubscribe();
});
test("a different listing uses the Bun bootstrap and an aborted fallback cannot deliver a stale snapshot", async () => {
  const data=tapeFixture();
  const calls:string[]=[];
  const client=createSnapshotTapeClient([["AAPL","NASDAQ",data]],async(symbol,exchange)=>{
    calls.push(`${exchange}:${symbol}`);
    return {...data,symbol,exchange};
  });
  expect((await client.getCloudTape("AAPL","NYSE")).exchange).toBe("NYSE");
  expect(calls).toEqual(["NYSE:AAPL"]);
  const controller=new AbortController();
  const aborting=createSnapshotTapeClient([],async()=>{controller.abort();return data;});
  await expect(aborting.getCloudTape("AAPL","NASDAQ",controller.signal)).rejects.toThrow();
});
