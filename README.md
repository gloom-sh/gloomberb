# GLO-1163 focused pane evidence

Source head `245815174ae508140bf3c2e0c9703e95e1b2968b`; frozen baseline `0568f95db049dccad254c672c2c8d284bbe6a586`. Each sheet puts baseline above head, target Trending pane on the left and unchanged neighboring Gainers list-failure pane on the right. Both are the actual registered MarketMoversPane, shared table and pane footer, inside controlled host fixtures, not the full desktop app shell or native RPC bridge.

Three cases: initial quote failure, partial missing SECOND quote, and total failure after a healthy load (real refresh shortcut). White and paper themes; desktop 720/1280 px; terminal 160 by 28 in owned tmux sessions. All 18 neighboring-pane regions have zero changed pixels. Labels are outside the raw screenshots. No external requests or runtime warnings. Twelve tmux sessions and owned profiles were cleaned up. This supplements the all-pane UI benchmark.
