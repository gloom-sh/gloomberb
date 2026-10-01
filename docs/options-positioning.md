# Options positioning (OPX)

[Research data conventions](research-data.md) · [User guide](usage.md)

`OPX <ticker>` shows where open interest sits on a US option underlying: by strike for one expiry with max pain and spot marked (Strikes), every expiry's open interest, put/call ratio and max pain (Expiries), and the gamma dealers carry against it (GEX). `GEX` opens it on the GEX tab and `MAXPAIN` on Strikes. With no active ticker it opens on SPY. `SPX` (or `^SPX`) is the S&P 500 index with its SPX and SPXW options; `XSP` and `VIX` work the same way. NDX and RUT index options are not covered; QQQ and IWM follow the same indexes.

## Open interest timing

OCC counts open positions after each session's close and publishes them overnight, so during a session OPX shows the previous session's counts. The footer names the session (`OI as of Sep 30`). A contract with no reported count is left out rather than read as zero.

Change columns compare with the previous session OPX stored. One snapshot is stored per session from 2026-10-01 for these underlyings: SPY, SPX (with SPXW), QQQ, IWM, XSP, VIX, and the 50 others that traded the most options contracts over the five sessions to 2026-09-30 (OCC volume, all exchanges): NVDA, TSLA, TLT, AAPL, META, HYG, INTC, MSFT, AMZN, MU, SPCX, AMD, EWZ, GOOGL, IBIT, ORCL, MSTR, SLV, GLD, SOFI, GME, AVGO, SOXL, PLTR, TQQQ, XLU, XLF, CRWV, NFLX, USO, HOOD, SMCI, IREN, LQD, SMH, DRAM, GOOG, BE, ETHA, MARA, NBIS, IEF, NU, SNDK, XLE, PCG, GDX, NKE, KRE, AMC. Other underlyings show their counts without the change columns. The footer names the session changes are measured from (`chg since Sep 29`); it is the one before unless a session was missed. A strike or expiry listed since counts from zero.

On a date where two roots expire together (SPX and SPXW on a third Friday) their counts are added. SPX settles on the opening print of that day and SPXW on the close.

## Max pain

For each listed strike of an expiry taken as the settlement price P, every call pays its holders max(P minus strike, 0) and every put max(strike minus P, 0), times its open interest and the 100-share multiplier. Max pain is the strike where that total is lowest; on a tie, the lowest such strike. The Strikes table's Payout column is that total at each strike, so the curve max pain sits at the bottom of is in the table. Distances (`vs spot`) are from the current spot; for VIX that is the index, while its options settle on the VIX futures of their month.

Strikes opens on the nearest expiry for underlyings listing expiries on most days (four or more in the next week, as SPY, SPX, QQQ and IWM do), otherwise on the expiry with the most open interest in the next five weeks, which is the standard monthly in practice. `[` and `]` step through expiries; Enter on an expiry opens its strikes.

The Strikes and GEX charts show the strikes around spot: out to one and a half times the distance from spot inside which half the open interest (or gamma) sits, at least 3% and at most 25% either side, widened to keep max pain or the flip in view. Large protective put positions far below spot would otherwise set the axis. The table lists every strike.

## Dealer gamma (GEX)

The dealer assumption: customers sell calls and buy puts, and dealers take the other side of every contract, so dealers are long every call and short every put. Net dealer gamma is the gamma of the calls minus the gamma of the puts. Positive means dealers hedge against the move (selling into rallies, buying dips); negative means they hedge with it.

- Gamma per contract is Black-Scholes gamma with the forward at spot (no rate or dividend carry), times the 100-share multiplier. Time runs to 16:00 New York on the expiry date, at least one hour.
- Each strike's volatility comes from its expiry's out-of-the-money quotes (puts below spot, calls above, the other side where one has none), linear between quoted strikes and flat beyond the outermost. A quote without an implied volatility gets one solved from its midpoint against the put-call parity forward and the Treasury curve. Readings below 1% or above 500% are ignored. An expiry whose quotes give no volatility is left out and named in the footer.
- Units are dollars of dealer delta per 1% move in the underlying: gamma times 100 times spot times 1% of spot, times open interest. GEX sums every expiry by default, or one chosen in the bar.
- Dealer range: what net gamma would be if dealers held only part of the open interest, the rest sitting between customers. The share is set anywhere from 25% to 75% of the calls and, separately, of the puts. The low end is 25% of call gamma minus 75% of put gamma, the high end 75% minus 25%. The same share on both sides only scales the figure; different shares show whether its sign holds. The headline figure uses all of the open interest, as the published GEX figures do, so it can sit outside the range.
- Box spreads (SPX and XSP): a box is a long call and short put at one strike against a short call and long put at another, the same size, on one expiry. It is a loan priced off the strike difference and carries no gamma for whoever holds it, but its calls and puts would otherwise count on both sides. A strike is read as a box leg when its call and put open interest agree within 10% (at least 1,000 contracts each), it sits on the round strike grid (500 on SPX, 50 on XSP) at least 3% from spot, and the same expiry has another such strike of about the same size (within 25%), the box's other end. The smaller of its call and put open interest is taken out of both sides before any GEX figure. Net gamma and the flip do not change, since a call and a put at one strike have the same gamma; the call and put totals and the dealer range shrink, and the range figure says `boxes out`. The CSV export keeps the range with the boxes counted and lists the legs. On 2026-10-01 this took 1.56 million contracts a side out of SPX across 21 strikes (7000 and 8000 on most monthlies, 4000 to 8000 on the December LEAPS) and moved the range from -122.7B to +105.0B per 1% to -107.9B to +90.2B, with net gamma (-17.7B) and the flip (7,674) where they were. The range stays wide without boxes because SPX's call and put gamma (+189B and -207B) are each about ten times its net: on SPX the sign of net dealer gamma depends on who holds which side.
- Flip: net gamma repriced at spot levels from 15% below to 15% above in 0.25% steps, each strike keeping its volatility, and the sign change nearest the current spot, interpolated between steps. None when the sign does not change in that range.

VIX options settle on VIX futures, so OPX has no GEX tab for them.

Against vendors that read the chain's own greeks, gamma without carry runs a few percent higher on monthly expiries (SPY 2026-10-16 on 2026-10-01: 8% above the quoted greeks across the contracts that had them).

## Freshness

Open interest is the previous session's on every plan. Spot and the quotes behind gamma are 15 minutes delayed on Free and signed out, and real-time on Pro, as in OMON. While the pane is on screen GEX reprices at the current spot every minute; the volatilities behind it are reread every five minutes while options trade (every fifteen otherwise), once for every reader of that underlying. Open interest and spot in the other tabs reread every five minutes.
