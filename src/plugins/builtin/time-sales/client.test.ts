import { expect, test } from "bun:test";
import { ApiRequestError, parseApiErrorDetails, parseApiErrorMessage } from "../../../api-client/errors";
import { fetchTape } from "./client";

/** The error the request layer raises for a 400 whose body is an unavailable snapshot: its words, and the body parsed. */
const refused = (body: string) => new ApiRequestError(parseApiErrorMessage(body), 400, undefined, undefined, parseApiErrorDetails(body));

test("a rejected tape request shows its stated reason, and a venue found by its long name is asked by its code", async () => {
  const asked: string[] = [];
  const client = {
    getCloudTape: async (symbol: string, exchange: string) => {
      asked.push(exchange);
      throw refused(JSON.stringify({ symbol: `${symbol}:${exchange}`, status: "unavailable", gaps: ["A US equity symbol is required"] }));
    },
  };
  await expect(fetchTape("SPY", "NYSEARCA", undefined, client)).rejects.toThrow("A US equity symbol is required");
  expect(asked).toEqual(["ARCA"]);
  const bare = { getCloudTape: async () => { throw refused("Bad Gateway"); } };
  await expect(fetchTape("SPY", "ARCA", undefined, bare)).rejects.toThrow("Bad Gateway");
});
