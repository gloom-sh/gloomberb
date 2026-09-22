# Chart history, retention and cadence

Chart navigation can request a wider history window than the visible range. That buffer supplies earlier observations for panning and study calculations. A provider's advertised maximum range does not guarantee that every upstream source retains that range at every interval.

When Yahoo explicitly identifies an intraday retention limit, the app first preserves successful original requests from other sources and usable caches. After those paths are exhausted, it can request Yahoo's retained window once, with a bar-sized margin inside the moving boundary. Recovery retains the full returned lookback. It does not shrink an older visible window into a recent one, replay unrelated failed providers, or cache the shorter response as the original broad request.

A failed recovery ends that acquisition. If the visible window cannot fit inside the retained history, Auto may try one supported calendar interval compatible with the series' authored period. Manual intervals do not use an unspecified provider default. Temporary retention outcomes expire so later resolves can retry without repeating the acquisition on every quote update.

The served interval follows each acquired history through charts, studies and local snapshots. A known daily fallback remains daily. Mixed intervals have no single chart-wide interval. An ordinary provider default that does not declare its interval remains usable as raw observations, with unknown cadence; timestamp spacing alone cannot establish the source interval. Unknown cadence cannot establish daily annualized realized volatility or a bucket for merging a live quote.

Moving-average periods count observations. Weekends, holidays, market sessions and missing prices mean that a nominal number of elapsed minutes cannot guarantee the required number of observations. A study uses the retained lookback; insufficient inputs remain gaps. Successful recovery does not certify complete historical coverage.

Local snapshots retain incompatible acquisitions for the same instrument separately, including the request identity when an interval is unknown. Replay uses the captured observations and their cadence. Existing snapshots without cadence metadata retain their legacy behavior.
