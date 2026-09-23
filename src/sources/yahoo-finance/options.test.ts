import { expect, test } from "bun:test";
import { loadYahooOptionsChain } from "./options";
test("Yahoo activity preserves numeric zero and does not coerce invalid counts", async () => {
    const values = [undefined, null, "0", -1, Number.NaN, Infinity, 0, 12];
    const input = values.map((value, index) => ({ contractSymbol: `OPTION${index}`, strike: index + 1, volume: value, openInterest: value }));
    const chain = await loadYahooOptionsChain({ ticker: "AAPL", exchange: "NASDAQ", fetchJsonWithCrumb: async () => ({ optionChain: { result: [{ expirationDates: [1], options: [{ calls: input, puts: [] }] }] } }) as any });
    // Yahoo omits volume for untraded contracts; missing open interest stays unknown.
    expect(chain.calls.map(contract => contract.volume)).toEqual([0, undefined, undefined, undefined, undefined, undefined, 0, 12]);
    expect(chain.calls.map(contract => contract.openInterest)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, 0, 12]);
    expect(JSON.parse(JSON.stringify(chain)).calls[0]).not.toHaveProperty("openInterest");
});
test("Yahoo IV solved from an empty quote or clamped at its floor is unknown", async () => {
    // After the close Yahoo zeroes bid/ask and still returns bisection output.
    const input = [
        { bid: 0, ask: 0, impliedVolatility: 0.125 },
        { bid: 0, ask: 0, impliedVolatility: 0.0039162109375 },
        { bid: 353.35, ask: 356.12, impliedVolatility: 0.000010000000000000003 },
        { bid: 0, ask: 0.05, impliedVolatility: 0.92 },
        { bid: 1.67, ask: 1.74, impliedVolatility: 0.18 },
    ].map((contract, index) => ({ ...contract, contractSymbol: `OPTION${index}`, strike: index + 1 }));
    const chain = await loadYahooOptionsChain({ ticker: "SPY", exchange: "NYSEARCA", fetchJsonWithCrumb: async () => ({ optionChain: { result: [{ expirationDates: [1], options: [{ calls: input, puts: [] }] }] } }) as any });
    expect(chain.calls.map(contract => contract.impliedVolatility)).toEqual([0, 0, 0, 0.92, 0.18]);
});
