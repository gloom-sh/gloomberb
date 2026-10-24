import { describe, expect, test } from "bun:test";
import { resolveChatCommand } from "./commands";
import { TEST_FUNCTIONS } from "./test-fixture";

const queryOf = (text: string) => resolveChatCommand(text, TEST_FUNCTIONS)?.query ?? null;

describe("resolveChatCommand", () => {
  test("a function written as the command bar takes it is the text the bar runs", () => {
    expect(queryOf("NI CRYPTO")).toBe("NI CRYPTO");
    expect(queryOf("NI")).toBe("NI");
    expect(queryOf("CRYP")).toBe("CRYP");
    expect(queryOf(" DES   AAPL ")).toBe("DES AAPL");
    expect(queryOf("T AAPL")).toBe("T AAPL");
    expect(queryOf("FH")).toBe("FH");
    expect(queryOf("HELP OMON")).toBe("HELP OMON");
    expect(resolveChatCommand("NI CRYPTO", TEST_FUNCTIONS)?.fn.name).toBe("Topic News");
    expect(resolveChatCommand("T AAPL", TEST_FUNCTIONS)?.fn.name).toBe("Description");
  });

  test("anything else stays code", () => {
    for (const text of [
      "not a function",
      "config.json",
      // Lower case is a key or a word, and one letter alone is more often the key than the function.
      "des aapl",
      "n",
      "N",
      "T",
      // An argument only a function that takes one accepts.
      "CRYP BTC",
      // Commands that change settings or data, and a pane code such a command shadows.
      "AW AAPL",
      "AW",
      "TH paper",
      "BUY AAPL",
      "ZZZZ AAPL",
      `DES ${"A".repeat(60)}`,
      "",
    ]) {
      expect([text, queryOf(text)]).toEqual([text, null]);
    }
  });
});
