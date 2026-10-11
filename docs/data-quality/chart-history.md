# Chart history, retention and cadence

Chart navigation can request a wider history window than the visible range. That buffer supplies earlier observations for panning and study calculations. A provider's advertised maximum range does not guarantee that every upstream source retains that range at every interval.

When the backend feed explicitly identifies an intraday retention limit, the app first preserves successful original requests from other sources and usable caches. After those paths are exhausted, it can request the backend feed's retained window once, with a bar-sized margin inside the moving boundary. Recovery retains the full returned lookback. It does not shrink an older visible window into a recent one, replay unrelated failed providers, or cache the shorter response as the original broad request.

A failed recovery ends that acquisition. If the visible window cannot fit inside the retained history, Auto may try one supported calendar interval compatible with the series' authored period. At an interval chosen by hand, a preset range charts the retained window instead, with the axis opening at the first retained bar. A window panned or zoomed to that still reaches the retained bars charts them too and keeps its own start. Either way the footer warning gives the first retained day in the venue's calendar and how many days the source keeps. A panned or zoomed window wholly before the retained bars, and authored dates that start before them, stay unavailable at that interval. Manual intervals do not use an unspecified provider default. Temporary retention outcomes expire so later resolves can retry without repeating the acquisition on every quote update.

The served interval follows each acquired history through charts, studies and local snapshots. A known daily fallback remains daily. Mixed intervals have no single chart-wide interval. An ordinary provider default that does not declare its interval remains usable as raw observations, with unknown cadence; timestamp spacing alone cannot establish the source interval. Unknown cadence cannot establish daily annualized realized volatility or a bucket for merging a live quote.

Moving-average periods count observations. Weekends, holidays, market sessions and missing prices mean that a nominal number of elapsed minutes cannot guarantee the required number of observations. A study uses the retained lookback; insufficient inputs remain gaps. Successful recovery does not certify complete historical coverage.

Local snapshots retain incompatible acquisitions for the same instrument separately, including the request identity when an interval is unknown. Replay uses the captured observations and their cadence. Existing snapshots without cadence metadata retain their legacy behavior.

## Regular-session history freshness

A completed regular-session equity history can remain useful overnight, over weekends and holidays, and before the next opening bar is due. Its freshness differs from a live or extended-hours quote. Eligible sources declare the actual listing, interval, opening-time alignment and original acquisition time with the history. That declaration survives caches and snapshots; reading a cache does not renew the source acquisition time. A partial final bar cannot become a completed close merely by remaining in a cache overnight. After the closing delivery grace, opening-time bars require an acquisition after the close plus the 15-minute feed allowance. A separately verified native closing observation can establish the closing mark.

This behavior currently applies only to positively identified US equity/ETF history with supported published sessions: NYSE-family calendars for 2025–2028 and Nasdaq closing times for 2026. Early closes and daylight-saving changes use exchange-local schedules. There is no live exceptional-closure feed. Unknown calendars, continuous markets, unverified broker contracts and history without a session declaration retain the existing freshness behavior. Conflicting listing or interval declarations invalidate that acquisition instead of becoming anonymous data.

Within an active session, the normal cadence and delivery allowance applies. Previous-session history expires when the first complete opening bar plus its delivery allowance is due. Live quote freshness is evaluated independently. These checks establish timeliness within the declared contract; they do not certify that every expected historical observation is present.

Without a session declaration, a saved intraday copy is current when it holds the venue's latest session, read from the venue's session tables the same way on weeknights, in the US pre-market, over weekends and on published holidays. Between sessions that means the whole of the last session: bars from its open that reach its close, less the bar size and the feed allowance, or a copy fetched once the session had settled 30 minutes after the close, since a thinly traded listing need not trade late. While a session trades, the bars must reach the present, and the previous session's copy answers only until the first delayed bar of the new one is due. A currency pair is read on the FX week, Sunday 17:00 to Friday 17:00 New York, not as a US listing. A venue without known hours (OTC Markets, Cboe Canada, Cboe Australia) has no session to hold, so its copy is current while its newest bar is under 18 hours old. Crypto keeps its round-the-clock rule.

A copy that is not current is fetched again. When that fetch fails, the app is offline or the source answers bars that are still behind, the saved copy is shown rather than an empty chart; a copy saved before its session ended is asked for again at most every five minutes. The same holds for a copy with a session declaration: the chart draws it rather than an error, asks for it again at most every 30 seconds, and its footer warning says newer bars are unavailable and gives the time of the last saved bar on the venue's clock. Crypto is the exception: an old copy of a market that never closes is not shown.

## One-day charts

The 1D range shows the latest trading session of the chart's first listing, from its first bar to its newest, so a closed market, a weekend or a holiday shows the last session. Panning left still reaches the sessions before it.

| Listing | 1D shows |
|---|---|
| Stocks and funds on a venue with known hours | The regular session holding the newest bar, from the venue's published open. US venues follow the published calendar, early closes included. |
| US listings with Extended hours on | The same day from 04:00 New York, through the pre-market, the regular session and the after-hours until 20:00 |
| CME Group futures (CME, CBOT, NYMEX, COMEX) and Cboe futures | The Globex trading day, which opens at 17:00 Central the evening before (Sunday for Monday), the same open VWAP restarts at |
| ICE U.S. futures | Each contract's published New York open |
| Crypto, spot FX, futures on other venues and venues without known hours | A rolling 24 hours ending at the newest bar |

The dotted reference line is the previous session's close: the quote's previous close when the quote is from the session shown, as the legend's change is, otherwise the last regular-session bar before the session opened. It joins the price axis when it lies within one session range of the bars; after a larger gap it is off the chart and the bars keep their height.

Intraday times on the axis and under the crosshair read in the venue's own clock, named as the tape names New York time: ET for New York, CT for Chicago (CME Group futures), JST for Tokyo, CET for most of continental Europe, UK for London, and the city where no short name holds all year. Crypto, FX and daily or longer bars read in UTC; daily bars carry the session date. Point details keep the exact UTC timestamp.

### Extended hours

Extended hours appears in the query bar of an intraday chart of a US listing; other venues have no pre-market or after-hours bars to show, so it is hidden there. When on, history includes the bars from 04:00 to 20:00 New York, live quotes in the pre-market and after-hours form bars at their extended-hours price, and the tinted band marks the bars outside the regular session. When the extended-hours bars cannot be loaded, the chart shows the regular session and the footer says so.
