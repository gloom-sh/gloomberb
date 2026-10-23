import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { apiClient } from "../api-client";
import { getLoadablePlugins } from "../plugins/catalog";
import { createDefaultConfig } from "../types/config";
import { paneSchemas } from "../plugins/builtin/chart-composer/headless-schema";
import { commandPointer, commandPointerLeads, exportCommandPointer, knownGapForTicker, knownGapMessage, MUNI_LINE, subMinuteDataMessage, topicPointer } from "./known-gaps";
import type { MarketContext } from "./types";
import { buildSearchReport, searchFunctionsForCli } from "./commands/search";
import { buildPaneCatalogEntries, filterPaneCatalogEntries, renderPaneCatalogReport } from "./pane-functions/catalog";
import { createPaneCatalog } from "./pane-functions/discovery";
import { parsePaneCatalogArgs } from "./pane-functions/options";
import { lookupGlossary } from "./glossary";

beforeEach(() => {
  // Catalog discovery starts chat and instantiates the map's chart templates.
  spyOn(apiClient, "getChannels").mockResolvedValue([]);
  spyOn(apiClient, "geo").mockResolvedValue({ series: [] });
});
afterEach(() => mock.restore());

test("data a name search cannot find is pointed to, with its proxies, by search and catalog, instead of each pointing at the other", () => {
  const gap = "EU carbon (EUA): the auction price is in EPWR, chart CAP:carbon:eua. Traded proxies: CO2:LSE, KRBN.";
  expect(["EUA", "carbon allowances", "EU-ETS", "Carbon"].map(knownGapMessage)).toEqual([gap, gap, gap, gap]);
  expect(knownGapMessage("carbon fiber")).toBeNull();

  const search = buildSearchReport({ query: "carbon allowances", candidates: [] });
  expect(search).toContain(gap);
  expect(search).not.toContain("catalog");
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["EUA"]), lookupGlossary("EUA"), knownGapMessage("EUA"));
  expect(catalog).toContain(gap);
  expect(catalog).toContain("EU Allowance");
  expect(catalog).not.toContain("No functions match");
});

test("freight rates and the Baltic indices are said to be uncovered, naming what is; BDI alone is also a ticker", () => {
  const gap = knownGapMessage("freight")!;
  expect(gap).toStartWith("Baltic indices (BDI, Capesize, Panamax, Supramax) and freight forwards (FFA) are not covered.");
  for (const proxy of ["BDRY", "SBLK", "GNK", "DSX", "fn CHOKE", "news \"dry bulk\""]) expect(gap).toContain(proxy);
  for (const query of ["Baltic Dry", "dry-bulk", "Panamax", "freight rates", "FFA", "BDI", "charter rates"]) expect(knownGapMessage(query), query).toBe(gap);
  // Only the whole query: a company, a sector or a ticker that merely carries the word is not the gap.
  for (const query of ["baltic sea", "freight forwarder stocks", "BDIX", "BDRY", "ocean freight carriers"]) expect(knownGapMessage(query), query).toBeNull();
  expect(knownGapForTicker("BDI")).toBe(gap);
  for (const symbol of ["FFA", "freight", "BDRY", "EUA"]) expect(knownGapForTicker(symbol), symbol).toBeNull();

  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["capesize"]), lookupGlossary("capesize"), knownGapMessage("capesize"));
  expect(catalog).toContain("are not covered");
  expect(catalog).not.toContain("No functions match");
});

test("a topic no function covers is answered with the nearest functions, wherever its words sit in the query", async () => {
  const pointer = topicPointer("defense budget")!;
  expect(pointer.message).toStartWith("defense budget: not in the terminal yet; closest: AWARDS (");
  for (const query of ["Defense spending", "DoD", "us DoD-budget 2027", "military budget"]) expect(topicPointer(query)).toEqual(pointer);
  // One of its words is not the topic: "budget" alone is OSA's flag, "defense" the defense stocks.
  for (const query of ["budget", "defense", "defense stocks", "budget airline"]) expect(topicPointer(query)).toBeNull();
  expect(knownGapMessage("defense budget")).toBe(pointer.message);

  // Every function it names exists, so the pointer cannot rot when one is renamed.
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const tokens = (await buildPaneCatalogEntries(registry, context)).map((entry) => entry.token);
    const freightCodes = [...knownGapMessage("freight")!.matchAll(/\bfn ([A-Z]+)/g)].map((match) => match[1]!);
    expect(freightCodes).toEqual(["CHOKE"]);
    for (const code of [...pointer.codes, ...topicPointer("borrow fee")!.codes, ...freightCodes]) expect(tokens, code).toContain(code);
  } finally {
    registry.destroy();
  }

  // The catalog leads with the note and lists no loose matches beneath it.
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["defense budget"]), lookupGlossary("defense budget"), pointer.message);
  expect(catalog).toContain("defense budget: not in the terminal yet");
  expect(catalog).not.toContain("No functions match");
});

