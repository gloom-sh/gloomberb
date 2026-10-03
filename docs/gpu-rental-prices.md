# GPU rental prices

`GPU` opens GPU Rental Prices. `GPU H100` or `GPU B200` selects a GPU model. Board shows published rental rates, History charts Gloom's stored observations, Changes records price and list-median membership changes, and Equities shows related shares. The proof of concept is free. The standard pane refresh reads the latest stored data; the footer shows its observation time, stale status and current failures.

## Price basis

| Basis | Meaning |
|---|---|
| List price | A provider's published on-demand rental rate. Rate cards can remain unchanged for months. |
| Provider-declared spot | A provider's published interruptible rate or spot meter. AWS's regional feed is a single-provider clearing proxy. |
| Ask | A posted marketplace offer. It does not establish a completed rental; availability and offer counts reflect the returned offers. |
| Reserved | A published rate requiring a commitment, kept separate from on-demand rates. |

Narrow panes abbreviate List price to List, Provider-declared spot to Spot, and Reserved to Rsvd.

The `Index (licensed)` row is locked. No Silicon Data or Ornn values are collected or displayed.

## Normalization

All prices are USD per GPU-hour. A node's hourly price is divided by its stated GPU count, so an eight-GPU node contributes one eighth of its node rate. Bundled CPU, memory and interconnect remain part of that rate. SXM and PCIe remain separate, as do memory variants such as A100 40GB and 80GB; AWS p4d uses 40GB GPUs. OCI H100 SXM is normalized to 80GB and OCI H200 SXM to 141GB, matching the same hardware variants from other clouds.

Each provider contributes one price per GPU variant and basis. Flagship eight-GPU SXM nodes take precedence where available. List comparisons use the lowest-priced US region captured for that provider: AWS samples Northern Virginia, Ohio, Northern California and Oregon; Azure uses the US regions returned by its paged API. Azure H100 comparisons prefer the RDMA-enabled ND96isr_H100_v5 over the non-RDMA ND96is_H100_v5 so the flagship SXM comparison retains its interconnect class. GCP uses the pricing page's Iowa (`us-central1`) selection. CoreWeave uses its North America rate card. Global or unregionalized pages retain their published scope. This is limited regional coverage, with differences in hardware, service terms and availability.

AWS spot uses the median across reporting regions for an instance, retaining the region count, minimum and maximum. Instances with the same GPU variant are reduced to one provider observation. Aggregated cloud offers use the underlying cloud where it is identified. Availability is shown only when supplied.

Hyperscaler and neocloud list medians are separate, with provider count, minimum, maximum and constituents retained. Membership changes are chained using continuing providers and recorded in Changes to avoid a jump caused only by adding or removing a provider. The chained value can differ from the current raw median, which is also retained. Marketplace ask quantiles are separate from list medians.

GCP's **Price (USD)** header supplies list prices and **Current Spot pricing** supplies spot prices; DWS and commitment columns are excluded. Missing list cells remain unavailable. Nebius uses the column whose published effective date has arrived, evaluated in UTC. Together uses its GPU Clusters table.

## Collection and history

| Sources | Normal collection cadence |
|---|---|
| Azure retail API, AWS Linux on-demand maps, OCI price list, GCP accelerator pricing page | Every 24 hours |
| Lambda, CoreWeave, Nebius, DigitalOcean, Together and Crusoe rate cards | Every six hours |
| AWS regional spot feed, Vast offers, RunPod secure/community offers, Akash GPU asks and Shadeform cloud offers | Hourly |

Each source can be disabled separately. A failed request or parse keeps the last good observations and reports the failure. Observations become stale after 48 hours without a successful collection. Refreshing the pane does not trigger another collection.

History begins with Gloom's own observations. The store retains at most one observation per source and SKU per hour, with a daily observation even when a rate is unchanged. The 1D, 7D and 30D changes remain `-` until an earlier observation exists at or before the target time and within two hours of it. Missing collections can therefore leave changes unavailable. A published effective date is distinct from the time Gloom observed a price; the optional Azure backfill cannot reconstruct intervening daily rates or past cheapest-region selections.

## Related equities

Equities places the selected GPU's seven-day rental-price change beside related shares. Last and 1D use the latest available quote. The equity 5D change uses six available daily close values, measuring five close-to-close intervals; it remains unavailable when that history is missing. Quote timing and the daily-history endpoint can differ. The comparison does not establish correlation or causation. Open a ticker for further research, or use `t` to open The Buildout (`TBO`).
