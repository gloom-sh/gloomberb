# Terminal screen review captures

Review evidence for the EQS ticker check and terminal ticker/session fixes. The code changes live on separate feature branches; this branch contains only review artifacts.

Terminal PNGs are rendered from actual tmux ANSI captures. The EQS scenarios use invented responses, including a screen where NVDA passes currency and market cap but fails a P/E ceiling. The screenshot-command before image is the actual generated pane; its after image shows the terminal refusal. Header captures use a fixed clock and an invented quote.

The all-pane visual benchmarks run offline against one recorded replay at 640 and 1280 pixels, including bundled and registry plugins and shell views. A pane without a recorded response shows its offline state. These captures do not establish live data correctness for every pane.

The visual baseline comes from main revisions `d4a5d16932d587836a51635c78bac581137b6264` (shards 0–1) and `d1ddd7b26993e5385fb4aada0a112f5147e115b5` (shards 2–3). SHA256 manifests confirmed every one of the 223 generated web files is identical between all four baselines. Per-shard provenance is retained in the reports. Initial before/after reproductions used main revision `ccb1b36d45e1942d7ee73c135b6405d763baf838`.
