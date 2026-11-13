import type { PaneHint } from "../../../components";
import type { AuctionView } from "./after";
import type { AuctionMarket } from "./hk";

/**
 * The keys a market's table answers besides search and filter: `v` turns the
 * US table between Results and After, `m` between the US and Hong Kong, and
 * `[`/`]` step the sort column (the footer shows `[]`, the next one).
 */
export function auctionViewHints(options: {
  view?: AuctionView;
  toggleView?: () => void;
  market: AuctionMarket;
  toggleMarket: () => void;
  cycleSort: (step: 1 | -1) => void;
}): PaneHint[] {
  const { view, toggleView, market, toggleMarket, cycleSort } = options;
  return [
    ...(view && toggleView ? [view === "after"
      ? { id: "view", key: "v", label: " results", title: "Show Results", onPress: toggleView }
      : { id: "view", key: "v", label: " after", title: "Show After", onPress: toggleView }] : []),
    market === "hk"
      ? { id: "market", key: "m", label: " US", title: "US Treasury Auctions", onPress: toggleMarket }
      : { id: "market", key: "m", label: " HK", title: "Hong Kong Tenders", onPress: toggleMarket },
    { id: "sort", key: "[]", label: "sort", title: "Next Sort Column", onPress: () => cycleSort(1) },
  ];
}