test("a search no ticker answers lists the functions that carry every word, so a task finds its function", async () => {
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const functions = await searchFunctionsForCli("target weights rebalance", getLoadablePlugins(), context);
  expect(functions.map((match) => match.token)).toEqual(["PF"]);
  // PF's own words say what it does with targets, so the list explains the match.
  expect(functions[0]!.description).toMatch(/target weights.*drift.*rebalance/);
  const report = buildSearchReport({ query: "target weights rebalance", candidates: [], functions }).replace(/\x1b\[[0-9;]*m/g, "");
  expect(report).toContain("PF  Collection Pane");
  expect(report).not.toContain("No matches found");
  // Some of the words only: no function carries them all, and the search says so as before.
  expect(await searchFunctionsForCli("rebalance xylophone", getLoadablePlugins(), context)).toEqual([]);
});

test("the basis trade is found by its own words: the futures curve first, then the perpetual that pays its other leg", async () => {
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  expect((await searchFunctionsForCli("basis trade", getLoadablePlugins(), context)).map((match) => match.token)).toEqual(["CTM", "PERP"]);
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["basis", "carry", "contango", "backwardation", "roll", "basis trade"]) {
      const report = renderPaneCatalogReport(filterPaneCatalogEntries(entries, query), parsePaneCatalogArgs([query]), lookupGlossary(query)).replace(/\x1b\[[0-9;]*m/g, "");
      expect(report, query).toMatch(/^CTM\s+Futures Curve/m);
    }
  } finally {
    registry.destroy();
  }
  // Carry has no glossary entry of its own; the basis it names is listed beside the functions.
  expect(renderPaneCatalogReport([], parsePaneCatalogArgs(["carry"]), lookupGlossary("carry"))).toContain("Glossary: Futures basis.");
});

test("securities-lending data is said to be unavailable, with short interest as the nearest data, instead of SI being listed as its source", () => {
  const pointer = topicPointer("borrow fee")!;
  expect(pointer.message).toStartWith("borrow fee, utilization and locate: not available");
  expect(pointer.codes).toEqual(["SI", "SIW", "SIV"]);
  for (const query of ["borrow", "Utilisation", "utilization", "locate", "stock borrow rates", "what is the cost to borrow GME"]) {
    expect(topicPointer(query), query).toEqual(pointer);
  }
  // Words that name another thing alone: a country's capacity utilization is FRED's, and a company can be located.
  for (const query of ["capacity utilization", "locate headquarters", "borrow money", "short interest"]) expect(topicPointer(query), query).toBeNull();
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["borrow fee"]), lookupGlossary("borrow fee"), pointer.message);
  expect(catalog).toContain("not available");
  expect(catalog).not.toContain("No functions match");
});

test("NIM, deposits, CRE and bank are pointed at the Bank section of fundamentals and EQS; bank still lists CBR", async () => {
  const topic = "Bank deposits, uninsured share and CRE / capital: in the Bank section of gloomberb fundamentals <ticker>; "
    + "net interest margin: EQS (NIM%, Pro: gloomberb fn EQS --metric kpiNimPercent)";
  for (const query of ["NIM", "deposits", "CRE", "net interest margin", "JPM NIM", "commercial real estate", "uninsured deposits"]) {
    expect(knownGapMessage(query), query).toBe(topic);
    expect(topicPointer(query)?.codes, query).toEqual(["EQS"]);
  }
  // Credit is not CRE, nor is a margin a bank's margin.
  for (const query of ["credit", "operating margin", "real estate", "central bank"]) expect(topicPointer(query), query).toBeNull();
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["CRE"]), lookupGlossary("CRE"), knownGapMessage("CRE"));
  expect(catalog).toStartWith("Bank deposits, uninsured share and CRE / capital");
  expect(catalog).not.toContain("No functions match");

  const line = "Bank figures (deposits, uninsured share, CRE / capital, lead bank): gloomberb fundamentals <ticker>, Bank section. "
    + "Net interest margin (Pro): gloomberb fn EQS --metric kpiNimPercent";
  for (const query of ["bank", "banks", "bank figures", "bank holding company"]) expect(commandPointer(query), query).toBe(line);
  for (const query of ["central bank", "bank rate", "world bank"]) expect(commandPointer(query), query).toBeNull();
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    const report = renderPaneCatalogReport(filterPaneCatalogEntries(entries, "bank"), parsePaneCatalogArgs(["bank"]), lookupGlossary("bank"), knownGapMessage("bank"), [], commandPointer("bank"))
      .replace(/\x1b\[[0-9;]*m/g, "");
    expect(report).toMatch(/^CBR\s+Central Bank Rates/m);
    expect(report.trimEnd()).toEndWith(line);
  } finally {
    registry.destroy();
  }
});

