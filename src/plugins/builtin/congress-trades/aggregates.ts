import type { CloudCongressMemberPayload, CloudCongressTickerPayload, CloudCongressTradePayload } from "../../../api-client";

/** Aggregates exactly the distinct trades loaded, including appended years. */
export function aggregateLoadedCongress(trades: CloudCongressTradePayload[], metadata: CloudCongressMemberPayload[] = []) {
  const members = new Map<string, CloudCongressMemberPayload>();
  const tickers = new Map<string, CloudCongressTickerPayload>();
  const lags = new Map<string, number[]>();
  const returns = new Map<string, number[]>();
  const buys = new Map<string, number[]>();
  const known = new Map(metadata.map((member) => [member.id, member]));
  const seen = new Set<string>();
  for (const trade of trades) {
    if (seen.has(trade.id)) continue;
    seen.add(trade.id);
    const memberId = `${trade.memberName}:${trade.stateDistrict}`;
    let member = members.get(memberId);
    if (!member) {
      member = { ...known.get(memberId), id: memberId, memberName: trade.memberName, stateDistrict: trade.stateDistrict,
        tradeCount: 0, buyCount: 0, sellCount: 0, exchangeCount: 0, otherCount: 0,
        estimatedLow: 0, estimatedHigh: 0, lastFilingDate: null, avgLagDays: null };
      members.set(memberId, member);
      lags.set(memberId, []);
      returns.set(memberId, []);
      buys.set(memberId, []);
    }
    const summaries: (CloudCongressMemberPayload | CloudCongressTickerPayload)[] = [member];
    if (trade.ticker) {
      let ticker = tickers.get(trade.ticker);
      if (!ticker) {
        ticker = { ticker: trade.ticker, tradeCount: 0, buyCount: 0, sellCount: 0, exchangeCount: 0, otherCount: 0,
          memberCount: 0, memberIds: [], estimatedLow: 0, estimatedHigh: 0, lastFilingDate: null };
        tickers.set(trade.ticker, ticker);
      }
      if (!ticker.memberIds.includes(memberId)) ticker.memberIds.push(memberId);
      ticker.memberCount = ticker.memberIds.length;
      summaries.push(ticker);
    }
    if (trade.returnSinceTx != null && Number.isFinite(trade.returnSinceTx)) {
      returns.get(memberId)!.push(trade.returnSinceTx);
      if (trade.side === "BUY") buys.get(memberId)!.push(trade.returnSinceTx);
    }
    if (!member.lastFilingDate || trade.filingDate >= member.lastFilingDate) {
      member.party = trade.party ?? member.party ?? null;
      member.committees = trade.committees ?? member.committees ?? [];
    }
    if (trade.lagDays != null) lags.get(memberId)!.push(trade.lagDays);
    for (const summary of summaries) {
      summary.tradeCount++;
      if (trade.side === "BUY") summary.buyCount++;
      else if (trade.side === "SELL") summary.sellCount++;
      else if (trade.side === "EXCHANGE") summary.exchangeCount++;
      else summary.otherCount++;
      summary.estimatedLow = summary.estimatedLow == null || trade.amountLow == null ? null : summary.estimatedLow + trade.amountLow;
      summary.estimatedHigh = summary.estimatedHigh == null || trade.amountHigh == null ? null : summary.estimatedHigh + trade.amountHigh;
      if (!summary.lastFilingDate || trade.filingDate > summary.lastFilingDate) summary.lastFilingDate = trade.filingDate;
    }
  }
  for (const [id, member] of members) {
    const values = lags.get(id)!;
    const priced = returns.get(id)!.sort((a, b) => a - b);
    const pricedBuys = buys.get(id)!;
    member.pricedTradeCount = priced.length;
    member.pricedBuyCount = pricedBuys.length;
    member.medianReturn = priced.length ? (priced[Math.floor((priced.length - 1) / 2)]! + priced[Math.floor(priced.length / 2)]!) / 2 : null;
    member.buyHitRate = pricedBuys.length ? 100 * pricedBuys.filter(value => value > 0).length / pricedBuys.length : null;
    member.avgLagDays = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
  }
  return { members: [...members.values()], tickers: [...tickers.values()] };
}
