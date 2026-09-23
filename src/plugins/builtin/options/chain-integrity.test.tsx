import { afterEach, expect, test } from "bun:test";
import { act } from "react";
const source = process.env.CHAIN_SOURCE ?? new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const out = process.env.CHAIN_OUT;
const { Box } = await import(`${source}/src/ui`);
const { PaneFooterBar, PaneFooterProvider } = await import(`${source}/src/components/layout/pane/footer`);
const { testRender, takeSavedTextFile } = await import(`${source}/src/renderers/opentui/test-utils`);
const { exportPaneTable } = await import(`${source}/src/state/pane-table-export-registry`);
const { MarketDataCoordinator, setSharedMarketDataCoordinator } = await import(`${source}/src/market-data/coordinator`);
const { createInitialState } = await import(`${source}/src/state/app/context`);
const { createTestDataProvider } = await import(`${source}/src/test-support/data-provider`);
const { createTestPluginRuntime } = await import(`${source}/src/test-support/plugin-runtime`);
const { TestPaneProvider, createTestTicker, createTestPaneConfig } = await import(`${source}/src/test-support/pane`);
const { OptionsView } = await import(`${source}/src/plugins/builtin/options/view`);
const { draftFromParams } = await import(`${source}/src/plugins/builtin/options-calculator/model`);
const { loadYahooOptionsChain } = await import(`${source}/src/sources/yahoo-finance/options`);
const { serializeCliResult } = await import(`${source}/src/cli/result`);
const { marketDataCliCommands } = await import(`${source}/src/cli/commands/market`);
const EXPIRY = Date.UTC(2028, 0, 21) / 1000;
const NOW = Date.UTC(2026, 8, 17, 16);
const PANE = "options:chain-followup";
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let coordinator: InstanceType<typeof MarketDataCoordinator> | undefined;
const realNow = Date.now;
afterEach(async () => {
    if (setup)
        await act(async () => setup!.renderer.destroy());
    setup = undefined;
    coordinator?.destroy();
    coordinator = undefined;
    setSharedMarketDataCoordinator(null);
    Date.now = realNow;
});
function strikeRowY(strike: number): number {
    return setup!.captureCharFrame().split("\n").findIndex(line => new RegExp(`\\s${strike}\\s`).test(line));
}
async function settle() {
    for (let i = 0; i < 4; i++)
        await act(async () => {
            await new Promise(r => setTimeout(r, 0));
            await setup!.renderOnce();
        });
}
async function fixture(strikes: number[], activity: "full" | "missing" | "zero" = "full", width = 120) {
    Date.now = () => NOW;
    let rows = strikes;
    let callsAvailable = true;
    let failure = false;
    let contractPrefix = "AAPL";
    const requests: string[] = [];
    const launches: any[] = [];
    const scenarios: any[] = [];
    let footerParts: Array<{ text: string; tone?: string }> = [];
    const raw = (strike: number, side: "C" | "P") => ({
        contractSymbol: `${contractPrefix}280121${side}${String(Math.round(strike * 1000)).padStart(8, "0")}`,
        strike, currency: "USD", lastPrice: 8, bid: 9, ask: 11, impliedVolatility: .25,
        volume: activity === "missing" && side === "P" ? null : activity === "zero" && side === "P" ? 0 : 10,
        openInterest: activity === "missing" && side === "C" ? undefined : activity === "zero" && side === "P" ? 0 : 20,
        change: 0, percentChange: 0, inTheMoney: side === "P", expiration: EXPIRY, lastTradeDate: NOW / 1000 - 86400,
    });
    const provider = createTestDataProvider({ getOptionsChain: async (symbol, exchange, expirationDate) => loadYahooOptionsChain({
            ticker: symbol, exchange: exchange ?? "", expirationDate,
            fetchJsonWithCrumb: async (url: string) => {
                requests.push(url);
                if (failure)
                    throw new Error("Controlled chain outage");
                return { optionChain: { result: [{ underlyingSymbol: symbol, expirationDates: [EXPIRY], options: [{ calls: callsAvailable ? rows.map(s => raw(s, "C")) : [], puts: rows.map(s => raw(s, "P")) }] }] } } as any;
            },
        }) });
    coordinator = new MarketDataCoordinator(provider);
    setSharedMarketDataCoordinator(coordinator);
    const ticker = createTestTicker("AAPL", "Apple", { assetCategory: "STK" });
    const config = createTestPaneConfig("/tmp/option-chain-controlled", { instanceId: PANE, paneId: "options", settings: { optionColumnIds: ["bid", "ask", "volume", "openInterest", "iv"] }, binding: { kind: "fixed", symbol: "AAPL" } });
    const state = createInitialState(config);
    state.focusedPaneId = PANE;
    state.tickers = new Map([["AAPL", ticker]]);
    state.financials = new Map([["AAPL", { quote: { symbol: "AAPL", price: strikes[0], currency: "USD", change: 0, changePercent: 0, lastUpdated: NOW, stale: false }, annualStatements: [], quarterlyStatements: [], priceHistory: [] }]]);
    const runtime = createTestPluginRuntime({ createPaneFromTemplate: (id: string, options: any) => {
        if (id === "options-scenario-pane") scenarios.push(options);
        else launches.push(draftFromParams(options?.values));
    } });
    await act(async () => {
        setup = await testRender(<TestPaneProvider state={state} paneId={PANE} pluginId="ticker-research" runtime={runtime}><PaneFooterProvider>{footer => {
            footerParts = footer.info.flatMap(segment => segment.parts);
            return <Box width={width} height={22} flexDirection="column"><Box height={21}><OptionsView width={width} height={21} focused/></Box><PaneFooterBar footer={footer} focused width={width}/></Box>;
        }}</PaneFooterProvider></TestPaneProvider>, { width, height: 22 });
    });
    await settle();
    async function key(name: string) {
        await act(async () => {
            if (name === "enter")
                setup!.mockInput.pressEnter();
            else if (name === "down" || name === "up")
                setup!.mockInput.pressArrow(name);
            else
                setup!.mockInput.pressKey(name);
        });
        await act(async () => {
            await new Promise(r => setTimeout(r, 180));
        });
        await settle();
    }
    async function capture(name: string) {
        const n = launches.length;
        await key("c");
        await exportPaneTable(PANE, `${name}.csv`);
        const csv = takeSavedTextFile()?.text ?? "";
        const frame = setup!.captureCharFrame();
        const result = { source, launch: launches.length > n ? launches.at(-1) : null, csv, frame, footerParts, requests: [...requests] };
        if (out) {
            await Bun.write(`${out}/${width}-${name}.txt`, frame);
            await Bun.write(`${out}/${width}-${name}.csv`, csv);
            await Bun.write(`${out}/${width}-${name}.json`, JSON.stringify(result, null, 2));
        }
        return result;
    }
    async function refresh(next: number[]) {
        rows = next;
        await act(async () => {
            await coordinator!.loadOptions({ instrument: { symbol: "AAPL", exchange: "NASDAQ" }, expirationDate: EXPIRY }, { forceRefresh: true });
        });
        await settle();
    }
    async function cli(name: string) {
        let data: any;
        let renderedRows: any;
        let text = "";
        let json = "";
        await marketDataCliCommands.find(c => c.name === "options")!.execute(["AAPL", "--expiration", String(EXPIRY)], { cliOptions: {}, initMarketData: async () => ({ dataProvider: provider, destroy() {
                }, persistence: { close() {
                    } } }), printResult: (result: any, options: any) => {
                data = result.data;
                renderedRows = options.rows(result.data);
                text = serializeCliResult(result, { format: "text" }, options);
                json = serializeCliResult(result, { format: "json" }, options);
            }, fail: (message: string) => {
                throw new Error(message);
            } } as any);
        const value = { data, rows: renderedRows, text, json };
        if (out) {
            await Bun.write(`${out}/${width}-${name}-cli.json`, JSON.stringify(value, null, 2));
            await Bun.write(`${out}/${width}-${name}-cli.txt`, text);
        }
        return value;
    }
    return { key, capture, refresh, cli, scenario: async () => {
            const count = scenarios.length;
            await key("a");
            return scenarios.length > count ? scenarios.at(-1) : null;
        }, replaceSymbols: () => {
            contractPrefix = "AAPL1";
        }, setCalls: (value: boolean) => {
            callsAvailable = value;
        }, setFailure: (value: boolean) => {
            failure = value;
        } };
}
test.each([48, 80, 120])("keeps the selected strike through insertion, removal and recovery at %i columns", async (width) => {
    const f = await fixture([100, 101, 102], "full", width);
    await act(async () => {
        const y = setup!.captureCharFrame().split("\n").findIndex(line => /\s101\s/.test(line));
        await setup!.mockMouse.click(8, y);
    });
    await settle();
    const picked = await f.capture("strike-selected");
    expect(picked.launch.strike).toBe(101);
    await f.refresh([99, 100, 101, 102]);
    const inserted = await f.capture("strike-inserted");
    expect(inserted.launch.marketReference.contractSymbol).toBe(picked.launch.marketReference.contractSymbol);
    expect(inserted.launch).toMatchObject({ side: "call", strike: 101, marketPrice: 10, marketPriceSource: "mid" });
    await f.refresh([99, 100, 102]);
    const removed = await f.capture("strike-removed");
    expect(removed.launch).toBeNull();
    await f.refresh([99, 100, 101, 102]);
    const recovered = await f.capture("strike-recovered");
    expect(recovered.launch.marketReference.contractSymbol).toBe(picked.launch.marketReference.contractSymbol);
});
test("preserves call identity across partial chains, and permits an explicit put selection", async () => {
    const f = await fixture([100]);
    await act(async () => {
        await setup!.mockMouse.click(8, strikeRowY(100));
    });
    await settle();
    const picked = await f.capture("call-selected");
    expect(picked.launch.side).toBe("call");
    f.setCalls(false);
    await f.refresh([100]);
    const removed = await f.capture("call-removed");
    expect(removed.launch).toBeNull();
    expect(await f.scenario()).toBeNull();
    expect(removed.frame).toContain("Selected 100 call unavailable");
    await act(async () => {
        await setup!.mockMouse.click(69, strikeRowY(100));
    });
    await settle();
    const put = await f.capture("put-selected");
    expect(put.launch.side).toBe("put");
    const scenario = await f.scenario();
    expect(scenario.symbol).toBe("AAPL:NASDAQ");
    expect(JSON.parse(scenario.values.seedLeg)).toMatchObject({ side: "put", strike: 100, expiration: EXPIRY,
        quantity: 1, price: 10, volatility: expect.closeTo(0.2774, 4), multiplier: 100 });
    expect(scenario.values.asOf).toBe(new Date(NOW).toISOString());
    f.setCalls(true);
    await f.refresh([100]);
    expect((await f.capture("put-after-recovery")).launch.side).toBe("put");
});
test("keyboard choice and transient failure retain the same contract through recovery", async () => {
    const f = await fixture([100, 101, 102]);
    await f.key("enter");
    await f.key("down");
    const picked = await f.capture("keyboard-selected");
    expect(picked.launch.strike).toBe(101);
    f.setFailure(true);
    await f.refresh([99, 100, 101, 102]);
    const failed = await f.capture("refresh-failed");
    expect(failed.launch.marketReference.contractSymbol).toBe(picked.launch.marketReference.contractSymbol);
    // The full warning survives even when footer actions leave room for only a shortened preview.
    expect(failed.footerParts.some(part => part.tone === "warning" && part.text.includes("Controlled chain outage"))).toBe(true);
    f.setFailure(false);
    await f.refresh([99, 100, 101, 102]);
    const recovered = await f.capture("refresh-recovered");
    expect(recovered.launch.marketReference.contractSymbol).toBe(picked.launch.marketReference.contractSymbol);
});
test("keeps distinct fractional strike identity in table, CSV, seed and existing CLI", async () => {
    const f = await fixture([100.125, 100.126]);
    const result = await f.capture("fractional");
    expect(result.launch.strike).toBe(100.125);
    expect(result.csv).toContain("100.125");
    expect(result.csv).toContain("100.126");
    expect(result.frame).toContain("100.125");
    const cli = await f.cli("fractional");
    expect(cli.rows.map((row: any) => row.strike)).toEqual([100.125, 100.126, 100.125, 100.126]);
    expect(cli.text).toContain("100.126");
});
test("preserves missing activity through source, summaries, CSV and CLI", async () => {
    const f = await fixture([100], "missing");
    const result = await f.capture("missing-activity");
    const cli = await f.cli("missing-activity");
    expect(cli.data.calls[0].openInterest).toBeUndefined();
    expect(cli.data.puts[0].volume).toBeUndefined();
    expect(result.frame).toMatch(/Volume\s+\S+/);
    expect(result.frame).toMatch(/P\/C vol\s+--/);
    expect(result.frame).toMatch(/P\/C OI\s+--/);
    expect(result.csv).toContain(",—,");
    expect(cli.rows[0].volume).toBe(10);
    expect(cli.rows[1].openInterest).toBe(20);
    expect(cli.text).not.toContain("NaN");
});
test("preserves known zero activity and zero put/call ratios", async () => {
    const f = await fixture([100], "zero");
    const result = await f.capture("zero-activity");
    const cli = await f.cli("zero-activity");
    expect(cli.data.puts[0]).toMatchObject({ volume: 0, openInterest: 0 });
    expect(result.frame).toMatch(/Volume\s+10\s/);
    expect(result.frame).toMatch(/P\/C vol\s+0\.00/);
    expect(result.frame).toMatch(/P\/C OI\s+0\.00/);
    expect(result.csv).toContain(",0,");
    expect(cli.rows[1].volume).toBe(0);
});
test("a different source contract at the same strike cannot replace the selected quote reference", async () => {
    const f = await fixture([100]);
    await act(async () => {
        await setup!.mockMouse.click(8, strikeRowY(100));
    });
    await settle();
    const selected = await f.capture("symbol-selected");
    expect(selected.launch.marketReference.contractSymbol).toBe("AAPL280121C00100000");
    f.replaceSymbols();
    await f.refresh([100]);
    const replaced = await f.capture("symbol-replaced");
    expect(replaced.launch).toBeNull();
    expect(replaced.frame).not.toContain("AAPL1280121C00100000");
    expect(replaced.frame).toContain("Selected 100 call unavailable");
});