test("an income or reinvestment query names portfolio show --drip; a statement or margin query does not", () => {
  const line = "Portfolio income, yield and DRIP projection: gloomberb portfolio show <name> --drip";
  for (const query of ["drip", "DRIP projection", "reinvest", "dividend reinvestment", "dividend income", "my portfolio income"]) {
    expect(commandPointer(query), query).toBe(line);
  }
  for (const query of ["income statement", "net income", "fixed income", "dark pool"]) expect(commandPointer(query), query).toBeNull();
  expect(commandPointer("light theme")).toBe("Themes: gloomberb config themes");
});

test("a stablecoin word names CRYP's stablecoin list, ahead of the FX series its letters start; a PEG ratio does not", () => {
  const line = "Stablecoins against their peg, off peg in bp, 24h low and high: gloomberb fn CRYP --list stablecoin";
  for (const query of ["tether", "USDT", "usdc", "depeg", "peg", "USDC peg", "stablecoin depeg check"]) expect(commandPointer(query), query).toBe(line);
  expect(commandPointer("peg ratio")).toBeNull();
  const series = [{ id: "fx:twd", name: "Taiwan dollar (TWD per USD)", unit: "TWD", frequency: "daily", publisher: "FRED", expression: "FRED:DEXTAUS", exact: false }];
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["usdt"]), lookupGlossary("usdt"), null, series, commandPointer("usdt"));
  expect(catalog.indexOf(line)).toBe(0);
  expect(catalog).toContain("Taiwan dollar");
});

test("DeFi words find CRYP and name its DeFi list; exchange reserves are said plainly to be uncovered", async () => {
  const line = "DeFi TVL, top protocols and chains with 7D and 30D change: gloomberb fn CRYP --list defi (by chain: --by chain)";
  for (const query of ["defi", "TVL", "on-chain", "onchain", "on chain", "aave", "Aave TVL", "total value locked", "defi tvl by chain"]) {
    expect(commandPointer(query), query).toBe(line);
  }
  // A chain alone is an option chain's, a supply chain is not on one.
  for (const query of ["chain", "supply chain", "options chain"]) expect(commandPointer(query), query).toBeNull();

  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["defi", "tvl", "on-chain", "aave"]) {
      expect(filterPaneCatalogEntries(entries, query).map((entry) => entry.token)[0], query).toBe("CRYP");
    }
  } finally {
    registry.destroy();
  }

  const gap = topicPointer("exchange reserves")!;
  expect(gap.message).toBe("Crypto exchange reserves and exchange flows: not covered (no source for coins held on exchanges); "
    + "closest: CRYP (DeFi TVL by protocol and chain: gloomberb fn CRYP --list defi; stablecoin supply: --list stablecoin)");
  for (const query of ["Exchange Reserves", "BTC exchange reserves", "bitcoin exchange reserves", "exchange inflows", "exchange netflows"]) {
    expect(knownGapMessage(query), query).toBe(gap.message);
  }
  // A central bank's reserves and an exchange on its own are other things.
  for (const query of ["foreign exchange reserves", "exchange", "reserves"]) expect(topicPointer(query), query).toBeNull();
  expect(buildSearchReport({ query: "exchange reserves", candidates: [] })).toContain(gap.message);
  const catalog = renderPaneCatalogReport([], parsePaneCatalogArgs(["exchange reserves"]), lookupGlossary("exchange reserves"), gap.message);
  expect(catalog).toContain("not covered");
  expect(catalog).not.toContain("Matches for");
});

