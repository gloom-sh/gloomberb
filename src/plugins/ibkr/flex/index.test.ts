import { afterEach, describe, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  parseFlexAccounts,
  parseFlexPortfolioPerformance,
  parseFlexPositions,
  requestFlexStatement,
} from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  setHttpFetchTransport(null);
  globalThis.fetch = originalFetch;
});

describe("parseFlexPositions", () => {
  test("parses option positions with broker contract metadata", () => {
    const xml = `
      <FlexQueryResponse>
        <OpenPositions>
          <OpenPosition accountId="DU12345" symbol="SPY  260619C00500000" description="SPY Jun19'26 500 Call" assetCategory="OPT" position="2" costBasisPrice="4.25" currency="USD" exchange="SMART" conid="123456" listingExchange="SMART" multiplier="100" expiry="20260619" strike="500" putCall="CALL" localSymbol="SPY  260619C00500000" tradingClass="SPY" />
        </OpenPositions>
      </FlexQueryResponse>
    `;

    const positions = parseFlexPositions(xml);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.ticker).toBe("SPY  260619C00500000");
    expect(positions[0]?.side).toBe("long");
    expect(positions[0]?.brokerContract).toEqual({
      brokerId: "ibkr",
      conId: 123456,
      symbol: "SPY  260619C00500000",
      localSymbol: "SPY  260619C00500000",
      secType: "OPT",
      exchange: "SMART",
      primaryExchange: "SMART",
      currency: "USD",
      lastTradeDateOrContractMonth: "20260619",
      right: "C",
      strike: 500,
      multiplier: "100",
      tradingClass: "SPY",
    });
  });

  test("treats a negative Flex position without a side attribute as a short", () => {
    const xml = `
      <FlexQueryResponse>
        <OpenPositions>
          <OpenPosition accountId="DU12345" symbol="TSLA" assetCategory="STK" position="-50" costBasisPrice="200" currency="USD" listingExchange="NASDAQ" />
        </OpenPositions>
      </FlexQueryResponse>
    `;

    const positions = parseFlexPositions(xml);
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      ticker: "TSLA",
      shares: 50,
      side: "short",
    });
  });
});

describe("parseFlexAccounts", () => {
  test("parses cash balances and summary values from a flex statement", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="1">
          <FlexStatement accountId="DU12345" fromDate="20260327" toDate="20260327" whenGenerated="20260328;102707">
            <ChangeInNAV accountId="DU12345" acctAlias="Main" currency="USD" endingValue="764713.626876249" />
            <CashReport>
              <CashReportCurrency accountId="DU12345" currency="BASE_SUMMARY" endingCash="-1050953.720462251" endingSettledCash="-917604.448220862" />
            </CashReport>
            <FxPositions>
              <FxPosition accountId="DU12345" assetCategory="CASH" functionalCurrency="USD" fxCurrency="USD" quantity="-303029.144938754" value="-303029.144938754" />
              <FxPosition accountId="DU12345" assetCategory="CASH" functionalCurrency="USD" fxCurrency="EUR" quantity="-351957.025" value="-405102.535775" />
            </FxPositions>
            <OpenPositions>
              <OpenPosition accountId="DU12345" symbol="AAPL" assetCategory="STK" position="100" currency="USD" positionValue="100000" fxRateToBase="1" />
              <OpenPosition accountId="DU12345" symbol="ASML" assetCategory="STK" position="10" currency="EUR" positionValue="50000" fxRateToBase="1.2" />
            </OpenPositions>
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    const accounts = parseFlexAccounts(xml);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      accountId: "DU12345",
      name: "Main",
      currency: "USD",
      source: "flex",
      asOfDate: "2026-03-27",
      netLiquidation: 764713.626876249,
      grossPositionValue: 160000,
      totalCashValue: -1050953.720462251,
      settledCash: -917604.448220862,
      cashBalances: [
        {
          currency: "USD",
          quantity: -303029.144938754,
          baseValue: -303029.144938754,
          baseCurrency: "USD",
        },
        {
          currency: "EUR",
          quantity: -351957.025,
          baseValue: -405102.535775,
          baseCurrency: "USD",
        },
      ],
    });
    expect(accounts[0]?.updatedAt).toBe(new Date(2026, 2, 28, 10, 27, 7).getTime());
  });

  test("handles missing cash sections gracefully", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="1">
          <FlexStatement accountId="DU12345" fromDate="20260327" toDate="20260327">
            <ChangeInNAV accountId="DU12345" currency="USD" endingValue="12345.67" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    expect(parseFlexAccounts(xml)).toEqual([
      {
        accountId: "DU12345",
        name: "DU12345",
        currency: "USD",
        source: "flex",
        updatedAt: new Date(2026, 2, 27).getTime(),
        asOfDate: "2026-03-27",
        netLiquidation: 12345.67,
        grossPositionValue: undefined,
        totalCashValue: undefined,
        settledCash: undefined,
        cashBalances: undefined,
      },
    ]);
  });
});

