import { afterEach, describe, expect, test } from "bun:test";
import { attachChatCommands, cachedChatFunctions, resolveChatCommand, runChatCommand } from "./commands";
import { TEST_FUNCTIONS, testFunctionSource } from "./test-fixture";

const queryOf = (text: string) => resolveChatCommand(text, TEST_FUNCTIONS)?.query ?? null;

describe("resolveChatCommand", () => {
  test("a function written as the command bar takes it is the text the bar runs", () => {
    expect(queryOf("NI CRYPTO")).toBe("NI CRYPTO");
    expect(queryOf("NI")).toBe("NI");
    expect(queryOf("CRYP")).toBe("CRYP");
    expect(queryOf(" DES   AAPL ")).toBe("DES AAPL");
    expect(queryOf("T AAPL")).toBe("T AAPL");
    expect(queryOf("DES BRK.B")).toBe("DES BRK.B");
    expect(queryOf("GP SMSN:LSE")).toBe("GP SMSN:LSE");
    expect(queryOf("CMP AAPL, MSFT")).toBe("CMP AAPL, MSFT");
    expect(queryOf("FH")).toBe("FH");
    expect(queryOf("HELP OMON")).toBe("HELP OMON");
    // Free text alone opens the function empty; it is only text after the code that it acts on.
    expect(queryOf("ASK")).toBe("ASK");
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
      // An argument only a function that takes one accepts, and only what it takes.
      "CRYP BTC",
      "GP nvda",
      "GP is great",
      "GP 100",
      "GP NVDA AMD",
      "NI SOMETHING",
      "HELP me please",
      // Free text is what a function may act on as it opens (ask it, start it): never from a message.
      "ASK what moved NVDA",
      "ASK NVDA",
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

  test("marks that cannot be seen are dropped, so the chip shows all it runs", () => {
    // Drawn as "DES AAPL" right to left, it runs and shows LPAA.
    expect(queryOf("DES \u202eLPAA")).toBe("DES LPAA");
    expect(queryOf("N\u200bI CRYPTO")).toBe("NI CRYPTO");
  });
});

describe("the functions a message can name", () => {
  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
  });

  test("are built again when a code changes hands or a plugin is switched off, though no count changes", () => {
    const source = testFunctionSource();
    expect(cachedChatFunctions(source).has("CRYP")).toBe(true);
    expect(cachedChatFunctions(source)).toBe(cachedChatFunctions(source));
    // A plugin swapped in place: the same number of commands, one now on CRYP.
    source.commands.set("broker-buy", { ...source.commands.get("broker-buy")!, shortcut: "CRYP" });
    expect(cachedChatFunctions(source).has("CRYP")).toBe(false);
    source.commands.set("broker-buy", { ...source.commands.get("broker-buy")!, shortcut: "BUY" });
    expect(cachedChatFunctions(source).has("CRYP")).toBe(true);
    const off = { ...source, disabledPlugins: ["crypto"], isTemplateOff: (id: string) => id === "crypto-board-pane" };
    expect(cachedChatFunctions(off).has("CRYP")).toBe(false);
  });

  test("a function is written with a code that chips alone, never one the bar runs as a command", () => {
    expect(TEST_FUNCTIONS.get("WTCH")?.code).toBe("WTCH");
    expect(TEST_FUNCTIONS.get("FH")?.code).toBe("FH");
  });

  test("a chip runs only what is still a function when it is clicked", () => {
    const source = testFunctionSource();
    const ran: string[] = [];
    detach = attachChatCommands({ functions: () => cachedChatFunctions(source), run: (query) => ran.push(query) });
    runChatCommand("CRYP");
    source.commands.set("broker-buy", { ...source.commands.get("broker-buy")!, shortcut: "CRYP" });
    runChatCommand("CRYP");
    runChatCommand("ASK what moved NVDA");
    expect(ran).toEqual(["CRYP"]);
  });
});