test("export, csv and json name the --csv and --json flags with one example, ahead of what the words find; trade exports do not", async () => {
  const line = "Export: add --csv or --json to any command to print its result as CSV or JSON, e.g. gloomberb history LMT --csv > lmt.csv";
  for (const query of ["export", "csv", "JSON", "export data", "export to excel", "save as csv"]) {
    expect(commandPointer(query), query).toBe(line);
    expect(commandPointerLeads(query), query).toBe(true);
  }
  for (const query of ["exports", "crude exports", "export prices", "light theme"]) expect(commandPointerLeads(query), query).toBe(false);
  expect(commandPointer("crude exports")).toBeNull();
  // `gloomberb export LMT` runs the example on the symbol typed; another unknown word gets no export line.
  expect(exportCommandPointer("export", ["LMT"])).toBe(line);
  expect(exportCommandPointer("export", ["BRK.B", "--json"])).toContain("gloomberb history BRK.B --csv > brk-b.csv");
  expect(exportCommandPointer("comps", ["LMT"])).toBeNull();
  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    // CDS mentions --csv in its description; the flag is what `catalog csv` asks about, so it comes first.
    const entries = filterPaneCatalogEntries(await buildPaneCatalogEntries(registry, context), "csv");
    const report = renderPaneCatalogReport(entries, parsePaneCatalogArgs(["csv"]), lookupGlossary("csv"), null, [], commandPointer("csv"), commandPointerLeads("csv"));
    expect(report.indexOf(line)).toBe(0);
  } finally {
    registry.destroy();
  }
});

test("an FX forward query names fx --forward; a forward rate, forward guidance, a forward P/E or a forward curve does not", () => {
  const line = "FX forwards implied by both currencies' short rates (covered interest parity), with forward points and the hedge cost: gloomberb fx USD/MXN --forward 30d";
  for (const query of ["forward", "forwards", "fwd", "fx forward", "fx forward rate", "currency forward rates", "USD/MXN forward",
    "forward points", "currency hedge cost forward", "1m fx fwd", "peso forward", "covered interest parity forward"]) {
    expect(commandPointer(query), query).toBe(line);
  }
  // A forward rate, its tenor or its cost is a yield curve's as much as a currency's.
  for (const query of ["forward rate", "forward rates", "implied forward rate", "1y forward rate", "forward interest rates", "1m fwd",
    "forward premium", "forward hedge cost", "forward guidance", "forward P/E", "forward curve", "forward inflation", "forward eps"]) {
    expect(commandPointer(query), query).toBeNull();
  }
});