describe("parseFlexPortfolioPerformance", () => {
  test("parses historical NAV rows when a Flex query includes them", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="2">
          <FlexStatement accountId="DU12345" fromDate="20260514" toDate="20260514">
            <ChangeInNAV accountId="DU12345" currency="USD" endingValue="100000" cumulativeReturn="0" />
          </FlexStatement>
          <FlexStatement accountId="DU12345" fromDate="20260515" toDate="20260515">
            <ChangeInNAV accountId="DU12345" currency="USD" endingValue="101500" cumulativeReturn="1.5" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    expect(parseFlexPortfolioPerformance(xml, "DU12345", 123)).toEqual({
      accountId: "DU12345",
      source: "flex",
      period: "FLEX",
      currency: "USD",
      fetchedAt: 123,
      startDate: "2026-05-14",
      endDate: "2026-05-15",
      points: [
        { date: "2026-05-14", value: 100000, cumulativeReturn: 0 },
        { date: "2026-05-15", value: 101500, cumulativeReturn: 0.015 },
      ],
    });
  });

  test("matches account aliases in single-account Flex history statements", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="1">
          <FlexStatement accountId="U12345" acctAlias="alias-account" fromDate="20260514" toDate="20260515">
            <ChangeInNAV accountId="U12345" currency="USD" reportDate="20260514" endingValue="100000" cumulativeReturn="0" />
            <ChangeInNAV accountId="U12345" currency="USD" reportDate="20260515" endingValue="101000" cumulativeReturn="1.5" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    const performance = parseFlexPortfolioPerformance(xml, "alias-account", 123);

    expect(performance?.accountId).toBe("alias-account");
    expect(performance?.points).toEqual([
      { date: "2026-05-14", value: 100000, cumulativeReturn: 0 },
      { date: "2026-05-15", value: 101000, cumulativeReturn: 0.015 },
    ]);
  });

  test("does not match a different account in multi-account Flex history statements", () => {
    const xml = `
      <FlexQueryResponse>
        <FlexStatements count="2">
          <FlexStatement accountId="U12345" fromDate="20260514" toDate="20260514">
            <ChangeInNAV accountId="U12345" currency="USD" endingValue="100000" />
          </FlexStatement>
          <FlexStatement accountId="U67890" fromDate="20260514" toDate="20260514">
            <ChangeInNAV accountId="U67890" currency="USD" endingValue="200000" />
          </FlexStatement>
        </FlexStatements>
      </FlexQueryResponse>
    `;

    expect(parseFlexPortfolioPerformance(xml, "alias-account", 123)).toBeNull();
  });
});

describe("requestFlexStatement", () => {
  test("uses the configured HTTP transport for statement requests", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    setHttpFetchTransport(async (url, init) => {
      requests.push({ url, init });
      return new Response(
        "<FlexStatementResponse><ReferenceCode>987654</ReferenceCode></FlexStatementResponse>",
        { status: 200 },
      );
    });

    await expect(requestFlexStatement({
      token: "secret-flex-token",
      queryId: "12345",
      endpoint: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest",
    })).resolves.toBe("987654");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("q=12345");
    expect((requests[0]?.init?.headers as Record<string, string> | undefined)?.["User-Agent"]).toBeTruthy();
  });

  test("adds request context to vague IBKR Flex errors without exposing the token", async () => {
    globalThis.fetch = (async () => new Response(
      "<FlexStatementResponse><ErrorCode>1001</ErrorCode><ErrorMessage>Load failed</ErrorMessage></FlexStatementResponse>",
      { status: 200 },
    )) as unknown as typeof fetch;

    let message = "";
    try {
      await requestFlexStatement({
        token: "secret-flex-token",
        queryId: "12345",
        endpoint: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("IBKR Flex request failed while requesting the statement: IBKR error 1001: Load failed.");
    expect(message).toContain("Endpoint SendRequest");
    expect(message).toContain("query ID 12345");
    expect(message).toContain("token configured");
    expect(message).toContain("Flex Web Service is enabled");
    expect(message).not.toContain("secret-flex-token");
  });
});
