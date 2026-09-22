# Volatility review fixes

Live desktop captures on September 22, 2026. HVG and HVT AAPL and OMON SPY report usable=true, complete=true and semanticMismatch=false through `gloomberb shot`.

HVG uses a white price line, distinct from HV10, and retains the current IV source timestamp separately from its legend value. OMON displays the short-tenor raw IV difference with both expiry dates. Values are delayed provider observations and will change with new snapshots.