test("munis point to the muni funds, DVD, fundamentals and --tax-rate, and say plainly there is no AAA muni curve", async () => {
  const line = knownGapMessage("muni")!;
  expect(line).toBe(MUNI_LINE);
  expect(line).toStartWith("Municipal bonds: no AAA muni curve (MMD and BVAL are licensed).");
  for (const pointer of ["MUB", "VTEB", "TFI", "SUB", "CMF", "NYF", "gloomberb fn DVD <fund>", "gloomberb fundamentals <fund>", "--tax-rate 40.8", "--state-rate"]) {
    expect(line, pointer).toContain(pointer);
  }
  for (const query of ["muni", "Munis", "municipal", "municipal bonds", "tax-exempt", "Tax Exempt", "tax equivalent", "tax-equivalent yield", "TEY",
    "AAA muni curve", "MMD", "BVAL", "muni/Treasury ratio"]) expect(knownGapMessage(query), query).toBe(line);
  // Only the whole query: a muni utility or a tax story is not the gap.
  for (const query of ["municipal water", "tax", "exempt", "tax cuts", "MUBS"]) expect(knownGapMessage(query), query).toBeNull();
  expect(buildSearchReport({ query: "muni bonds", candidates: [] })).toContain(line);

  const context = { config: createDefaultConfig("/tmp/known-gaps-test") } as MarketContext;
  const registry = await createPaneCatalog(context, getLoadablePlugins());
  try {
    const entries = await buildPaneCatalogEntries(registry, context);
    for (const query of ["muni", "municipal", "tax-exempt", "tax equivalent"]) {
      const report = renderPaneCatalogReport(filterPaneCatalogEntries(entries, query), parsePaneCatalogArgs([query]), lookupGlossary(query), knownGapMessage(query))
        .replace(/\x1b\[[0-9;]*m/g, "");
      expect(report, query).toStartWith("Municipal bonds: no AAA muni curve");
      // DVD is the function, with --tax-rate among its options and examples.
      expect(report, query).toMatch(/^DVD\s+Dividend Yield/m);
      expect(report, query).toContain("gloomberb fn DVD MUB --tax-rate 40.8");
      expect(report, query).not.toContain("No functions match");
    }
    const tey = renderPaneCatalogReport(filterPaneCatalogEntries(entries, "tax equivalent"), parsePaneCatalogArgs(["tax equivalent"]),
      lookupGlossary("tax equivalent"), knownGapMessage("tax equivalent")).replace(/\x1b\[[0-9;]*m/g, "");
    expect(tey).toContain("Tax-equivalent yield (TEY)");
  } finally {
    registry.destroy();
  }
});

test("asked for bars finer than a minute, a US listing is pointed at its trades, a window of them and its quotes; a listing abroad only at its bars", () => {
  const us = subMinuteDataMessage("HYG");
  expect(us).toStartWith("No second or tick bars; 1-minute bars: fn GIP HYG;");
  for (const pointer of ["fn TAS HYG", "--from 10:30 --to 10:35", "fn QR HYG"]) expect(us).toContain(pointer);
  // A listing named abroad by its exchange or suffix has no tape: no trades or quotes are offered.
  for (const symbol of ["RMS.AX", "RMS:ASX", "VOD.L"]) {
    expect(subMinuteDataMessage(symbol), symbol).toBe(`No second or tick bars; 1-minute bars: fn GIP ${symbol}; trades exist for US listings only.`);
  }
  expect(subMinuteDataMessage()).toContain("fn TAS <ticker>");
});

test("asked for bars finer than a minute, a future is told the bars that exist for it and that trades and quotes are US equities only", () => {
  // TAS and QR answer "A US equity symbol is required" for a future, so neither is named.
  const gold = subMinuteDataMessage("GC=F");
  expect(gold).toStartWith("No second or tick bars; 1-minute bars: fn G GC=F --range-preset 1D");
  expect(gold).toContain("history GC=F --range 1D has 5-minute bars");
  expect(gold).toEndWith("Trades and quotes cover US equities only.");
  for (const symbol of ["GC=F", "SI=F:CMX", "CL=F"]) {
    const message = subMinuteDataMessage(symbol);
    expect(message, symbol).not.toMatch(/fn (TAS|QR|GIP)\b/);
    expect(message, symbol).toContain(`fn G ${symbol} --range-preset 1D`);
  }
});

test("GIP's --chartResolution says the same of a sub-minute ask as history does, for the symbol it was given", () => {
  const hint = paneSchemas["graph-intraday-price-pane"].options.find((option) => option.key === "chartResolution")!.invalidValueHint!;
  for (const symbol of ["GC=F", "^GSPC", "HYG", "RMS.AX"]) expect(hint("1s", symbol), symbol).toBe(subMinuteDataMessage(symbol));
  expect(hint("2m", "GC=F")).toBeNull();
});

test("asked for bars finer than a minute, an index, a currency pair or a coin is pointed at its 1-minute bars and no tape", () => {
  for (const symbol of ["^GSPC", "EURUSD=X", "BTC-USD:CCC"]) {
    expect(subMinuteDataMessage(symbol), symbol).toBe(`No second or tick bars; 1-minute bars: fn GIP ${symbol}. Trades and quotes cover US equities only.`);
  }
  // A US listing keeps its trades and quotes, and the explicit kind wins over what the symbol says.
  expect(subMinuteDataMessage("SPY")).toContain("fn TAS SPY");
  expect(subMinuteDataMessage("GC=F", "unknown")).toContain("fn TAS GC=F");
});

test("BDH, BDP, Excel and Sheets lead with the Google Sheets page; an export to Excel is still the export line", () => {
  const sheets = "Spreadsheets: =GLOOM and =GLOOMH in Google Sheets take the tickers and fields of Bloomberg's BDP and BDH (Pro): "
    + "gloom.sh/docs/google-sheets. For Excel, add --csv to any command.";
  for (const query of ["BDH", "bdp", "BDS", "excel", "Excel", "sheets", "google sheets", "bdh formula", "bloomberg excel add-in", "BDP in Google Sheets"]) {
    expect(commandPointer(query), query).toBe(sheets);
    expect(commandPointerLeads(query), query).toBe(true);
  }
  expect(commandPointer("export to excel")).toContain("Export: add --csv or --json");
  for (const query of ["balance sheets", "sheet music"]) expect(commandPointer(query), query).not.toBe(sheets);
});
