# GPU rental prices

`GPU` opens GPU Rental Prices. `GPU H100` or `GPU B200` selects a GPU model. Board shows published rental rates, History charts dated observations, Changes records price, availability and list-index membership changes, and Equities shows related shares. Full data and history require Pro; free accounts receive a preview. The standard pane refresh reads the latest stored data; the footer shows its observation time, stale status and current failures.

## Reading the board

With one GPU model selected, the band above the board places every basis on one dollar axis: the thin line spans the lowest to the highest quote, the thick band holds the middle half, the white tick marks the median, and a ring marks the selected row's price. The count beside each basis is the number of quotes; provider-class indexes are left out of the band because their constituents already appear in it. Choosing All GPUs hides the band.

Rows are grouped by GPU model and basis, with the provider-class list indexes and the marketplace offer medians leading each section in bold, followed by their sample size. Form factor and memory appear as chips, and availability as a dot: green when offers are reported available, amber when a pooled supply is low, grey when the provider reports none. Range shows the interquartile range for marketplace medians and the lowest to highest constituent for list indexes. See [List indexes](#list-indexes) for what the provider-class rows are.

When a series has no observation within the comparison window, its change column reads `-`, even when older historical observations exist. Once any 1D, 7D or 30D figure exists, those columns appear, and the indexes and medians of the selected model gain a one-month sparkline. Only those few rows fetch history for the board.

History lists the selected model\'s series, with a separate Reference group for anonymised third-party indices. The chart draws the chosen series as a step line together with list indexes and available reference indices, starting at the first plotted observation with a small amount of trailing space. Markers identify actual observations in the selected series; amber Archived markers identify reconstructed rate cards. No synthetic daily observations are inserted; a series with fewer than three observations shows that history is still being collected. The table under the chart groups consecutive equal prices within the same record type and ends at the last observation, so hourly snapshots of an unchanged rate read as one row. Archived, Published and Observed records remain distinguishable.

Changes groups price and availability moves by their evidence date, newest first, with the old and new price and the move coloured by its sign. Equities groups related shares into chip makers, hyperscalers, neoclouds, and hosts and builders, with each share's GPU price series, its seven-day move and a one-month price sparkline.

## Price basis

| Basis | Meaning |
|---|---|
| List price | A provider's published on-demand rental rate. Rate cards can remain unchanged for months. |
| Provider-declared spot | A provider's published interruptible rate or spot meter. AWS's regional feed is a single-provider clearing proxy. |
| Ask | A posted marketplace offer. It does not establish a completed rental; availability and offer counts reflect the returned offers. |
| Reserved | A published rate requiring a commitment, kept separate from on-demand rates. |
| Reference | Anonymised third-party reference index, not a provider offer or a Gloom list index or median. |

Narrow panes abbreviate List price to List, Provider-declared spot to Spot, and Reserved to Rsvd.

Reference index (third party), anonymised: published values are stored unchanged in USD per GPU-hour and shown with distinct, muted chart colours. They do not enter Gloom\'s list indexes or medians. Reference A supplies a rolling three-month daily window across five public GPU types; Reference B supplies seven-day anonymous chart cards across seven GPU series. Collection is disabled by default; older data requiring login is not accessed. Source hosts and fetch timestamps stay private on the server, with no vendor links in panes, exports or headless output. Full stored reference history requires Pro; free access previews latest values only.

## Normalization

All prices are USD per GPU-hour. A node's hourly price is divided by its stated GPU count, so an eight-GPU node contributes one eighth of its node rate. Bundled CPU, memory and interconnect remain part of that rate. SXM and PCIe remain separate, as do memory variants such as A100 40GB and 80GB; AWS p4d uses 40GB GPUs. OCI H100 SXM is normalized to 80GB and OCI H200 SXM to 141GB, matching the same hardware variants from other clouds. Missing, unambiguous metadata uses A10 PCIe 24GB, L40/L40S PCIe 48GB, MI300X OAM 192GB and B200 SXM defaults; H100 NVL remains PCIe 94GB. Explicit reported memory differences remain separate.

Each provider contributes one price per GPU variant and basis. Flagship eight-GPU SXM nodes take precedence where available. List comparisons use the lowest-priced US region captured for that provider: AWS samples Northern Virginia, Ohio, Northern California and Oregon; Azure uses the US regions returned by its paged API. Azure H100 comparisons prefer the RDMA-enabled ND96isr_H100_v5 over the non-RDMA ND96is_H100_v5 so the flagship SXM comparison retains its interconnect class. GCP uses the pricing page's Iowa (`us-central1`) selection. CoreWeave uses its North America rate card. Global or unregionalized pages retain their published scope. This is limited regional coverage, with differences in hardware, service terms and availability.

AWS spot uses the median across reporting regions for an instance, retaining the region count, minimum and maximum. Instances with the same GPU variant are reduced to one provider observation. Aggregated cloud offers use the underlying cloud where it is identified. Availability is shown only when supplied.

Hyperscaler and neocloud list indexes are separate, with provider count, minimum, maximum and constituents retained. Marketplace ask quantiles are separate from the list indexes.

### List indexes

The Hyperscaler and Neocloud rows on the Board are list indexes, not plain medians. Each is the median of those providers' list prices for one GPU variant, linked over time with a continuity factor. When a provider joins or leaves, the factor is set from the providers that stay, so the index does not jump, and the change is recorded in Changes. The raw median of today's providers is kept in the row's stats (`rawMedian`, with `chainFactor`) and can differ slightly from the index, and from any single provider's price. Marketplace rows are plain medians of the offers returned.

GCP's **Price (USD)** header supplies list prices and **Current Spot pricing** supplies spot prices; DWS and commitment columns are excluded. Missing list cells remain unavailable. Nebius uses the column whose published effective date has arrived, evaluated in UTC. Together uses its GPU Clusters table.

## Collection and history

| Sources | Normal collection cadence |
|---|---|
| Azure retail API, AWS Linux on-demand maps, OCI price list, GCP accelerator pricing page | Every 24 hours |
| Lambda, CoreWeave, Nebius, DigitalOcean, Together and Crusoe rate cards | Every six hours |
| Public reference indices, when enabled | Daily |
| AWS regional spot feed, Vast offers, RunPod secure/community offers, Akash GPU asks and Shadeform cloud offers | Hourly |

Each source can be disabled separately. A failed request or parse keeps the last good observations and reports the failure. Observations become stale after 48 hours without a successful collection. Refreshing the pane does not trigger another collection.

History combines stored observations, dated archived rate cards and official historical price versions. Archived records use the snapshot timestamp and are labelled `archived page, reconstructed` in exports. Official versions use their published date. Each imported record retains its original URL and evidence URL; an effective-date label alone never becomes a historical observation. The store retains at most one observation per source and SKU per hour, with a daily observation even when a rate is unchanged. The 1D, 7D and 30D changes remain `-` until an earlier observation exists at or before the target time and within two hours of it. Missing collections can therefore leave changes unavailable. A published effective date is distinct from the time Gloom observed a price; the optional Azure backfill cannot reconstruct intervening daily rates or past cheapest-region selections.

## Related equities

Equities places the selected GPU's seven-day rental-price change beside related shares. Last and 1D use the latest available quote. The equity 5D change uses six available daily close values, measuring five close-to-close intervals; it remains unavailable when that history is missing. Quote timing and the daily-history endpoint can differ. The comparison does not establish correlation or causation. Open a ticker for further research, or use `t` to open The Buildout (`TBO`).
